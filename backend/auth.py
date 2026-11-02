"""Local administrator credentials and revocable, memory-only login sessions."""
import hashlib
import hmac
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path

from .store import ApiError, require


ITERATIONS = 600_000
SESSION_SECONDS = 8 * 60 * 60
SESSION_CAP = 64
HANDOFF_GRANT_CAP = 8
HANDOFF_TICKET_CAP = 8
HANDOFF_TICKET_SECONDS = 60
OPAQUE_SECRET = re.compile(r"[A-Za-z0-9_-]{43}")
GRANT_IDENTIFIER = re.compile(r"[0-9a-f]{32}")
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


def opaque_secret(value):
    """True only for a well formed opaque grant/ticket value."""
    return isinstance(value, str) and OPAQUE_SECRET.fullmatch(value) is not None


def grant_identifier(value):
    """True only for a well formed lowercase hexadecimal grant id."""
    return isinstance(value, str) and GRANT_IDENTIFIER.fullmatch(value) is not None


class AdminAuth:
    # The service's data-directory lock must be held before opening this database.
    def __init__(self, data_dir):
        self.lock = threading.RLock()
        self.sessions = {}
        self.failures = {}
        self.tickets = {}
        self.must_change_password = True
        self.db = sqlite3.connect(str(Path(data_dir) / "admin.sqlite3"), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        try:
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.execute("""CREATE TABLE IF NOT EXISTS administrator (
                id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL,
                algorithm TEXT NOT NULL, iterations INTEGER NOT NULL,
                salt BLOB NOT NULL, password_hash BLOB NOT NULL)""")
            self.db.execute("""CREATE TABLE IF NOT EXISTS admin_handoff_grants (
                grant_id TEXT PRIMARY KEY, grant_hash BLOB NOT NULL UNIQUE,
                created_at REAL NOT NULL)""")
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

    def _open_session(self, account):
        """Minimal private session creator shared by login and handoff redeem."""
        now = time.time()
        self.sessions = {key: expiry for key, expiry in self.sessions.items() if expiry > now}
        if len(self.sessions) >= SESSION_CAP:
            del self.sessions[min(self.sessions, key=self.sessions.get)]
        token = secrets.token_urlsafe(32)
        expires_at = now + SESSION_SECONDS
        self.sessions[self._session_key(token)] = expires_at
        return {"role": "admin", "username": account["username"],
                "must_change_password": self.must_change_password,
                "session_token": token, "expires_at": expires_at}

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
            return self._open_session(account)

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

    # Persistent grants authorize only short-lived, single-use handoff tickets.
    def _handoff_admin(self, admin_token):
        require(isinstance(admin_token, str) and admin_token.isascii() and len(admin_token) <= 1024,
                "unauthorized", 401)
        identity = self.identity(admin_token)
        require(not identity["must_change_password"], "admin_password_change_required", 403)
        return identity

    def _grant_rows(self):
        return self.db.execute("SELECT grant_id, grant_hash, created_at "
                               "FROM admin_handoff_grants ORDER BY created_at, grant_id").fetchall()

    def _grant_hook(self, grant_token):
        """Match a presented grant against persisted hashes in constant time."""
        if not opaque_secret(grant_token):
            return None
        presented = self._session_key(grant_token)
        found = None
        for row in self._grant_rows():
            if hmac.compare_digest(row["grant_hash"], presented) and found is None:
                found = row["grant_id"]
        return found

    def _prune_tickets(self, now):
        self.tickets = {key: state for key, state in self.tickets.items() if state["expires_at"] > now}

    def create_handoff_grant(self, admin_token):
        with self.lock:
            self._handoff_admin(admin_token)
            require(len(self._grant_rows()) < HANDOFF_GRANT_CAP, "handoff_grant_limit", 409)
            grant_id = secrets.token_hex(16)
            grant_token = secrets.token_urlsafe(32)
            created_at = time.time()
            with self.db:
                self.db.execute("INSERT INTO admin_handoff_grants (grant_id, grant_hash, created_at) "
                                "VALUES (?,?,?)", (grant_id, self._session_key(grant_token), created_at))
            return {"grant_id": grant_id, "grant_token": grant_token, "created_at": created_at}

    def list_handoff_grants(self, admin_token):
        with self.lock:
            self._handoff_admin(admin_token)
            return {"grants": [{"grant_id": row["grant_id"], "created_at": row["created_at"]}
                               for row in self._grant_rows()]}

    def revoke_handoff_grant(self, admin_token, grant_id):
        with self.lock:
            self._handoff_admin(admin_token)
            require(grant_identifier(grant_id), "invalid_handoff_request")
            with self.db:
                self.db.execute("DELETE FROM admin_handoff_grants WHERE grant_id=?", (grant_id,))
            self.tickets = {key: state for key, state in self.tickets.items()
                            if state["grant_id"] != grant_id}

    def issue_handoff_ticket(self, grant_token, address):
        with self.lock:
            record = self._check_limit(address)
            now = time.time()
            self._prune_tickets(now)
            grant_id = self._grant_hook(grant_token)
            if grant_id is None or self.must_change_password:
                self._failed(address, record)
                raise ApiError(401, "invalid_handoff_grant")
            require(len(self.tickets) < HANDOFF_TICKET_CAP, "handoff_ticket_limit", 409)
            ticket = secrets.token_urlsafe(32)
            expires_at = now + HANDOFF_TICKET_SECONDS
            self.tickets[self._session_key(ticket)] = {"grant_id": grant_id, "expires_at": expires_at}
            self.failures.pop(address, None)
            return {"ticket": ticket, "expires_at": expires_at}

    def redeem_handoff_ticket(self, payload, address):
        with self.lock:
            record = self._check_limit(address)
            valid = isinstance(payload, dict) and set(payload) == {"ticket"} and opaque_secret(payload["ticket"])
            state = self.tickets.pop(self._session_key(payload["ticket"]), None) if valid else None
            grant_id = state["grant_id"] if state else None
            parent = (self.db.execute("SELECT 1 FROM admin_handoff_grants WHERE grant_id=?", (grant_id,)).fetchone()
                      if grant_id is not None else None)
            if state is None or state["expires_at"] <= time.time() or parent is None or self.must_change_password:
                self._failed(address, record)
                raise ApiError(401, "invalid_handoff")
            self.failures.pop(address, None)
            return self._open_session(self._account())

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
            # Grants die in the same transaction as the credential update.
            with self.db:
                self.db.execute("UPDATE administrator SET salt=?, password_hash=?, iterations=? WHERE id=1",
                                (salt, digest, ITERATIONS))
                self.db.execute("DELETE FROM admin_handoff_grants")
            # Only a committed change revokes memory-only state.
            self.must_change_password = False
            self.tickets.clear()
            self.sessions.clear()
            self.failures.clear()

    def close(self):
        with self.lock:
            self.sessions.clear()
            self.tickets.clear()
            self.db.close()
