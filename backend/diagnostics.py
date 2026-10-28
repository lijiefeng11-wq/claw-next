"""Bounded metadata-only diagnostics. Never pass payloads or exception text."""
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import traceback

_current = ContextVar("diagnostics", default=(None, {}))


def reference(shop, event):
    value = json.dumps([shop, event], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]


@contextmanager
def scope(log, **fields):
    token = _current.set((log, fields))
    try:
        yield
    finally:
        _current.reset(token)


def emit(event, **fields):
    log, context = _current.get()
    if log is not None:
        log.write(event, **context, **fields)


def failure(event, exc):
    frames = [{"file": Path(f.filename).name, "line": f.lineno, "function": f.name}
              for f in traceback.extract_tb(exc.__traceback__)[-12:]]
    emit(event, error_type=type(exc).__name__, frames=frames)


class Diagnostics:
    def __init__(self, data_dir, max_bytes=5 * 1024 * 1024, backups=3):
        directory = Path(data_dir) / "logs"
        directory.mkdir(parents=True, exist_ok=True)
        self.handler = RotatingFileHandler(directory / "backend.jsonl", maxBytes=max_bytes,
                                           backupCount=backups, encoding="utf-8")
        self.handler.setFormatter(logging.Formatter("%(message)s"))
        self.logger = logging.Logger("claw-next-diagnostics")
        self.logger.addHandler(self.handler)

    def write(self, event, **fields):
        record = {"time": datetime.now(timezone.utc).isoformat(), "event": event, **fields}
        try:
            self.logger.info(json.dumps(record, ensure_ascii=False, allow_nan=False))
        except Exception:
            pass  # Logging must not change task or delivery outcomes.

    def close(self):
        self.handler.close()
