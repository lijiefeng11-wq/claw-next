"""Independent local admin grants, using fictional credentials and temporary data."""
import concurrent.futures
import hashlib
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from backend import auth as auth_module
from backend.auth import AdminAuth, SESSION_SECONDS
from backend.store import ApiError

ADDRESS = "127.0.0.1"
PASSWORD = "fictional-handoff-password"


class HandoffAuthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="claw-handoff-auth-")
        self.addCleanup(self.tmp.cleanup)
        self.auth = AdminAuth(self.tmp.name)
        self.addCleanup(lambda: self.auth.close())
        first = self.auth.login({"username": "admin", "password": "admin"}, ADDRESS)
        self.auth.change_password(first["session_token"], {
            "current_password": "admin", "new_password": PASSWORD, "confirm_password": PASSWORD}, ADDRESS)
        self.session = self.login()

    def login(self):
        return self.auth.login({"username": "admin", "password": PASSWORD}, ADDRESS)["session_token"]

    def error(self, status, code, call, *args):
        with self.assertRaises(ApiError) as caught:
            call(*args)
        self.assertEqual((caught.exception.status, caught.exception.code), (status, code))

    def grant(self):
        return self.auth.create_handoff_grant(self.session)

    def ticket(self, grant):
        return self.auth.issue_handoff_ticket(grant["grant_token"], ADDRESS)["ticket"]

    def redeem(self, ticket):
        return self.auth.redeem_handoff_ticket({"ticket": ticket}, ADDRESS)

    def test_first_password_gate_and_credential_classes(self):
        with tempfile.TemporaryDirectory() as initial:
            auth = AdminAuth(initial)
            try:
                token = auth.login({"username": "admin", "password": "admin"}, ADDRESS)["session_token"]
                for method, args in ((auth.create_handoff_grant, (token,)),
                                     (auth.list_handoff_grants, (token,)),
                                     (auth.revoke_handoff_grant, (token, "0" * 32))):
                    self.error(403, "admin_password_change_required", method, *args)
            finally:
                auth.close()
        for token in (None, "", "c" * 40, "虚构"):
            self.error(401, "unauthorized", self.auth.create_handoff_grant, token)
        grant = self.grant()
        self.error(401, "unauthorized", self.auth.identity, grant["grant_token"])
        self.error(401, "invalid_handoff_grant", self.auth.issue_handoff_ticket, self.session, ADDRESS)
        self.error(401, "invalid_handoff", self.redeem, self.session)

    def test_hash_only_persistence_restart_and_memory_only_tickets(self):
        grant = self.grant()
        ticket = self.ticket(grant)
        self.assertRegex(grant["grant_id"], r"^[0-9a-f]{32}$")
        self.assertRegex(grant["grant_token"], r"^[A-Za-z0-9_-]{43}$")
        self.assertEqual(self.auth.list_handoff_grants(self.session), {"grants": [
            {"grant_id": grant["grant_id"], "created_at": grant["created_at"]}]})
        row = self.auth.db.execute("SELECT grant_hash FROM admin_handoff_grants").fetchone()
        self.assertEqual(row[0], hashlib.sha256(grant["grant_token"].encode()).digest())
        raw = (pathlib.Path(self.tmp.name) / "admin.sqlite3").read_bytes()
        self.assertNotIn(grant["grant_token"].encode(), raw)
        self.assertNotIn(ticket.encode(), raw)
        self.auth.close()
        self.auth = AdminAuth(self.tmp.name)
        self.error(401, "unauthorized", self.auth.identity, self.session)
        self.error(401, "invalid_handoff", self.redeem, ticket)
        self.session = self.login()
        self.assertEqual(self.redeem(self.ticket(grant))["role"], "admin")

    def test_concurrent_single_use_and_normal_session_lifetime(self):
        ticket = self.ticket(self.grant())
        def attempt(_):
            try:
                return self.redeem(ticket)
            except ApiError as error:
                return error.code
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(attempt, range(8)))
        sessions = [r for r in results if isinstance(r, dict)]
        self.assertEqual(len(sessions), 1)
        self.assertEqual(results.count("invalid_handoff"), 7)
        self.assertEqual(self.auth.identity(sessions[0]["session_token"])["role"], "admin")
        self.assertLessEqual(sessions[0]["expires_at"], auth_module.time.time() + SESSION_SECONDS)

    def test_exact_expiry_boundary_and_ticket_cap(self):
        grant = self.grant()
        now = auth_module.time.time()
        with mock.patch.object(auth_module, "time", SimpleNamespace(time=lambda: now)):
            tickets = [self.ticket(grant) for _ in range(8)]
            self.error(409, "handoff_ticket_limit", self.ticket, grant)
            now += 60
            self.error(401, "invalid_handoff", self.redeem, tickets[0])
            self.assertEqual(self.redeem(self.ticket(grant))["role"], "admin")

    def test_grant_limit_and_idempotent_revoke(self):
        grants = [self.grant() for _ in range(8)]
        self.error(409, "handoff_grant_limit", self.grant)
        self.auth.revoke_handoff_grant(self.session, grants[0]["grant_id"])
        self.auth.revoke_handoff_grant(self.session, grants[0]["grant_id"])
        self.grant()
        self.assertEqual(len(self.auth.list_handoff_grants(self.session)["grants"]), 8)
        self.error(400, "invalid_handoff_request", self.auth.revoke_handoff_grant, self.session, "bad")

    def test_revoke_invalidates_only_its_grant_and_pending_tickets(self):
        first, other = self.grant(), self.grant()
        consumed = self.redeem(self.ticket(first))["session_token"]
        pending = self.ticket(first)
        self.auth.revoke_handoff_grant(self.session, first["grant_id"])
        self.error(401, "invalid_handoff", self.redeem, pending)
        self.error(401, "invalid_handoff_grant", self.ticket, first)
        self.assertEqual(self.auth.identity(consumed)["role"], "admin")
        self.assertEqual(self.redeem(self.ticket(other))["role"], "admin")

    def test_logout_preserves_grant(self):
        grant = self.grant()
        self.auth.logout(self.session)
        self.assertEqual(self.redeem(self.ticket(grant))["role"], "admin")

    def test_password_failure_preserves_and_success_revokes_all(self):
        grant = self.grant()
        pending = self.ticket(grant)
        payload = {"current_password": "wrong", "new_password": "fictional-next-password",
                   "confirm_password": "fictional-next-password"}
        self.error(403, "current_password_incorrect", self.auth.change_password, self.session, payload, ADDRESS)
        self.assertEqual(self.redeem(pending)["role"], "admin")
        pending = self.ticket(grant)
        payload["current_password"] = PASSWORD
        self.auth.change_password(self.session, payload, ADDRESS)
        self.error(401, "unauthorized", self.auth.identity, self.session)
        self.error(401, "invalid_handoff", self.redeem, pending)
        self.error(401, "invalid_handoff_grant", self.ticket, grant)

    def test_password_transaction_failure_preserves_password_and_all_authorizations(self):
        grant = self.grant()
        pending = self.ticket(grant)
        self.auth.db.execute("""CREATE TRIGGER fictional_delete_failure BEFORE DELETE ON admin_handoff_grants
                             BEGIN SELECT RAISE(ABORT, 'fictional failure'); END""")
        with self.assertRaises(sqlite3.IntegrityError):
            self.auth.change_password(self.session, {
                "current_password": PASSWORD, "new_password": "fictional-next-password",
                "confirm_password": "fictional-next-password"}, ADDRESS)
        self.assertEqual(self.auth.identity(self.session)["role"], "admin")
        self.assertEqual(self.redeem(pending)["role"], "admin")
        self.assertTrue(self.login())

    def test_malformed_credentials_share_uniform_errors_and_address_limit(self):
        malformed = [None, 42, {}, "", "x" * 5000, "虚构", "a" * 42, "a" * 44, "!" * 43]
        for value in malformed:
            self.error(401, "invalid_handoff_grant", self.auth.issue_handoff_ticket, value, ADDRESS)
        self.error(401, "invalid_handoff", self.auth.redeem_handoff_ticket, {"ticket": "x", "extra": 1}, ADDRESS)
        self.error(429, "login_rate_limited", self.auth.redeem_handoff_ticket, {}, ADDRESS)
        self.error(429, "login_rate_limited", self.auth.login, {"username": "admin", "password": PASSWORD}, ADDRESS)
        self.error(401, "invalid_handoff", self.auth.redeem_handoff_ticket, {"ticket": "虚构"}, "::1")

    def test_redeemed_sessions_use_existing_total_cap(self):
        grant = self.grant()
        with mock.patch.object(auth_module, "time", SimpleNamespace(time=lambda: 2000000000.0)):
            self.auth.sessions.clear()
            first = self.auth.login({"username": "admin", "password": PASSWORD}, ADDRESS)["session_token"]
            self.auth.sessions[self.auth._session_key(first)] -= 1
            for _ in range(64):
                self.redeem(self.ticket(grant))
            self.assertEqual(len(self.auth.sessions), 64)
            self.error(401, "unauthorized", self.auth.identity, first)
