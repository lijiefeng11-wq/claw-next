"""Fictional SQLite restore, WAL, retention, failures and lifecycle checks."""
import datetime
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch
from backend.backups import BackupManager


def database(path, value="fictional"):
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE t(value TEXT)")
    connection.execute("INSERT INTO t VALUES (?)", (value,))
    connection.commit()
    return connection


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="claw-backup-")
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.source = self.data / "claw-next.sqlite3"
        self.manager = BackupManager(self.data)
        self.addCleanup(lambda: self.manager.close())

    def files(self):
        return sorted(self.manager.directory.glob("backup-*.sqlite3"))

    def contents(self, path):
        connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
        try:
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            return connection.execute("SELECT value FROM t").fetchall()
        finally:
            connection.close()

    def test_wal_snapshot_restores_committed_state_not_later_writes(self):
        connection = database(self.source)
        self.addCleanup(connection.close)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA wal_autocheckpoint=0")
        connection.execute("INSERT INTO t VALUES ('committed')")
        connection.commit()
        connection.execute("INSERT INTO t VALUES ('uncommitted')")
        self.manager._backup_once()
        restored = self.data / "restore.sqlite3"
        shutil.copyfile(self.files()[0], restored)
        self.assertEqual(self.contents(restored), [("fictional",), ("committed",)])
        connection.rollback()
        self.assertEqual(set(self.manager.snapshot()), {"status", "last_success"})
        if os.name != "nt":
            self.assertEqual(self.manager.directory.stat().st_mode & 0o777, 0o700)
            self.assertEqual(self.files()[0].stat().st_mode & 0o777, 0o600)

    def test_restart_reuses_fresh_snapshot_but_stale_one_is_due(self):
        database(self.source).close()
        self.manager._backup_once()
        prior = self.files()
        second = BackupManager(self.data)
        self.addCleanup(second.close)
        second._backup_once()
        self.assertEqual(self.files(), prior)
        self.assertIsNotNone(second.snapshot()["last_success"])
        second.interval = 0
        second._backup_once()
        self.assertEqual(len(self.files()), 2)

    def test_corrupt_and_future_snapshots_do_not_suppress_backup(self):
        database(self.source).close()
        self.manager.directory.mkdir()
        now = datetime.datetime.now(datetime.timezone.utc)
        for date in (now - datetime.timedelta(seconds=10), now + datetime.timedelta(days=1)):
            path = self.manager.directory / date.strftime("backup-%Y%m%dT%H%M%S%fZ.sqlite3")
            path.write_bytes(b"invalid SQLite")
        self.manager._backup_once()
        self.assertEqual(len(self.files()), 3)
        snapshot = max(p for p in self.files() if p.read_bytes().startswith(b"SQLite"))
        self.assertEqual(self.contents(snapshot), [("fictional",)])

    def test_empty_sqlite_file_is_not_adopted_as_a_snapshot(self):
        database(self.source).close()
        self.manager.directory.mkdir()
        date = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=10)
        path = self.manager.directory / date.strftime("backup-%Y%m%dT%H%M%S%fZ.sqlite3")
        path.touch()
        self.manager._backup_once()
        self.assertEqual(len(self.files()), 2)
        self.assertEqual(self.contents(self.files()[-1]), [("fictional",)])

    def test_retention_only_after_success_and_preserves_other_files(self):
        database(self.source).close()
        self.manager.interval, self.manager.keep = 0, 2
        self.manager._backup_once()
        note = self.manager.directory / "unrelated.txt"
        note.write_text("keep")
        prior = self.files()
        with patch("backend.backups.sqlite3.connect", side_effect=OSError("private-error")):
            with self.assertRaises(OSError):
                self.manager._backup_once()
        self.assertEqual(self.files(), prior)
        for _ in range(3):
            self.manager._backup_once()
        self.assertEqual(len(self.files()), 2)
        self.assertEqual(note.read_text(), "keep")

    def test_retention_failure_retries_cleanup_without_new_snapshots(self):
        database(self.source).close()
        self.manager.keep = 1
        self.manager._backup_once()
        prior = self.files()[0]
        self.manager.last_success -= self.manager.interval + 1
        original_unlink = Path.unlink

        def deny_old_snapshot(path, *args, **kwargs):
            if path.name.startswith("backup-") and path.suffix == ".sqlite3":
                raise PermissionError("fictional retention failure")
            return original_unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", deny_old_snapshot):
            with self.assertRaises(PermissionError):
                self.manager._backup_once()
            published_at = self.manager.snapshot()["last_success"]
            self.assertGreater(published_at, time.time() - 5)
            published = self.files()
            self.assertEqual(len(published), 2)
            for _ in range(3):
                with self.assertRaises(PermissionError):
                    self.manager._backup_once()
                self.assertEqual(self.files(), published)
                self.assertEqual(self.manager.snapshot()["last_success"], published_at)
            # An overdue daily interval does not bypass failed cleanup either.
            with patch("backend.backups.time.time", return_value=published_at + self.manager.interval + 1):
                with self.assertRaises(PermissionError):
                    self.manager._backup_once()
            self.assertEqual(self.files(), published)
            # Recovery from disk also recognizes the successful publication.
            restarted = BackupManager(self.data, keep=1)
            self.addCleanup(restarted.close)
            with self.assertRaises(PermissionError):
                restarted._backup_once()
            self.assertEqual(self.files(), published)
        self.manager._backup_once()
        self.assertEqual(self.files(), [path for path in published if path != prior])
        self.assertEqual(self.manager.snapshot()["status"], "ok")
        self.assertEqual(self.manager.snapshot()["last_success"], published_at)

    def test_stop_interrupts_busy_database_and_removes_temporary_file(self):
        connection = database(self.source)
        self.addCleanup(connection.close)
        connection.execute("BEGIN EXCLUSIVE")
        self.manager.start()
        time.sleep(.25)
        before = time.monotonic()
        self.manager.close()
        self.assertLess(time.monotonic() - before, 2)
        self.assertFalse(self.manager.thread.is_alive())
        self.assertEqual(self.files(), [])
        self.assertEqual(list(self.manager.directory.glob(".backup-*")), [])
        connection.rollback()

    def test_source_uri_handles_percent_hash_question_and_unicode(self):
        self.data = self.data / "数据%23#?"
        if os.name == "nt":
            self.data = self.data.with_name("data%23")
        self.data.mkdir()
        source = self.data / "claw-next.sqlite3"
        database(source, "correct").close()
        self.manager = BackupManager(self.data)
        self.manager._backup_once()
        self.assertEqual(self.contents(self.files()[0]), [("correct",)])

    @unittest.skipIf(os.name == "nt", "POSIX symlink fixture")
    def test_symlinks_never_followed_for_directory_source_or_retention(self):
        real = self.data / "real"
        real.mkdir()
        self.manager.directory.symlink_to(real, target_is_directory=True)
        database(self.source).close()
        with self.assertRaises(ValueError):
            self.manager._backup_once()
        self.assertEqual(list(real.iterdir()), [])
        self.manager.directory.unlink()
        other = self.data / "other.sqlite3"
        self.source.rename(other)
        self.source.symlink_to(other)
        with self.assertRaises(ValueError):
            self.manager._backup_once()
        self.source.unlink()
        other.rename(self.source)
        link = self.manager.directory / "backup-20000101T000000000000Z.sqlite3"
        link.symlink_to(self.source)
        self.manager.keep = 1
        self.manager._backup_once()
        self.assertTrue(link.is_symlink())
        self.assertTrue(self.source.is_file())

    def test_restored_store_keeps_claimed_attempt_unknown_without_new_send(self):
        from backend.store import Store, ApiError
        from backend.engine import decide
        shops = [{"shop_id": "fake", "name": "Fictional"}]
        store = Store(self.data, shops)
        try:
            identity = {"shop_id": "fake", "client_id": "client"}
            lease = store.heartbeat(identity, {"instance_id": "instance", "session_id": "session"})
            store.update_settings("fake", {"enabled": True, "mode": "rules", "system_prompt": "",
                                          "rules": [{"id": "r", "contains": "test", "reply": "fictional"}]})
            event = {"event_id": "e", "conversation_id": "buyer", "message_id": "m", "received_at": time.time(),
                     **{key: lease[key] for key in ("instance_id", "session_id", "generation")}, "context_revision": 1,
                     "context": {"history_complete": True, "messages": [{"id": "m", "role": "buyer", "kind": "text", "content": "test", "created_at": time.time()}]}}
            store.enqueue(identity, event)
            job = store.next_job()
            store.finish(job, decide(job))
            store.claim(identity, "e", {**lease, "attempt_id": "attempt"})
            self.manager._backup_once()
        finally:
            store.close()
        with tempfile.TemporaryDirectory() as restore:
            shutil.copyfile(self.files()[0], Path(restore) / "claw-next.sqlite3")
            restored = Store(restore, shops)
            try:
                self.assertEqual(restored.events("fake")[0]["delivery"]["status"], "unknown")
                self.assertIsNone(restored.next_job())
                with self.assertRaises(ApiError):
                    restored.claim(identity, "e", {**lease, "attempt_id": "another"})
                self.assertEqual(restored.events("fake")[0]["delivery"]["status"], "unknown")
            finally:
                restored.close()

    def test_worker_error_is_generic_and_close_idempotent(self):
        self.manager.start()
        deadline = time.monotonic() + 3
        while self.manager.snapshot()["status"] == "idle" and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertEqual(self.manager.snapshot(), {"status": "error", "last_success": None})
        self.manager.close()
        self.manager.close()
        self.assertFalse(self.manager.thread.is_alive())
