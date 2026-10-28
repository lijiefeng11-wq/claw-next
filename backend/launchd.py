import argparse
import os
import plistlib
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
HOST = "127.0.0.1"
DEFAULT_PORT = 18881
DEFAULT_LABEL = "com.claw-next.backend"

# launchd labels: reverse-DNS style; no slashes, spaces or control characters.
_LABEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,100}(?:\.[A-Za-z0-9][A-Za-z0-9_-]{0,100})*$")


class LaunchdError(Exception):
    """Unsafe input or output. The message is a fixed, non-secret code."""


def _absolute(raw, field):
    try:
        path = Path(raw)
    except TypeError:
        raise LaunchdError(f"invalid_{field}") from None
    if not str(raw) or "\x00" in str(raw) or not path.is_absolute():
        raise LaunchdError(f"{field}_must_be_absolute")
    return path


def parse_port(value):
    if isinstance(value, bool):
        raise LaunchdError("invalid_port")
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise LaunchdError("invalid_port") from None
    if isinstance(value, float) and value != port:
        raise LaunchdError("invalid_port")
    if not 1 <= port <= 65535:
        raise LaunchdError("invalid_port")
    return port


def build_plist(config, data_dir, python, port=DEFAULT_PORT, label=DEFAULT_LABEL,
                repo=REPO):
    """Return the LaunchAgent dictionary. Pure: no filesystem access."""
    config = _absolute(config, "config")
    data_dir = _absolute(data_dir, "data_dir")
    python = _absolute(python, "python")
    if not isinstance(label, str) or not _LABEL.fullmatch(label):
        raise LaunchdError("invalid_label")
    port = parse_port(port)
    logs = data_dir / "logs"
    plist = {
        "Label": label,
        "ProgramArguments": [
            str(python), "-m", "backend.service",
            "--config", str(config),
            "--data-dir", str(data_dir),
            "--host", HOST,
            "--port", str(port),
        ],
        "WorkingDirectory": str(_absolute(repo, "repo")),
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 30,
        "StandardOutPath": str(logs / "backend.out.log"),
        "StandardErrorPath": str(logs / "backend.err.log"),
        "Umask": 0o077,
    }
    return plist


def validate_inputs(config, data_dir, python):
    """Validate source files; allow macOS standard parent aliases such as /var."""
    config = _absolute(config, "config")
    data_dir = _absolute(data_dir, "data_dir")
    python = _absolute(python, "python")
    if not config.is_file():
        raise LaunchdError("config_not_found")
    if not python.is_file() or not os.access(python, os.X_OK):
        raise LaunchdError("python_not_executable")
    if data_dir.exists():
        if data_dir.is_symlink() or not data_dir.is_dir():
            raise LaunchdError("data_dir_not_a_directory")
    else:
        parent = data_dir.parent
        while not parent.exists() and parent.parent != parent:
            parent = parent.parent
        if not parent.is_dir():
            raise LaunchdError("data_dir_parent_missing")
    return config, data_dir, python


def generate(config, data_dir, python, output, port=DEFAULT_PORT, label=DEFAULT_LABEL, repo=REPO):
    """Validate, then create the plist file exactly once (never overwrite)."""
    config, data_dir, python = validate_inputs(config, data_dir, python)
    output = _absolute(output, "output")
    if output in (config, data_dir, python) or output.is_dir():
        raise LaunchdError("invalid_output")
    plist = build_plist(config, data_dir, python, port, label, repo)
    # launchd opens these paths before starting Python.
    logs = data_dir / "logs"
    if logs.is_symlink():
        raise LaunchdError("logs_dir_symlink")
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    logs.mkdir(exist_ok=True, mode=0o700)
    _create_exclusive(output, plistlib.dumps(plist, fmt=plistlib.FMT_XML, sort_keys=True))
    return plist


def _create_exclusive(output, payload):
    """Write a private temp file, then link it into place so nothing is clobbered."""
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    created = False
    try:
        descriptor = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        created = True
        with os.fdopen(descriptor, "wb") as file:
            file.write(payload)
            file.flush()
            os.fsync(file.fileno())
        os.link(tmp, output)
    except FileExistsError:
        raise LaunchdError("output_exists") from None
    finally:
        try:
            if created:
                os.unlink(tmp)
        except OSError:
            pass


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m backend.launchd",
                                     description="Generate (never install) a backend LaunchAgent plist.")
    parser.add_argument("--config", required=True, help="absolute path to backend config JSON")
    parser.add_argument("--data-dir", required=True, help="absolute path to the backend data directory")
    parser.add_argument("--python", required=True, help="absolute path to a Python 3.11+ interpreter")
    parser.add_argument("--output", required=True, help="absolute path of the plist to create")
    parser.add_argument("--port", default=str(DEFAULT_PORT), help=f"loopback port (default {DEFAULT_PORT})")
    parser.add_argument("--label", default=DEFAULT_LABEL, help=f"launchd label (default {DEFAULT_LABEL})")
    args = parser.parse_args(argv)
    try:
        plist = generate(args.config, args.data_dir, args.python, args.output, args.port, args.label)
    except LaunchdError as exc:
        print(f"launchd generation failed: {exc}", file=sys.stderr)
        return 2
    except OSError:
        print("launchd generation failed: io_error", file=sys.stderr)
        return 2
    print(f"LaunchAgent plist created; label: {plist['Label']}; loopback port "
          f"{plist['ProgramArguments'][-1]}; not installed.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
