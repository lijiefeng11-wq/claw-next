"""Real-HTTP authentication regression tests for the Claw-Next admin surface.

Every test drives a real loopback ``ThreadingHTTPServer`` built with the
documented ``create_server`` factory and an isolated
``tempfile.TemporaryDirectory`` data directory.  Administrator credentials,
session tokens, shops and clients are entirely fictional.  No external
network, legacy Claw process, production configuration or real data is used.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import pathlib
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest import mock

# Make ``python -m unittest discover -s tests`` work regardless of the
# directory from which discovery is invoked.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from backend.app import create_server  # noqa: E402  (documented server factory)
from backend.auth import ITERATIONS, SESSION_SECONDS  # noqa: E402
from backend.store import ApiError  # noqa: E402

ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "admin"
NEW_PASSWORD = "synthetic-new-pass-2026"
BACK_PASSWORD = "synthetic-back-pass-2026"
UNICODE_PASSWORD = "虚构-重设-密码-42"

# Legacy configuration value: accepted by the config validator as a reserved
# string, but it must never authenticate anything.
LEGACY_ADMIN_TOKEN = "l" * 40
CLIENT_TOKEN = "c" * 40
SHOP_ID = "shop-auth"
CLIENT_ID = "client-auth"


def test_config(admin_token=LEGACY_ADMIN_TOKEN):
    """Synthetic configuration; ``admin_token`` is only a legacy value."""
    config = {
        "shops": [{"shop_id": SHOP_ID, "name": "虚构认证测试店"}],
        "clients": [
            {"client_id": CLIENT_ID, "shop_id": SHOP_ID, "token": CLIENT_TOKEN}
        ],
    }
    if admin_token is not None:
        config["admin_token"] = admin_token
    return config


class FakeClock:
    """Deterministic stand-in for the ``time`` module used by ``backend.auth``.

    Replacing the module reference (rather than ``time.time`` globally) keeps
    the store, the HTTP server and the test process on the real clock, so
    eight-hour expiry and throttling can be exercised without sleeping.
    """

    def __init__(self, now):
        self.now = float(now)

    def time(self):
        return self.now


class AuthTestCase(unittest.TestCase):
    """Fixture: one real HTTP server, restarted in place when needed."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory(prefix="claw-next-auth-")
        self.addCleanup(self._tmpdir.cleanup)
        self.data_dir = self._tmpdir.name
        self._servers = []
        self.start_server()
        self.addCleanup(self._stop_all_servers)

    # ------------------------------------------------------------------
    # Server fixture helpers
    # ------------------------------------------------------------------
    def start_server(self, config=None):
        server = create_server(
            copy.deepcopy(test_config() if config is None else config),
            self.data_dir,
            host="127.0.0.1",
            port=0,
        )
        thread = threading.Thread(
            target=server.serve_forever, name="claw-next-auth-server", daemon=True
        )
        thread.start()
        self._servers.append((server, thread))
        self.server, self.port = server, server.server_address[1]
        self.base_url = f"http://127.0.0.1:{self.port}"
        return server

    def stop_server(self):
        server, thread = self._servers.pop()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive(), "server thread did not stop")
        return server

    def _stop_all_servers(self):
        while self._servers:
            self.stop_server()

    def restart_server(self, config=None):
        """Stop the server and reopen the same data directory."""
        self.stop_server()
        return self.start_server(config)

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------
    def request(self, method, path, body=None, token=None, raw=None,
                content_type="application/json"):
        if raw is not None:
            data = raw
        elif body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        else:
            data = None

        request = urllib.request.Request(self.base_url + path, data=data,
                                         method=method)
        if data is not None and content_type is not None:
            request.add_header("Content-Type", content_type)
        if token is not None:
            request.add_header("Authorization", f"Bearer {token}")

        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                status, payload = response.status, response.read()
        except urllib.error.HTTPError as exc:
            status, payload = exc.code, exc.read()

        decoded = None
        if payload:
            try:
                decoded = json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                decoded = None
        return status, decoded

    def assert_status(self, result, expected):
        status, body = result
        self.assertEqual(
            status, expected, msg=f"unexpected HTTP {status}, body={body!r}"
        )
        return body

    def assert_error_code(self, result, expected_status, expected_code):
        body = self.assert_status(result, expected_status)
        self.assertIsInstance(body, dict, msg=f"not a JSON object: {body!r}")
        error = body.get("error")
        self.assertIsInstance(error, dict, msg=f"missing error envelope: {body!r}")
        self.assertEqual(error.get("code"), expected_code, msg=body)
        self.assertIsInstance(error.get("message"), str)
        return error

    # ------------------------------------------------------------------
    # Authentication helpers
    # ------------------------------------------------------------------
    def login(self, username=ADMIN_USERNAME, password=ADMIN_PASSWORD):
        return self.request(
            "POST",
            "/api/v1/admin/login",
            {"username": username, "password": password},
        )

    def login_ok(self, username=ADMIN_USERNAME, password=ADMIN_PASSWORD):
        body = self.assert_status(self.login(username=username, password=password), 200)
        self.assertEqual(body.get("role"), "admin")
        self.assertEqual(body.get("username"), ADMIN_USERNAME)
        self.assertEqual(body.get("protocol_version"), "1.0")
        token = body.get("session_token")
        self.assertIsInstance(token, str)
        self.assertTrue(token)
        self.assertIsInstance(body.get("expires_at"), float)
        return token, body

    def me(self, token):
        return self.request("GET", "/api/v1/me", token=token)

    def change_password(self, token, current, new, confirm=None):
        return self.request(
            "POST",
            "/api/v1/admin/password",
            {
                "current_password": current,
                "new_password": new,
                "confirm_password": new if confirm is None else confirm,
            },
            token=token,
        )

    def account_row(self):
        """Read the administrator row straight from the SQLite file."""
        db = sqlite3.connect(str(pathlib.Path(self.data_dir) / "admin.sqlite3"))
        try:
            db.row_factory = sqlite3.Row
            row = db.execute("SELECT * FROM administrator WHERE id=1").fetchone()
        finally:
            db.close()
        self.assertIsNotNone(row)
        return dict(row)

    # ------------------------------------------------------------------
    # Login behaviour
    # ------------------------------------------------------------------
    def test_default_login_returns_admin_session(self):
        started = time.time()
        token, body = self.login_ok()
        self.assertGreaterEqual(len(token), 32)
        self.assertEqual(SESSION_SECONDS, 8 * 60 * 60)
        self.assertAlmostEqual(body["expires_at"] - started, SESSION_SECONDS, delta=10)

        me = self.assert_status(self.me(token), 200)
        self.assertEqual(me.get("role"), "admin")
        self.assertEqual(me.get("protocol_version"), "1.0")

        self.assertIs(body["must_change_password"], True)
        self.assertIs(me["must_change_password"], True)
        self.assert_error_code(
            self.request("GET", "/api/v1/admin/summary", token=token),
            403, "admin_password_change_required",
        )

        # Two logins yield two independent live sessions.
        second_token, _ = self.login_ok()
        self.assertNotEqual(token, second_token)
        for live in (token, second_token):
            self.assert_status(self.me(live), 200)

    def test_invalid_credentials_are_rejected(self):
        cases = [
            ("admin", "wrong-password"),
            ("administrator", ADMIN_PASSWORD),
            ("Admin", ADMIN_PASSWORD),
            ("管理员", ADMIN_PASSWORD),
            (ADMIN_USERNAME, "密碼錯誤"),
            (ADMIN_USERNAME, "admin "),
        ]
        for username, password in cases:
            with self.subTest(username=username, password=password):
                self.assert_error_code(
                    self.login(username=username, password=password),
                    401,
                    "invalid_credentials",
                )

        # No session is created by a failed login.
        self.assertEqual(len(self.server.auth.sessions), 0)
        self.assert_error_code(self.me("unknown-token"), 401, "unauthorized")

        # A later valid login still succeeds and clears the failure count.
        self.login_ok()
        self.assertEqual(len(self.server.auth.sessions), 1)

    def test_malformed_login_requests_are_rejected(self):
        # Missing / wrong request framing.
        self.assert_error_code(
            self.request("POST", "/api/v1/admin/login"), 415, "json_required"
        )
        self.assert_error_code(
            self.request(
                "POST",
                "/api/v1/admin/login",
                raw=b'{"username":"admin","password":"admin"}',
                content_type="text/plain",
            ),
            415,
            "json_required",
        )
        self.assert_error_code(
            self.request(
                "POST",
                "/api/v1/admin/login",
                raw=b"",
                content_type="application/json",
            ),
            400,
            "body_required",
        )

        # Broken or non-object JSON documents.
        for raw in (
            b"{not valid json",
            b'{"username":"admin","password":"admin"',
            b"[]",
            b'"admin"',
            b"null",
            # duplicate keys are rejected instead of silently merged
            b'{"username":"admin","username":"root","password":"admin"}',
            # non-finite numbers are not valid JSON
            b'{"username":"admin","password":NaN}',
            # invalid UTF-8 inside the document
            b'{"username":"admin","password":"\xff\xfe"}',
        ):
            with self.subTest(raw=raw):
                self.assert_error_code(
                    self.request("POST", "/api/v1/admin/login", raw=raw),
                    400,
                    "invalid_json" if raw not in (b"[]", b'"admin"', b"null")
                    else "object_required",
                )

        # Wrong value types / lengths, including Unicode values.
        type_cases = [
            ({"username": 123, "password": ADMIN_PASSWORD}, 400, "invalid_login"),
            ({"username": ["admin"], "password": ADMIN_PASSWORD}, 400, "invalid_login"),
            ({"username": "", "password": ADMIN_PASSWORD}, 400, "invalid_login"),
            ({"username": "a" * 129, "password": ADMIN_PASSWORD}, 400, "invalid_login"),
            ({"username": None, "password": ADMIN_PASSWORD}, 400, "invalid_login"),
            ({"password": ADMIN_PASSWORD}, 400, "invalid_login"),
            ({"username": ADMIN_PASSWORD}, 400, "invalid_password_request"),
            ({"username": ADMIN_USERNAME, "password": 12345}, 400,
             "invalid_password_request"),
            ({"username": ADMIN_USERNAME, "password": None}, 400,
             "invalid_password_request"),
            ({"username": ADMIN_USERNAME, "password": ""}, 400,
             "invalid_password_request"),
            ({"username": ADMIN_USERNAME, "password": "x" * 129}, 400,
             "invalid_password_request"),
            ({"username": ADMIN_USERNAME, "password": {"value": "admin"}}, 400,
             "invalid_password_request"),
        ]
        for payload, status, code in type_cases:
            with self.subTest(payload=payload):
                self.assert_error_code(
                    self.request("POST", "/api/v1/admin/login", payload),
                    status,
                    code,
                )

        # Still no session, and the real credentials work with Unicode extras.
        self.assertEqual(len(self.server.auth.sessions), 0)
        body = self.assert_status(
            self.request(
                "POST",
                "/api/v1/admin/login",
                {
                    "username": ADMIN_USERNAME,
                    "password": ADMIN_PASSWORD,
                    "note": "虚构-测试-备注",
                    "nested": {"why": "认证回归"},
                },
            ),
            200,
        )
        self.assertIn("session_token", body)

    # ------------------------------------------------------------------
    # Authorization boundaries
    # ------------------------------------------------------------------
    def test_admin_endpoints_reject_missing_or_unknown_session(self):
        protected = [
            ("GET", "/api/v1/admin/summary"),
            ("GET", "/api/v1/admin/shops"),
            ("GET", "/api/v1/admin/events?limit=10"),
            ("POST", "/api/v1/admin/password"),
            ("POST", "/api/v1/admin/logout"),
        ]
        for method, path in protected:
            body = {
                "current_password": ADMIN_PASSWORD,
                "new_password": NEW_PASSWORD,
                "confirm_password": NEW_PASSWORD,
            } if method == "POST" else None
            for token in (None, "", "z" * 40, LEGACY_ADMIN_TOKEN):
                with self.subTest(method=method, path=path, token=token):
                    self.assert_error_code(
                        self.request(method, path, body, token=token),
                        401,
                        "unauthorized",
                    )

        # The denied password change did not modify credentials.
        self.login_ok()

    def test_client_token_cannot_manage_admin_surface(self):
        attempts = [
            ("GET", "/api/v1/admin/summary", None),
            ("GET", "/api/v1/admin/shops", None),
            ("GET", "/api/v1/admin/events?limit=10", None),
            (
                "PUT",
                f"/api/v1/admin/shops/{SHOP_ID}/settings",
                {"enabled": True, "mode": "rules", "system_prompt": "", "rules": []},
            ),
            (
                "POST",
                "/api/v1/admin/password",
                {
                    "current_password": ADMIN_PASSWORD,
                    "new_password": NEW_PASSWORD,
                    "confirm_password": NEW_PASSWORD,
                },
            ),
            ("POST", "/api/v1/admin/logout", {}),
        ]
        for method, path, body in attempts:
            with self.subTest(method=method, path=path):
                self.assert_error_code(
                    self.request(method, path, body, token=CLIENT_TOKEN),
                    403,
                    "admin_required",
                )

        # Client credentials never touch the administrator database.
        before = self.account_row()
        self.login_ok()
        self.assertEqual(self.account_row(), before)

        # The client token still works for its own scoped client API.
        self.assert_status(
            self.request(
                "POST",
                "/api/v1/heartbeat",
                {"instance_id": "instance-client", "session_id": "session-client"},
                token=CLIENT_TOKEN,
            ),
            200,
        )

    def test_admin_session_cannot_use_client_api(self):
        token, _ = self.login_ok()
        self.assert_error_code(
            self.request(
                "POST",
                "/api/v1/heartbeat",
                {"instance_id": "instance-admin", "session_id": "session-admin"},
                token=token,
            ),
            403,
            "client_required",
        )
        self.assert_error_code(
            self.request("GET", "/api/v1/events/event-auth", token=token),
            403,
            "client_required",
        )
        self.assert_error_code(
            self.request(
                "POST",
                "/api/v1/events",
                {"event_id": "event-auth"},
                token=token,
            ),
            403,
            "client_required",
        )

        # The legacy config token is not a client credential either.
        self.assert_error_code(
            self.request(
                "POST",
                "/api/v1/heartbeat",
                {"instance_id": "instance-legacy", "session_id": "session-legacy"},
                token=LEGACY_ADMIN_TOKEN,
            ),
            401,
            "unauthorized",
        )
        # ... while the real client token remains usable in its own shop.
        self.assert_status(
            self.request(
                "POST",
                "/api/v1/heartbeat",
                {"instance_id": "instance-client", "session_id": "session-client"},
                token=CLIENT_TOKEN,
            ),
            200,
        )

    def test_legacy_admin_token_rejected_before_and_after_password_change(self):
        self.assertEqual(self.server.config["admin_token"], LEGACY_ADMIN_TOKEN)

        def assert_legacy_inert():
            for path in ("/api/v1/me", "/api/v1/admin/summary",
                         "/api/v1/admin/shops", "/api/v1/admin/events"):
                with self.subTest(path=path):
                    self.assert_error_code(
                        self.request("GET", path, token=LEGACY_ADMIN_TOKEN),
                        401,
                        "unauthorized",
                    )
            self.assert_error_code(
                self.request(
                    "POST",
                    "/api/v1/admin/password",
                    {
                        "current_password": ADMIN_PASSWORD,
                        "new_password": NEW_PASSWORD,
                        "confirm_password": NEW_PASSWORD,
                    },
                    token=LEGACY_ADMIN_TOKEN,
                ),
                401,
                "unauthorized",
            )

        before = self.account_row()
        assert_legacy_inert()

        token, _ = self.login_ok()
        self.assert_status(self.change_password(token, ADMIN_PASSWORD, NEW_PASSWORD), 200)
        self.assertNotEqual(self.account_row(), before)

        assert_legacy_inert()
        # The legacy value is still not a client credential after the change.
        self.assert_error_code(
            self.request(
                "POST",
                "/api/v1/heartbeat",
                {"instance_id": "instance-legacy", "session_id": "session-legacy"},
                token=LEGACY_ADMIN_TOKEN,
            ),
            401,
            "unauthorized",
        )
        self.login_ok(password=NEW_PASSWORD)

    # ------------------------------------------------------------------
    # Password change validation
    # ------------------------------------------------------------------
    def test_password_change_validation_failures_do_not_change_state(self):
        token, _ = self.login_ok()
        before = self.account_row()
        cases = [
            (
                {"current_password": "wrong-current", "new_password": NEW_PASSWORD,
                 "confirm_password": NEW_PASSWORD},
                403,
                "current_password_incorrect",
            ),
            (
                {"current_password": "密码错误", "new_password": NEW_PASSWORD,
                 "confirm_password": NEW_PASSWORD},
                403,
                "current_password_incorrect",
            ),
            (
                {"current_password": ADMIN_PASSWORD, "new_password": NEW_PASSWORD,
                 "confirm_password": NEW_PASSWORD + "-different"},
                400,
                "password_mismatch",
            ),
            (
                {"current_password": ADMIN_PASSWORD, "new_password": "short7c",
                 "confirm_password": "short7c"},
                400,
                "invalid_new_password",
            ),
            (
                {"current_password": ADMIN_PASSWORD, "new_password": "中文密码",
                 "confirm_password": "中文密码"},
                400,
                "invalid_new_password",
            ),
            (
                {"current_password": ADMIN_PASSWORD, "new_password": "x" * 129,
                 "confirm_password": "x" * 129},
                400,
                "invalid_password_request",
            ),
            (
                # The 5 character default is weak; the length rule is applied
                # before the unchanged-password rule.
                {"current_password": ADMIN_PASSWORD, "new_password": ADMIN_PASSWORD,
                 "confirm_password": ADMIN_PASSWORD},
                400,
                "invalid_new_password",
            ),
            (
                {"current_password": ADMIN_PASSWORD, "new_password": 12345678,
                 "confirm_password": 12345678},
                400,
                "invalid_password_request",
            ),
            (
                {"current_password": ADMIN_PASSWORD, "new_password": None,
                 "confirm_password": None},
                400,
                "invalid_password_request",
            ),
            (
                {"current_password": ADMIN_PASSWORD, "new_password": NEW_PASSWORD},
                400,
                "invalid_password_request",
            ),
        ]
        for payload, status, code in cases:
            with self.subTest(payload=payload):
                self.assert_error_code(
                    self.request("POST", "/api/v1/admin/password", payload, token=token),
                    status,
                    code,
                )
                # Nothing changed: hash, salt, iterations and live sessions stay put.
                self.assertEqual(self.account_row(), before)
                self.assert_status(self.me(token), 200)
                self.assert_error_code(
                    self.request("GET", "/api/v1/admin/summary", token=token),
                    403, "admin_password_change_required",
                )

        # The original password still works and the session was never revoked.
        self.login_ok()
        self.assertEqual(self.account_row(), before)
        self.assert_status(self.me(token), 200)

        # Reusing the current password is refused once it is strong enough, and
        # that refusal also leaves the hash and live sessions untouched.
        self.assert_status(self.change_password(token, ADMIN_PASSWORD, NEW_PASSWORD), 200)
        fresh_token, _ = self.login_ok(password=NEW_PASSWORD)
        after_change = self.account_row()
        self.assert_error_code(
            self.change_password(fresh_token, NEW_PASSWORD, NEW_PASSWORD),
            400,
            "password_unchanged",
        )
        self.assertEqual(self.account_row(), after_change)
        self.assert_status(self.me(fresh_token), 200)
        self.assert_status(
            self.request("GET", "/api/v1/admin/summary", token=fresh_token), 200
        )

    def test_password_change_revokes_all_prior_sessions(self):
        token_one, first = self.login_ok()
        token_two, second = self.login_ok()
        self.assertNotEqual(token_one, token_two)
        self.assertEqual(len(self.server.auth.sessions), 2)

        body = self.assert_status(
            self.change_password(token_one, ADMIN_PASSWORD, NEW_PASSWORD), 200
        )
        self.assertIs(body.get("ok"), True)
        self.assertIs(body.get("reauthenticate"), True)

        # Both earlier sessions are revoked.
        self.assertEqual(len(self.server.auth.sessions), 0)
        for stale in (token_one, token_two):
            with self.subTest(token=stale[:6]):
                self.assert_error_code(self.me(stale), 401, "unauthorized")
                self.assert_error_code(
                    self.request("GET", "/api/v1/admin/summary", token=stale),
                    401,
                    "unauthorized",
                )
                self.assert_error_code(
                    self.request("POST", "/api/v1/admin/logout", {}, token=stale),
                    401,
                    "unauthorized",
                )
                self.assert_error_code(
                    self.change_password(stale, NEW_PASSWORD, ADMIN_PASSWORD),
                    401,
                    "unauthorized",
                )

        # Old password no longer authenticates; the new one does.
        self.assert_error_code(self.login(), 401, "invalid_credentials")
        fresh, _ = self.login_ok(password=NEW_PASSWORD)
        self.assertNotIn(fresh, (token_one, token_two))
        self.assert_status(self.request("GET", "/api/v1/admin/summary", token=fresh), 200)

        # And the change can be performed again with the new credentials.
        self.assert_status(self.change_password(fresh, NEW_PASSWORD, BACK_PASSWORD), 200)
        self.login_ok(password=BACK_PASSWORD)

    def test_logout_revokes_only_current_token(self):
        token_one, _ = self.login_ok()
        token_two, _ = self.login_ok()
        self.assertNotEqual(token_one, token_two)

        body = self.assert_status(
            self.request("POST", "/api/v1/admin/logout", {}, token=token_one), 200
        )
        self.assertIs(body.get("ok"), True)

        self.assert_error_code(self.me(token_one), 401, "unauthorized")
        self.assert_error_code(
            self.request("POST", "/api/v1/admin/logout", {}, token=token_one),
            401,
            "unauthorized",
        )
        # The other session is untouched, but still requires initial password setup.
        self.assert_status(self.me(token_two), 200)
        self.assert_error_code(
            self.request("GET", "/api/v1/admin/summary", token=token_two),
            403, "admin_password_change_required",
        )
        self.assertEqual(len(self.server.auth.sessions), 1)

        self.assert_status(self.change_password(token_two, ADMIN_PASSWORD, NEW_PASSWORD), 200)
        self.login_ok(password=NEW_PASSWORD)

    # ------------------------------------------------------------------
    # Session lifetime
    # ------------------------------------------------------------------
    def test_session_expires_after_eight_hours(self):
        token, body = self.login_ok()
        expires_at = body["expires_at"]
        self.assertAlmostEqual(expires_at - time.time(), SESSION_SECONDS, delta=10)

        clock = FakeClock(expires_at - 1)
        with mock.patch("backend.auth.time", clock):
            self.assert_status(self.me(token), 200)
            self.assert_error_code(
                self.request("GET", "/api/v1/admin/summary", token=token),
                403, "admin_password_change_required",
            )

            # Exactly at the 8 hour mark the session is no longer valid.
            clock.now = expires_at
            self.assert_error_code(self.me(token), 401, "unauthorized")
            self.assert_error_code(
                self.request("GET", "/api/v1/admin/summary", token=token),
                401,
                "unauthorized",
            )
            self.assert_error_code(
                self.request("POST", "/api/v1/admin/logout", {}, token=token),
                401,
                "unauthorized",
            )

            # A fresh session is stamped from the same clock and lasts 8 hours.
            fresh_body = self.assert_status(self.login(), 200)
            self.assertEqual(fresh_body["expires_at"], clock.now + SESSION_SECONDS)
            fresh = fresh_body["session_token"]
            self.assert_status(self.me(fresh), 200)

            clock.now = expires_at + SESSION_SECONDS
            self.assert_error_code(self.me(fresh), 401, "unauthorized")
            clock.now = expires_at + SESSION_SECONDS - 1
            self.assert_status(self.me(fresh), 200)

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------
    def test_restart_persists_password_and_revokes_sessions(self):
        token, _ = self.login_ok()
        self.assert_status(
            self.change_password(token, ADMIN_PASSWORD, UNICODE_PASSWORD), 200
        )
        after_change = self.account_row()
        self.assert_error_code(self.me(token), 401, "unauthorized")

        self.restart_server()
        self.assertEqual(len(self.server.auth.sessions), 0)
        self.assertEqual(self.account_row(), after_change)
        self.assert_error_code(self.me(token), 401, "unauthorized")
        self.assert_error_code(
            self.request("GET", "/api/v1/admin/summary", token=token), 401, "unauthorized"
        )
        self.assert_error_code(self.login(), 401, "invalid_credentials")

        new_token, _ = self.login_ok(password=UNICODE_PASSWORD)
        self.assert_status(
            self.request("GET", "/api/v1/admin/summary", token=new_token), 200
        )

        # A second reopen still does not reset the account or revive sessions.
        self.restart_server()
        self.assertEqual(self.account_row(), after_change)
        self.assert_error_code(
            self.request("GET", "/api/v1/admin/summary", token=new_token),
            401,
            "unauthorized",
        )
        self.assert_error_code(self.login(), 401, "invalid_credentials")
        self.login_ok(password=UNICODE_PASSWORD)

    def test_database_stores_salted_hash_not_plaintext(self):
        row = self.account_row()
        self.assertEqual(row["username"], ADMIN_USERNAME)
        self.assertEqual(row["algorithm"], "pbkdf2_sha256")
        self.assertEqual(row["iterations"], ITERATIONS)
        self.assertEqual(len(row["salt"]), 32)
        self.assertEqual(len(row["password_hash"]), 32)
        # Independent PBKDF2 recomputation, not the helper under test.
        self.assertEqual(
            hashlib.pbkdf2_hmac(
                "sha256", ADMIN_PASSWORD.encode("utf-8"), row["salt"],
                row["iterations"],
            ),
            row["password_hash"],
        )

        token, body = self.login_ok()
        self.assert_status(
            self.change_password(token, ADMIN_PASSWORD, UNICODE_PASSWORD), 200
        )
        second = self.account_row()
        self.assertNotEqual(second["salt"], row["salt"])
        self.assertNotEqual(second["password_hash"], row["password_hash"])
        self.assertEqual(
            hashlib.pbkdf2_hmac(
                "sha256", UNICODE_PASSWORD.encode("utf-8"), second["salt"],
                second["iterations"],
            ),
            second["password_hash"],
        )

        database = pathlib.Path(self.data_dir) / "admin.sqlite3"
        raw = database.read_bytes()
        # Neither the password nor the live session token is stored in clear.
        for secret in (UNICODE_PASSWORD, NEW_PASSWORD, body["session_token"]):
            self.assertNotIn(secret.encode("utf-8"), raw)
        self.assertNotIn(UNICODE_PASSWORD.encode("utf-16-le"), raw)
        self.assertNotIn(second["password_hash"].hex().encode("ascii"), raw)

        # A further change always uses a fresh random salt.
        fresh, _ = self.login_ok(password=UNICODE_PASSWORD)
        self.assert_status(
            self.change_password(fresh, UNICODE_PASSWORD, NEW_PASSWORD), 200
        )
        third = self.account_row()
        self.assertEqual(len(third["salt"]), 32)
        self.assertNotIn(third["salt"], (row["salt"], second["salt"]))
        self.assertNotEqual(third["password_hash"], second["password_hash"])
        self.assertNotIn(fresh.encode("utf-8"), database.read_bytes())

        self.assert_error_code(
            self.login(password=UNICODE_PASSWORD), 401, "invalid_credentials"
        )
        self.login_ok(password=NEW_PASSWORD)

    # ------------------------------------------------------------------
    # Configuration compatibility
    # ------------------------------------------------------------------
    def test_legacy_config_accepted_and_admin_token_optional(self):
        # A configuration carrying a legacy admin_token still starts, but the
        # value authenticates nothing.
        self.assertEqual(self.server.config["admin_token"], LEGACY_ADMIN_TOKEN)
        self.assert_error_code(self.me(LEGACY_ADMIN_TOKEN), 401, "unauthorized")
        self.login_ok()

        # A configuration without admin_token is equally accepted.
        self.restart_server(config=test_config(admin_token=None))
        self.assertNotIn("admin_token", self.server.config)
        token, _ = self.login_ok()
        self.assert_error_code(self.request("GET", "/api/v1/admin/summary", token=token),
                               403, "admin_password_change_required")
        # The retired value stays inert even though it is no longer configured.
        self.assert_error_code(
            self.request("GET", "/api/v1/admin/summary", token=LEGACY_ADMIN_TOKEN),
            401,
            "unauthorized",
        )

    def test_invalid_admin_token_configuration_is_rejected(self):
        for bad in (123, {}, ["x"], True, b"x"):
            with self.subTest(bad=bad):
                with self.assertRaises(ApiError) as raised:
                    create_server(test_config(admin_token=bad), self.data_dir, port=0)
                self.assertEqual(raised.exception.status, 400)
                self.assertEqual(raised.exception.code, "invalid_admin_token")

        # A legacy admin token may not collide with a client credential.
        with self.assertRaises(ApiError) as raised:
            create_server(test_config(admin_token=CLIENT_TOKEN), self.data_dir, port=0)
        self.assertEqual(raised.exception.status, 400)
        self.assertEqual(raised.exception.code, "invalid_client_token")

        # The running server was unaffected by the rejected constructions.
        self.login_ok()

    # ------------------------------------------------------------------
    # Throttling
    # ------------------------------------------------------------------
    def test_login_throttle_limits_repeated_failures(self):
        started = time.time()
        clock = FakeClock(started)
        with mock.patch("backend.auth.time", clock):
            for attempt in range(10):
                self.assert_error_code(
                    self.login(password=f"wrong-password-{attempt}"),
                    401,
                    "invalid_credentials",
                )
            # The eleventh attempt is refused even with the correct password.
            self.assert_error_code(self.login(), 429, "login_rate_limited")
            self.assert_error_code(
                self.login(password=NEW_PASSWORD), 429, "login_rate_limited"
            )
            self.assertEqual(len(self.server.auth.sessions), 0)

            # After the one-minute window the administrator can log in again.
            clock.now = started + 61
            token, _ = self.login_ok()
            self.assert_status(self.me(token), 200)

            # A successful login resets the counter for the next window.
            for attempt in range(3):
                self.assert_error_code(
                    self.login(password=f"still-wrong-{attempt}"),
                    401,
                    "invalid_credentials",
                )
            self.login_ok()


if __name__ == "__main__":
    unittest.main()
