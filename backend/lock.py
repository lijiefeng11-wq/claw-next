"""One backend process per data directory on Windows and POSIX."""
import os
from pathlib import Path


class DataLock:
    def __init__(self, data_dir):
        self.file = (Path(data_dir) / "server.lock").open("a+b")
        self.file.seek(0, 2)
        if self.file.tell() == 0:
            self.file.write(b"0")
            self.file.flush()
        self.file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            raise RuntimeError("Claw-Next data directory is already in use by another backend.") from None

    def close(self):
        self.file.close()
