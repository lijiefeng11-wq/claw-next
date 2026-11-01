"""Private daily SQLite snapshots, independent of the decision worker/Store lock."""
import datetime
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile
import threading
import time

NAME = re.compile(r"backup-(\d{8}T\d{12})Z\.sqlite3\Z")


class BackupManager:
    def __init__(self, data_dir, interval=86400, keep=7):
        self.data = Path(data_dir).absolute()
        self.source = self.data / "claw-next.sqlite3"
        self.directory = self.data / "backups"
        self.interval, self.keep = interval, keep
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.thread = None
        self.status, self.last_success = "idle", None

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self._run, name="claw-next-backup", daemon=True)
            self.thread.start()

    def close(self):
        self.stop.set()
        if self.thread is not None:
            self.thread.join(timeout=3)

    def snapshot(self):
        with self.lock:
            return {"status": self.status, "last_success": self.last_success}

    def _set(self, status, timestamp=None):
        with self.lock:
            self.status = status
            if timestamp is not None:
                self.last_success = timestamp

    def _check_stop(self, *_):
        if self.stop.is_set():
            raise InterruptedError("backup stopped")

    def _connect(self, path):
        if not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError("not a regular database")
        connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.2)
        connection.set_progress_handler(lambda: int(self.stop.is_set()), 1000)
        return connection

    def _entries(self):
        result = []
        for path in self.directory.iterdir():
            match = NAME.fullmatch(path.name)
            if match and stat.S_ISREG(path.lstat().st_mode):
                try:
                    date = datetime.datetime.strptime(match[1], "%Y%m%dT%H%M%S%f")
                except ValueError:
                    continue
                result.append((date.replace(tzinfo=datetime.timezone.utc).timestamp(), path))
        return sorted(result, reverse=True)

    def _recover(self):
        # Check newest to oldest, off the metadata lock. A corrupt/future file
        # cannot delay today's backup. Do not inspect arbitrary local files.
        for stamp, path in self._entries():
            self._check_stop()
            if stamp > time.time():
                continue
            try:
                connection = self._connect(path)
                try:
                    valid = (connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
                             and connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").fetchone() is not None)
                finally:
                    connection.close()
            except sqlite3.Error:
                continue
            if valid:
                self._set("ok", stamp)
                break

    def _backup_once(self):
        self._check_stop()
        if self.data.is_symlink():
            raise ValueError("symlinked data directory")
        self.directory.mkdir(mode=0o700, exist_ok=True)
        if not stat.S_ISDIR(self.directory.lstat().st_mode):
            raise ValueError("unsafe backup directory")
        if os.name != "nt":
            self.directory.chmod(0o700)
        source = self._connect(self.source)
        try:
            if self.last_success is None:
                self._recover()
            if self.last_success is not None:
                # Complete any failed retention pass before publishing again,
                # even when the next daily snapshot has become due.
                self._prune()
                if 0 <= time.time() - self.last_success < self.interval:
                    self._set("ok")
                    return
            stamp = datetime.datetime.now(datetime.timezone.utc)
            target = self.directory / (stamp.strftime("backup-%Y%m%dT%H%M%S%fZ.sqlite3"))
            fd, name = tempfile.mkstemp(prefix=".backup-", suffix=".tmp", dir=self.directory)
            temporary = Path(name)
            os.close(fd)
            try:
                destination = sqlite3.connect(temporary, timeout=0.2)
                try:
                    source.backup(destination, pages=128, progress=self._check_stop, sleep=0.05)
                    destination.set_progress_handler(lambda: int(self.stop.is_set()), 1000)
                    if destination.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                        raise ValueError("invalid snapshot")
                finally:
                    destination.close()
                self._check_stop()
                with temporary.open("r+b") as file:
                    os.fsync(file.fileno())
                if target.exists() or target.is_symlink():
                    raise ValueError("backup name collision")
                os.replace(temporary, target)
                if os.name != "nt":
                    directory_fd = os.open(self.directory, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
            finally:
                temporary.unlink(missing_ok=True)
            # Publication succeeded independently of retention. Even if cleanup
            # fails, its retry must not publish another full snapshot.
            self._set("ok", stamp.timestamp())
            self._prune()
        finally:
            source.close()

    def _prune(self):
        # A symlink is not a snapshot; unrelated files are never removed.
        entries = self._entries()
        valid_time = [(t, p) for t, p in entries if t <= time.time()]
        for _, path in valid_time[self.keep:]:
            if stat.S_ISREG(path.lstat().st_mode):
                path.unlink()

    def _run(self):
        while not self.stop.is_set():
            try:
                self._backup_once()
                # A restart reuses the remaining interval, not another full day.
                delay = max(0.05, self.interval - (time.time() - self.last_success))
            except Exception:
                if self.stop.is_set():
                    return
                self._set("error")
                delay = 60
            self.stop.wait(delay)
