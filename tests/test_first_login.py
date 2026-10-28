"""Focused regression tests for the mandatory first-login password change.

Each test drives a real loopback ``ThreadingHTTPServer`` built with
``create_server`` against an isolated temporary data directory. Credentials,
shop names and client tokens are fictional. Nothing touches live services,
real configuration, platforms or external provider endpoints.
"""

from __future__ import annotations

import copy
import json
import os
import pathlib
import secrets
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest import mock

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from backend import auth as auth_module  # noqa: E402
from backend.app import create_server  # noqa: E402
from backend.auth import AdminAuth, ITERATIONS, password_hash  # noqa: E402
from backend.store import ApiError  # noqa: E402

INITIAL_PASSWORD = "admin"
NEW_PASSWORD = "synthetic-first-login-pass-2026"
SECOND_PASSWORD = "synthetic-second-pass-2026"
PRE_EXISTING_PASSWORD = "pre-existing-changed-pass"
CLIENT_TOKEN = "f" * 40
LEGACY_ADMIN_TOKEN = "e" * 40
SHOP_ID = "shop-first-login"
CLIENT_ID = "client-first-login"

# A local-only model configuration; the test never lets it reach a provider.
LOCAL_MODEL = {"primary": {"base_url": "http://127.0.0.1:9", "model": "fictional-local",
                           "timeout_seconds": 1, "api_key": "synthetic-local-key"},
               "backup": {}}


def test_config(admin_token=LEGACY_ADMIN_TOKEN):
    config = {
        "shops": [{"shop_id": SHOP_ID, "name": "虚构首次登录测试店"}],
        "clients": [{"client_id": CLIENT_ID, "shop_id": SHOP_ID, "token": CLIENT_TOKEN}],
        "model": copy.deepcopy(LOCAL_MODEL),
    }
    if admin_token is not None:
        config["admin_token"] = admin_token
    return config


class FirstLoginTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory(prefix="claw-next-first-login-")
        self.addCleanup(self._tmpdir.cleanup)
        self.data_dir = self._tmpdir.name
        self._servers = []
        self.start_server()
        self.addCleanup(self._stop_all_servers)

    # -- fixture ---------------------------------------------------------
    def start_server(self, config=None):
        server = create_server(copy.deepcopy(test_config() if config is None else config),
                               self.data_dir, host="127.0.0.1", port=0)
        thread = threading.Thread(target=server.serve_forever, name="claw-next-first-login",
                                  daemon=True)
        thread.start()
        self._servers.append((server, thread))
        self.server = server
        self.base_url = f"http://127.0.0.1:{server.server_address[1]}"
        return server

    def stop_server(self):
        server, thread = self._servers.pop()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive(), "server thread did not stop")

    def _stop_all_servers(self):
        while self._servers:
            self.stop_server()

    def restart_server(self):
        self.stop_server()
        return self.start_server()

    # -- HTTP ------------------------------------------------------------
    def request(self, method, path, body=None, token=None, content_type=True):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(self.base_url + path, data=data, method=method)
        if data is not None and content_type:
            request.add_header("Content-Type", "application/json")
        if token is not None:
            request.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                status, payload = response.status, response.read()
        except urllib.error.HTTPError as exc:
            status, payload = exc.code, exc.read()
        return status, json.loads(payload.decode("utf-8")) if payload else None

    def assert_error(self, result, status, code):
        got_status, body = result
        self.assertEqual(got_status, status, msg=f"unexpected HTTP {got_status}, body={body!r}")
        self.assertIsInstance(body, dict)
        self.assertEqual(body.get("error", {}).get("code"), code, msg=body)
        return body

    # -- auth helpers ----------------------------------------------------
    def login(self, password=INITIAL_PASSWORD):
        status, body = self.request("POST", "/api/v1/admin/login",
                                    {"username": "admin", "password": password})
        self.assertEqual(status, 200, msg=body)
        return body

    def login_token(self, password=INITIAL_PASSWORD):
        return self.login(password=password)["session_token"]

    def me(self, token):
        return self.request("GET", "/api/v1/me", token=token)

    def change(self, token, current=INITIAL_PASSWORD, new=NEW_PASSWORD, confirm=None):
        return self.request("POST", "/api/v1/admin/password",
                            {"current_password": current, "new_password": new,
                             "confirm_password": new if confirm is None else confirm},
                            token=token)

    def account_row(self):
        db = sqlite3.connect(str(pathlib.Path(self.data_dir) / "admin.sqlite3"))
        try:
            db.row_factory = sqlite3.Row
            row = db.execute("SELECT * FROM administrator WHERE id=1").fetchone()
        finally:
            db.close()
        self.assertIsNotNone(row)
        return dict(row)

    def write_account(self, password):
        """Overwrite the stored credential hash directly (previous-release database)."""
        salt = secrets.token_bytes(32)
        db = sqlite3.connect(str(pathlib.Path(self.data_dir) / "admin.sqlite3"))
        try:
            with db:
                db.execute("UPDATE administrator SET salt=?, password_hash=?, iterations=? WHERE id=1",
                           (salt, password_hash(password, salt), ITERATIONS))
        finally:
            db.close()

    # -- contract --------------------------------------------------------
    def test_login_and_me_report_must_change_password(self):
        body = self.login()
        self.assertIs(body.get("must_change_password"), True)
        self.assertEqual(body.get("role"), "admin")
        self.assertEqual(body.get("protocol_version"), "1.0")
        token = body["session_token"]

        status, me = self.me(token)
        self.assertEqual(status, 200)
        self.assertEqual(me.get("role"), "admin")
        self.assertEqual(me.get("username"), "admin")
        self.assertIs(me.get("must_change_password"), True)
        self.assertNotIn("session_token", me)
        self.assertEqual(me.get("protocol_version"), "1.0")

    def test_default_session_denied_reads_writes_and_model_test(self):
        token = self.login_token()
        blocked = [
            ("GET", "/api/v1/admin/summary", None),
            ("GET", "/api/v1/admin/shops", None),
            ("GET", "/api/v1/admin/events?limit=10", None),
            ("GET", "/api/v1/admin/model", None),
            ("PUT", "/api/v1/admin/model", {"version": 0, "primary": {}}),
            ("PUT", f"/api/v1/admin/shops/{SHOP_ID}/settings",
             {"enabled": True, "mode": "rules", "system_prompt": "虚拟", "rules": []}),
            ("POST", "/api/v1/admin/events/event-first-login/verify", {}),
            ("POST", "/api/v1/admin/model/test", {"slot": "primary", "version": 0}),
        ]
        before = self.account_row()
        before_events = self.server.store.events(None, 200)

        def refuse(*_args, **_kwargs):
            raise AssertionError("gated request reached business data or a provider")

        with mock.patch("backend.app.test_slot", side_effect=refuse) as test_slot, \
                mock.patch("backend.engine._post", side_effect=refuse) as provider_post, \
                mock.patch("backend.engine.test_slot", side_effect=refuse), \
                mock.patch.object(self.server.store, "summary", side_effect=refuse), \
                mock.patch.object(self.server.store, "shops", side_effect=refuse), \
                mock.patch.object(self.server.store, "events", side_effect=refuse), \
                mock.patch.object(self.server.store, "model_config", side_effect=refuse), \
                mock.patch.object(self.server.store, "update_model_config", side_effect=refuse), \
                mock.patch.object(self.server.store, "update_settings", side_effect=refuse), \
                mock.patch.object(self.server.store, "verify", side_effect=refuse), \
                mock.patch.object(self.server.store, "enqueue", side_effect=refuse), \
                mock.patch.object(self.server.store, "heartbeat", side_effect=refuse):
            for method, path, payload in blocked:
                with self.subTest(method=method, path=path):
                    self.assert_error(self.request(method, path, payload, token=token),
                                      403, "admin_password_change_required")
            # The gate fires before the request body is read or validated.
            self.assert_error(self.request("PUT", "/api/v1/admin/model", None, token=token), 403,
                              "admin_password_change_required")
            self.assert_error(self.request("POST", "/api/v1/admin/model/test", None,
                                           token=token, content_type=False), 403,
                              "admin_password_change_required")
            self.assert_error(self.request("POST", f"/api/v1/admin/shops/{SHOP_ID}/settings",
                                           None, token=token), 403,
                              "admin_password_change_required")
            self.assert_error(self.request("POST", "/api/v1/admin/model/test",
                                           {"slot": "primary", "version": 0},
                                           token=CLIENT_TOKEN), 403, "admin_required")
        # The provider and the business store were never invoked.
        self.assertEqual(test_slot.call_count, 0)
        self.assertEqual(provider_post.call_count, 0)

        # State is untouched and the pending-change flag still blocks.
        self.assertEqual(self.account_row(), before)
        self.assertEqual(self.server.store.events(None, 200), before_events)
        self.assertEqual(len(self.server.auth.sessions), 1)
        self.assertIs(self.server.auth.must_change_password, True)
        self.assert_error(self.request("GET", "/api/v1/admin/summary", token=token), 403,
                          "admin_password_change_required")
        self.assertEqual(self.me(token)[0], 200)

    def test_allowed_me_logout_and_password(self):
        token = self.login_token()
        second = self.login_token()

        status, body = self.request("POST", "/api/v1/admin/logout", {}, token=second)
        self.assertEqual(status, 200)
        self.assertIs(body.get("ok"), True)
        self.assert_error(self.me(second), 401, "unauthorized")
        self.assertEqual(len(self.server.auth.sessions), 1)

        # Refused changes leave the credential and the flag untouched.
        before = self.account_row()
        self.assert_error(self.change(token, current="wrong-default", new=NEW_PASSWORD),
                          403, "current_password_incorrect")
        self.assert_error(self.change(token, new="short7c"), 400, "invalid_new_password")
        self.assert_error(self.change(token, new=NEW_PASSWORD, confirm=NEW_PASSWORD + "-x"),
                          400, "password_mismatch")
        self.assert_error(self.change(token, new=INITIAL_PASSWORD, confirm=INITIAL_PASSWORD),
                          400, "invalid_new_password")
        self.assertEqual(self.account_row(), before)
        self.assertIs(self.server.auth.must_change_password, True)
        self.assertEqual(self.me(token)[0], 200)
        self.assert_error(self.request("GET", "/api/v1/admin/summary", token=token), 403,
                          "admin_password_change_required")

        # A successful change unlocks and revokes the current session.
        status, body = self.change(token)
        self.assertEqual(status, 200, msg=body)
        self.assertIs(body.get("ok"), True)
        self.assertIs(body.get("reauthenticate"), True)
        self.assertIs(self.server.auth.must_change_password, False)
        self.assertEqual(len(self.server.auth.sessions), 0)
        self.assert_error(self.me(token), 401, "unauthorized")

        fresh = self.login_token(password=NEW_PASSWORD)
        status, me = self.me(fresh)
        self.assertEqual(status, 200)
        self.assertIs(me.get("must_change_password"), False)
        self.assertEqual(self.request("GET", "/api/v1/admin/summary", token=fresh)[0], 200)
        # Reaching a route that needs a body still validates the body itself.
        self.assert_error(self.request("PUT", "/api/v1/admin/model", None, token=fresh),
                          415, "json_required")

    def test_password_change_revokes_every_session(self):
        tokens = [self.login_token() for _ in range(3)]
        self.assertEqual(len(set(tokens)), 3)
        self.assertEqual(len(self.server.auth.sessions), 3)

        self.assertEqual(self.change(tokens[0])[0], 200)
        self.assertEqual(len(self.server.auth.sessions), 0)
        for stale in tokens:
            self.assert_error(self.me(stale), 401, "unauthorized")
            self.assert_error(self.request("GET", "/api/v1/admin/summary", token=stale),
                              401, "unauthorized")
            self.assert_error(self.request("POST", "/api/v1/admin/password",
                                           {"current_password": NEW_PASSWORD,
                                            "new_password": SECOND_PASSWORD,
                                            "confirm_password": SECOND_PASSWORD}, token=stale),
                              401, "unauthorized")

        self.assert_error(self.request("POST", "/api/v1/admin/login",
                                       {"username": "admin", "password": INITIAL_PASSWORD}),
                          401, "invalid_credentials")
        self.assertIs(self.login(password=NEW_PASSWORD).get("must_change_password"), False)

        fresh = self.login_token(password=NEW_PASSWORD)
        self.assertEqual(self.change(fresh, current=NEW_PASSWORD, new=SECOND_PASSWORD)[0], 200)
        self.assertIs(self.server.auth.must_change_password, False)
        self.assert_error(self.request("GET", "/api/v1/admin/summary"), 401, "unauthorized")
        latest = self.login_token(password=SECOND_PASSWORD)
        self.assertEqual(self.request("GET", "/api/v1/admin/summary", token=latest)[0], 200)

    def test_old_default_database_forced_after_restart(self):
        token = self.login_token()
        self.restart_server()
        self.assertIs(self.server.auth.must_change_password, True)
        self.assert_error(self.me(token), 401, "unauthorized")

        new_token = self.login_token()
        self.assert_error(self.request("GET", "/api/v1/admin/summary", token=new_token),
                          403, "admin_password_change_required")
        self.assertIs(self.me(new_token)[1].get("must_change_password"), True)
        self.assertEqual(self.change(new_token)[0], 200)

        self.restart_server()
        self.assertIs(self.server.auth.must_change_password, False)
        unlocked = self.login_token(password=NEW_PASSWORD)
        self.assertIs(self.me(unlocked)[1].get("must_change_password"), False)
        self.assertEqual(self.request("GET", "/api/v1/admin/summary", token=unlocked)[0], 200)

    def test_existing_changed_password_database_not_forced(self):
        self.stop_server()
        self.write_account(PRE_EXISTING_PASSWORD)
        self.start_server()
        self.assertIs(self.server.auth.must_change_password, False)
        body = self.login(password=PRE_EXISTING_PASSWORD)
        self.assertIs(body.get("must_change_password"), False)
        token = body["session_token"]
        self.assertIs(self.me(token)[1].get("must_change_password"), False)
        self.assertEqual(self.request("GET", "/api/v1/admin/summary", token=token)[0], 200)

        self.restart_server()
        self.assertIs(self.server.auth.must_change_password, False)
        self.assertIs(self.login(password=PRE_EXISTING_PASSWORD).get("must_change_password"),
                      False)

    def test_client_and_legacy_tokens_unaffected(self):
        admin = self.login_token()
        self.assertIs(self.server.auth.must_change_password, True)
        heartbeat = {"instance_id": "instance-first-login", "session_id": "session-first-login"}

        status, body = self.request("POST", "/api/v1/heartbeat", heartbeat, token=CLIENT_TOKEN)
        self.assertEqual(status, 200, msg=body)
        status, me = self.me(CLIENT_TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual(me.get("role"), "client")
        self.assertNotIn("must_change_password", me)
        self.assert_error(self.request("GET", "/api/v1/admin/summary", token=CLIENT_TOKEN),
                          403, "admin_required")

        for path in ("/api/v1/me", "/api/v1/admin/summary"):
            self.assert_error(self.request("GET", path, token=LEGACY_ADMIN_TOKEN),
                              401, "unauthorized")
        self.assert_error(self.request("POST", "/api/v1/heartbeat", heartbeat,
                                       token=LEGACY_ADMIN_TOKEN), 401, "unauthorized")

        # The client keeps working while the administrator owes a change, and
        # after the change.
        self.assertIs(self.me(admin)[1].get("must_change_password"), True)
        self.assertEqual(self.request("POST", "/api/v1/heartbeat", heartbeat,
                                      token=CLIENT_TOKEN)[0], 200)
        self.assertEqual(self.change(admin)[0], 200)
        self.assertEqual(self.request("POST", "/api/v1/heartbeat", heartbeat,
                                      token=CLIENT_TOKEN)[0], 200)

    def test_failed_password_write_keeps_flag_and_sessions_consistent(self):
        token = self.login_token()
        before = self.account_row()

        # HTTP path: the persistence call raises, so the flag and every live
        # session stay as they were and the gate still applies.
        with tempfile.TemporaryDirectory(prefix="claw-next-auth-unit-") as other:
            auth = AdminAuth(other)
            try:
                login = auth.login({"username": "admin", "password": INITIAL_PASSWORD},
                                   "127.0.0.1")
                second = auth.login({"username": "admin", "password": INITIAL_PASSWORD},
                                    "127.0.0.1")
                self.assertIs(auth.must_change_password, True)
                self.assertEqual(len(auth.sessions), 2)
                closed = auth.db
                auth.db = mock.Mock(wraps=closed)
                auth.db.__enter__ = closed.__enter__
                auth.db.__exit__ = closed.__exit__
                auth.db.execute.side_effect = sqlite3.OperationalError("synthetic failure")
                payload = {"current_password": INITIAL_PASSWORD, "new_password": NEW_PASSWORD,
                           "confirm_password": NEW_PASSWORD}
                with self.assertRaises(sqlite3.DatabaseError):
                    auth.change_password(login["session_token"], payload, "127.0.0.1")
                auth.db = closed
                self.assertIs(auth.must_change_password, True)
                self.assertIs(auth.identity(login["session_token"])["must_change_password"], True)
                self.assertIn(auth._session_key(login["session_token"]), auth.sessions)
                self.assertIn(auth._session_key(second["session_token"]), auth.sessions)
                self.assertTrue(auth._matches(INITIAL_PASSWORD, auth._account()))
                # A successful retry clears the flag and revokes both sessions.
                auth.change_password(login["session_token"], payload, "127.0.0.1")
                self.assertIs(auth.must_change_password, False)
                self.assertEqual(len(auth.sessions), 0)
            finally:
                auth.close()

        # Real in-process SQLite failure: a trigger aborts the UPDATE.
        with tempfile.TemporaryDirectory(prefix="claw-next-auth-trigger-") as other:
            auth = AdminAuth(other)
            try:
                auth.db.execute("CREATE TRIGGER deny_update BEFORE UPDATE ON administrator "
                                "BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
                token_a = auth.login({"username": "admin", "password": INITIAL_PASSWORD},
                                     "127.0.0.1")["session_token"]
                payload = {"current_password": INITIAL_PASSWORD, "new_password": NEW_PASSWORD,
                           "confirm_password": NEW_PASSWORD}
                with self.assertRaises(sqlite3.DatabaseError):
                    auth.change_password(token_a, payload, "127.0.0.1")
                self.assertIs(auth.must_change_password, True)
                self.assertIn(auth._session_key(token_a), auth.sessions)
                self.assertTrue(auth._matches(INITIAL_PASSWORD, auth._account()))
            finally:
                auth.close()

        # The running server was unaffected by the synthetic failures.
        self.assertEqual(self.account_row(), before)
        self.assertIs(self.server.auth.must_change_password, True)
        self.assertEqual(len(self.server.auth.sessions), 1)
        self.assertIs(self.me(token)[1].get("must_change_password"), True)
        self.assert_error(self.request("GET", "/api/v1/admin/summary", token=token),
                          403, "admin_password_change_required")

        self.assertEqual(self.change(token)[0], 200)
        self.assertIs(self.server.auth.must_change_password, False)
        fresh = self.login_token(password=NEW_PASSWORD)
        self.assertEqual(self.request("GET", "/api/v1/admin/summary", token=fresh)[0], 200)

    def test_startup_still_rejects_malformed_administrator_row(self):
        self.stop_server()
        db = sqlite3.connect(str(pathlib.Path(self.data_dir) / "admin.sqlite3"))
        try:
            with db:
                db.execute("UPDATE administrator SET algorithm='plaintext' WHERE id=1")
        finally:
            db.close()
        with self.assertRaises(ApiError) as raised:
            create_server(test_config(), self.data_dir, port=0)
        self.assertEqual(raised.exception.code, "invalid_admin_database")
        db = sqlite3.connect(str(pathlib.Path(self.data_dir) / "admin.sqlite3"))
        try:
            with db:
                db.execute("UPDATE administrator SET algorithm='pbkdf2_sha256' WHERE id=1")
        finally:
            db.close()
        self.start_server()

    def test_only_salted_hash_is_persisted(self):
        password = "no-plaintext-" + secrets.token_hex(8)
        self.stop_server()
        self.write_account(password)
        self.start_server(config=test_config(admin_token=None))
        self.assertNotIn("admin_token", self.server.config)
        row = self.account_row()
        self.assertEqual(row["algorithm"], "pbkdf2_sha256")
        self.assertEqual(len(row["salt"]), 32)
        self.assertEqual(len(row["password_hash"]), 32)
        self.assertEqual(auth_module.password_hash(password, row["salt"]), row["password_hash"])
        raw = (pathlib.Path(self.data_dir) / "admin.sqlite3").read_bytes()
        self.assertNotIn(password.encode("utf-8"), raw)
        self.assertNotIn(password.encode("utf-16-le"), raw)
        seeded_auth = AdminAuth(self.data_dir)
        try:
            self.assertFalse(seeded_auth.must_change_password)
        finally:
            seeded_auth.close()
        with tempfile.TemporaryDirectory(prefix="claw-next-seed-") as empty:
            seeded = AdminAuth(empty)
            try:
                self.assertIs(seeded.must_change_password, True)
            finally:
                seeded.close()


if __name__ == "__main__":
    unittest.main()
