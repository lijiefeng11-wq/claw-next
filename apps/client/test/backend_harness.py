"""Starts the repository backend on an ephemeral loopback port for client tests.

Usage: python backend_harness.py <repo_root> <config.json> <data_dir>
Prints "PORT <n>" and serves until stdin is closed. Synthetic data only.

Startup is guarded by ``__main__``: the backend may run model work in
multiprocessing "spawn" children, which re-import this module; they must not
start a second server on the same data directory.

The stdin control pipe is moved to a private descriptor and the process's
standard input is pointed at the null device before the server starts.  On
Windows a spawned child interpreter can hang during startup when its standard
input is a pipe that has a pending blocking read in the parent
(https://github.com/python/cpython/issues/78961); model workers therefore
start with a null stdin while this process still notices the test runner
closing the pipe.
"""
import json
import os
import sys
import threading


def _detach_stdin():
    """Return a private fd for the control pipe; make fd 0 / the OS stdin handle the null device."""
    control = os.dup(0)  # non-inheritable (PEP 446)
    null = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null, 0)
    os.close(null)
    if sys.platform == "win32":
        import ctypes
        import msvcrt

        STD_INPUT_HANDLE = -10
        ctypes.windll.kernel32.SetStdHandle(STD_INPUT_HANDLE, msvcrt.get_osfhandle(0))
    return control


def _wait_closed(fd):
    """Block until the test runner closes the control pipe (EOF) or the read fails."""
    try:
        while os.read(fd, 4096):
            pass
    except OSError:
        pass
    finally:
        os.close(fd)


def main():
    control = _detach_stdin()
    sys.path.insert(0, sys.argv[1])
    from backend.app import create_server  # noqa: E402

    with open(sys.argv[2], encoding="utf-8") as file:
        config = json.load(file)
    server = create_server(config, sys.argv[3], "127.0.0.1", 0)
    print("PORT", server.server_address[1], flush=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    _wait_closed(control)
    server.shutdown()
    server.server_close()


if __name__ == "__main__":
    main()
