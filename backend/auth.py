"""Local administrator credentials and revocable, memory-only login sessions."""
import hashlib
import hmac
import secrets
import sqlite3
import threading
import time
from pathlib import Path

from .store import ApiError, require


ITERATIONS = 600_000
SESSION_SECONDS = 8 * 60 * 60
# The seeded first-login credential. Only its salted hash is persisted; this
# value is used once at startup to decide whether the account still needs a
# password change.
INITIAL_PASSWORD = "admin"


def password_bytes(value):
    require(isinstance(value, str) and 1 <= len(value) <= 128, "invalid_password_request")
    try:
        return value.encode("utf-8")
    except UnicodeError:
        raise ApiError(400, "invalid_password_request") from None


def password_hash(value, salt, iterations=ITERATIONS):
    return hashlib.pbkdf2_hmac("sha256", password_bytes(value), salt, iterations)


class AdminAuth:
    # The service's data-directory lock must be held before opening this database.
    def __init__(self, data_dir):
        self.lock = threading.RLock()
        self.sessions = {}
        self.failures = {}
        self.must_change_password = True
        self.db = sqlite3.connect(str(Path(data_dir) / "admin.sqlite3"), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        try:
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.execute("""CREATE TABLE IF NOT EXISTS administrator (
                id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL,
                algorithm TEXT NOT NULL, iterations INTEGER NOT NULL,
                salt BLOB NOT NULL, password_hash BLOB NOT NULL)""")
            with self.db:
                if self.db.execute("SELECT id FROM administrator").fetchone() is None:
                    salt = secrets.token_bytes(32)
                    self.db.execute("INSERT INTO administrator VALUES (1,?,?,?,?,?)",
                                    ("admin", "pbkdf2_sha256", ITERATIONS, salt, password_hash(INITIAL_PASSWORD, salt)))
            account = self._account()
            require(account["username"] == "admin" and account["algorithm"] == "pbkdf2_sha256"
                    and account["iterations"] >= ITERATIONS and len(account["salt"]) == 32
                    and len(account["password_hash"]) == 32, "invalid_admin_database", 500)
            # Decide once at startup whether the persisted hash is still the
            # seeded default; no schema column is needed to track this.
            self.must_change_password = self._matches(INITIAL_PASSWORD, account)
        except Exception:
            self.db.close()
            raise

    def _account(self):
        return self.db.execute("SELECT * FROM administrator WHERE id=1").fetchone()

    def _matches(self, password, account):
        candidate = password_hash(password, account["salt"], account["iterations"])
        return hmac.compare_digest(candidate, account["password_hash"])

    def _check_limit(self, address):
        now = time.time()
        self.failures = {key: value for key, value in self.failures.items() if value[1] > now}
        record = self.failures.get(address, (0, now + 60))
        require(record[0] < 10 and (address in self.failures or len(self.failures) < 1024),
                "login_rate_limited", 429)
        return record

    def _failed(self, address, record):
        self.failures[address] = (record[0] + 1, record[1])

    def login(self, payload, address):
        username, password = payload.get("username"), payload.get("password")
        require(isinstance(username, str) and 1 <= len(username) <= 128, "invalid_login")
        password_bytes(password)
        with self.lock:
            record = self._check_limit(address)
            account = self._account()
            matches = self._matches(password, account)
            if username != account["username"] or not matches:
                self._failed(address, record)
                raise ApiError(401, "invalid_credentials")
            self.failures.pop(address, None)
            now = time.time()
            self.sessions = {key: expiry for key, expiry in self.sessions.items() if expiry > now}
            if len(self.sessions) >= 64:
                del self.sessions[min(self.sessions, key=self.sessions.get)]
            token = secrets.token_urlsafe(32)
            expires_at = now + SESSION_SECONDS
            self.sessions[self._session_key(token)] = expires_at
            return {"role": "admin", "username": account["username"],
                    "must_change_password": self.must_change_password,
                    "session_token": token, "expires_at": expires_at}

    @staticmethod
    def _session_key(token):
        return hashlib.sha256(token.encode("ascii")).digest()

    def identity(self, token):
        with self.lock:
            key = self._session_key(token)
            require(self.sessions.get(key, 0) > time.time(), "unauthorized", 401)
            return {"role": "admin", "username": "admin",
                    "must_change_password": self.must_change_password}

    def logout(self, token):
        with self.lock:
            self.identity(token)
            del self.sessions[self._session_key(token)]

    def change_password(self, token, payload, address):
        with self.lock:
            self.identity(token)
            current, new, confirmation = (payload.get(name) for name in
                                          ("current_password", "new_password", "confirm_password"))
            for value in (current, new, confirmation):
                password_bytes(value)
            require(new == confirmation, "password_mismatch")
            require(8 <= len(new) <= 128, "invalid_new_password")
            record = self._check_limit(address)
            if not self._matches(current, self._account()):
                self._failed(address, record)
                raise ApiError(403, "current_password_incorrect")
            require(new != current, "password_unchanged")
            salt = secrets.token_bytes(32)
            digest = password_hash(new, salt)
            with self.db:
                self.db.execute("UPDATE administrator SET salt=?, password_hash=?, iterations=? WHERE id=1",
                                (salt, digest, ITERATIONS))
            # Clear the first-login flag only after the new hash is committed.
            self.must_change_password = False
            self.sessions.clear()
            self.failures.clear()

    def close(self):
        with self.lock:
            self.sessions.clear()
            self.db.close()
