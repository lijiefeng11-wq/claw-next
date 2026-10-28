"""Service checks use private fictional data and never install a LaunchAgent."""
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

from backend import app, service, modelsecrets
from backend.lock import DataLock

REPO = Path(__file__).resolve().parent.parent
CONFIG = {"shops": [{"shop_id": "demo", "name": "Fictional"}], "clients": []}


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="claw service 空 格 ")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def test_budget_persists_limits_and_ages_out(self):
        now = [1000.0]
        budget = service.RestartBudget(self.directory, clock=lambda: now[0])
        for offset in (0, 10, 20):
            now[0] = 1000 + offset
            self.assertTrue(budget.record())
        self.assertFalse(budget.record())
        self.assertFalse(service.RestartBudget(self.directory, clock=lambda: now[0]).record())
        now[0] = 900  # A clock rollback cannot grant extra restarts.
        self.assertFalse(budget.record())
        now[0] = 1301
        self.assertTrue(budget.record())
        if os.name != "nt":
            self.assertEqual(budget.path.stat().st_mode & 0o777, 0o600)

    def test_corrupt_budget_fails_closed(self):
        for raw in ('{bad', '{"starts": ["x"]}', '{"starts": [NaN]}', '{}'):
            with self.subTest(raw=raw):
                (self.directory / service.STARTS_FILE).write_text(raw)
                with patch.object(service, "_run") as run:
                    self.assertEqual(service.serve(CONFIG, self.directory, port=0), 0)
                run.assert_not_called()
                self.assertEqual((self.directory / service.STARTS_FILE).read_text(), raw)

    def test_budget_checked_under_store_lock_before_worker_start(self):
        with patch.object(service, "_run", return_value=0) as run:
            for _ in range(4):
                self.assertEqual(service.serve(CONFIG, self.directory, port=0), 0)
        self.assertEqual(run.call_count, 3)
        with patch.object(service, "_run") as run:
            held = DataLock(self.directory)
            before = (self.directory / service.STARTS_FILE).read_bytes()
            try:
                self.assertEqual(service.serve(CONFIG, self.directory, port=0), 0)
            finally:
                held.close()
        run.assert_not_called()
        self.assertEqual((self.directory / service.STARTS_FILE).read_bytes(), before)

    def test_dead_worker_closes_http_and_releases_lock(self):
        def factory(*args, **kwargs):
            server = app.create_server(*args, **kwargs)
            server.stop.set()
            server.wake.set()
            server.worker.join(5)
            return server

        self.assertEqual(service.serve(CONFIG, self.directory, port=0, server_factory=factory), 1)
        lock = DataLock(self.directory)
        lock.close()

    def test_dead_http_thread_does_not_leave_worker_serving(self):
        with patch.object(app.Server, "serve_forever", return_value=None):
            self.assertEqual(service.serve(CONFIG, self.directory, port=0), 1)
        lock = DataLock(self.directory)
        lock.close()

    def test_startup_exception_text_is_never_logged(self):
        canary = "fictional-private-exception-text"
        def fail(*args, **kwargs):
            raise RuntimeError(canary)
        with patch("sys.stderr") as stderr:
            self.assertEqual(service.serve(CONFIG, self.directory, server_factory=fail), 0)
        self.assertNotIn(canary, str(stderr.write.call_args_list))
        self.assertNotIn(canary, (self.directory / "logs/backend.jsonl").read_text())

    def test_startup_secret_failure_has_safe_actionable_code(self):
        def fail(*args, **kwargs):
            raise modelsecrets.SecretError("secret_migration_cleanup_failed")
        with patch("sys.stderr") as stderr:
            self.assertEqual(service.serve(CONFIG, self.directory, server_factory=fail), 0)
        self.assertIn("secret_migration_cleanup_failed", str(stderr.write.call_args_list))
        log = (self.directory / "logs/backend.jsonl").read_text()
        self.assertIn("secret_migration_cleanup_failed", log)

    def test_unexpected_runtime_exception_restarts_without_leaking_text(self):
        with patch.object(service, "_run", side_effect=RuntimeError("fictional-private-runtime-text")):
            self.assertEqual(service.serve(CONFIG, self.directory, port=0), 1)
        log = (self.directory / "logs/backend.jsonl").read_text()
        self.assertIn("launchd_runtime_failed", log)
        self.assertNotIn("fictional-private-runtime-text", log)
        lock = DataLock(self.directory)
        lock.close()

    def test_non_loopback_host_rejected_without_start(self):
        self.assertEqual(service.serve(CONFIG, self.directory, host="0.0.0.0"), 0)
        self.assertFalse((self.directory / service.STARTS_FILE).exists())

    @unittest.skipIf(os.name == "nt", "POSIX signals; Windows is not a launchd host")
    def test_real_process_health_sigterm_and_second_instance(self):
        config = self.directory / "config.json"
        config.write_text(json.dumps(CONFIG))
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        command = [sys.executable, "-m", "backend.service", "--config", str(config),
                   "--data-dir", str(self.directory), "--port", str(port)]
        process = subprocess.Popen(command, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 15
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            while True:
                self.assertIsNone(process.poll(), "service exited before health check")
                try:
                    with opener.open(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                        self.assertEqual(response.status, 200)
                    break
                except OSError:
                    self.assertLess(time.monotonic(), deadline, "service failed to listen")
                    time.sleep(0.05)
            before = (self.directory / service.STARTS_FILE).read_bytes()
            # Use another valid port to exercise the data lock (not bind failure).
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                other_port = sock.getsockname()[1]
            second = subprocess.run(command[:-1] + [str(other_port)], cwd=REPO,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(second.returncode, 0)
            self.assertIn("startup failed", second.stderr)
            self.assertEqual((self.directory / service.STARTS_FILE).read_bytes(), before)
            process.send_signal(signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertIn("shutdown requested", stderr)
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=10)
        lock = DataLock(self.directory)
        lock.close()
