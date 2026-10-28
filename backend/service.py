"""Backend service entry for macOS launchd (and manual foreground use).

    python -m backend.service --config ABS --data-dir ABS [--port 18881]

Loopback only. Exit codes:

* 0 - clean shutdown (SIGTERM/SIGINT), configuration/startup failure, or the
  restart budget was exhausted. launchd KeepAlive {SuccessfulExit: false} does
  not relaunch a clean exit, so these failures cannot become a crash loop.
* 1 - a service thread died or the running service failed unexpectedly; HTTP
  is stopped so launchd can restart the whole process within its start budget.

The restart budget is a small atomic timestamp file inside the owned data
directory, written only after the single-instance Store lock is held. No
secrets, config contents or exception text are ever printed.
"""
import argparse
import json
import math
import os
import signal
import sys
import threading
import time
from pathlib import Path

from . import app, diagnostics, launchd, modelsecrets

RESTART_LIMIT = 3
RESTART_WINDOW = 300
STARTS_FILE = "launchd_starts.json"


class RestartLimit(Exception):
    pass


class RestartBudget:
    """Bounded start history; only usable while the data lock is held."""

    def __init__(self, data_dir, limit=RESTART_LIMIT, window=RESTART_WINDOW, clock=time.time):
        self.path = Path(data_dir) / STARTS_FILE
        self.limit, self.window, self.clock = limit, window, clock

    def _load(self):
        try:
            with self.path.open("r", encoding="utf-8") as file:
                starts = json.load(file)["starts"]
        except FileNotFoundError:
            return []
        if (not isinstance(starts, list) or len(starts) > self.limit
                or any(type(ts) not in (int, float) or not math.isfinite(ts) for ts in starts)):
            raise ValueError("invalid_restart_budget")
        return starts

    def record(self):
        """Record a start; return False when the budget is already exhausted."""
        now = self.clock()
        recent = [ts for ts in self._load() if now - ts < self.window]
        if len(recent) >= self.limit:
            return False
        recent.append(now)
        payload = json.dumps({"starts": recent[-self.limit:]}).encode("utf-8")
        tmp = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        created = False
        try:
            descriptor = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            created = True
            with os.fdopen(descriptor, "wb") as file:
                file.write(payload)
                file.flush()
                os.fsync(file.fileno())
            os.replace(tmp, self.path)
            if os.name != "nt":
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        finally:
            try:
                if created:
                    tmp.unlink()
            except OSError:
                pass
        return True


def _log(data_dir, event, **fields):
    """Metadata-only diagnostics under data/logs; never config or exception text."""
    try:
        log = diagnostics.Diagnostics(data_dir)
    except Exception:
        return
    try:
        log.write(event, **fields)
    finally:
        try:
            log.close()
        except Exception:
            pass


def _halt(code, message):
    print(f"claw-next backend: {message}", file=sys.stderr, flush=True)
    return code


def serve(config, data_dir, host=launchd.HOST, port=launchd.DEFAULT_PORT,
          server_factory=app.create_server, budget=None):
    """Run one lifetime. The Store owns the single data lock, not this wrapper."""
    data_dir = Path(data_dir)
    if host != launchd.HOST:
        return _halt(0, "only 127.0.0.1 is supported for the launchd service.")
    budget = budget if budget is not None else RestartBudget(data_dir)

    def check_budget():
        # Invoked after Store acquired the lock, before worker/HTTP startup.
        if not budget.record():
            raise RestartLimit()

    server = None
    try:
        data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        server = server_factory(config, data_dir, host, port, startup_check=check_budget)
    except RestartLimit:
        _log(data_dir, "launchd_restart_budget_exhausted", limit=budget.limit, window_seconds=budget.window)
        return _halt(0, "restart budget exhausted; staying stopped to avoid a restart storm.")
    except Exception as exc:
        safe_codes = {"secret_storage_unavailable", "secret_encrypt_failed", "secret_decrypt_failed",
                      "secret_migration_cleanup_failed"}
        code = exc.code if isinstance(exc, modelsecrets.SecretError) and exc.code in safe_codes else "startup_failed"
        _log(data_dir, "launchd_startup_failed", error_type=type(exc).__name__, code=code)
        return _halt(0, f"startup failed ({code}); see data/logs/backend.jsonl.")
    try:
        return _run(server, data_dir)
    except Exception as exc:
        _log(data_dir, "launchd_runtime_failed", error_type=type(exc).__name__)
        return _halt(1, "runtime failed; exiting for launchd restart.")
    finally:
        server.server_close()


def _run(server, data_dir):
    stopped = threading.Event()

    def request_stop(_signum=None, _frame=None):
        stopped.set()

    previous = {}
    for name in ("SIGTERM", "SIGINT"):
        if hasattr(signal, name):
            try:
                previous[name] = signal.signal(getattr(signal, name), request_stop)
            except (OSError, ValueError):
                pass
    http = None
    try:
        port = server.server_address[1]
        _log(data_dir, "launchd_service_starting", port=port)
        print(f"Claw-Next backend listening on http://{launchd.HOST}:{port}", flush=True)
        http = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2},
                                name="claw-next-http", daemon=True)
        http.start()
        # Monitor the existing decision worker; if it dies, HTTP must not serve on.
        while not stopped.is_set():
            if not server.worker.is_alive() or not http.is_alive():
                _log(data_dir, "service_thread_died")
                print("claw-next backend: worker or HTTP thread stopped; exiting for launchd restart.",
                      file=sys.stderr, flush=True)
                return 1
            stopped.wait(0.2)
        _log(data_dir, "launchd_shutdown_requested")
        print("claw-next backend: shutdown requested.", file=sys.stderr, flush=True)
        return 0
    finally:
        # Stop HTTP first so no request can wait forever on a stopping worker;
        # server_close() then stops and joins the worker.
        try:
            if http is not None and http.is_alive():
                server.shutdown()
                http.join(timeout=5)
        except Exception:
            pass
        for name, handler in previous.items():
            try:
                signal.signal(getattr(signal, name), handler)
            except (OSError, ValueError):
                pass


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m backend.service",
                                     description="Claw-Next backend service (loopback only).")
    parser.add_argument("--config", required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--host", default=launchd.HOST)
    parser.add_argument("--port", default=str(launchd.DEFAULT_PORT))
    args = parser.parse_args(argv)
    os.umask(0o077)
    config_path, data_dir = Path(args.config), Path(args.data_dir)
    try:
        port = launchd.parse_port(args.port)
    except launchd.LaunchdError:
        return _halt(0, "invalid port.")
    if not config_path.is_absolute() or not data_dir.is_absolute():
        return _halt(0, "config and data directory must be absolute paths.")
    try:
        with config_path.open(encoding="utf-8-sig") as file:
            config = json.load(file)
        app.validate_config(config)
    except Exception:
        return _halt(0, "configuration is missing or invalid.")
    return serve(config, data_dir, args.host, port)


if __name__ == "__main__":
    sys.exit(main())
