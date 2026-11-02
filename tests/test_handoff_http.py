"""Real HTTP routes with fictional shops, passwords and isolated temporary data."""
import http.client
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from backend.app import Handler, create_server
from backend.store import ApiError

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = "/api/v1/admin/handoff"
CLIENT_TOKEN = "fictional-client-token-" + "x" * 32
PASSWORD = "fictional-http-handoff-password"


class HandoffHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="claw-handoff-http-")
        self.addCleanup(self.tmp.cleanup)
        self.server = create_server({"shops": [{"shop_id": "fictional-shop", "name": "虚构店铺"}],
            "clients": [{"client_id": "fictional-client", "shop_id": "fictional-shop", "token": CLIENT_TOKEN}]},
            self.tmp.name, host="127.0.0.1", port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        initial = self.request("POST", "/api/v1/admin/login", {"username": "admin", "password": "admin"})[1]
        self.initial = initial["session_token"]

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.assertFalse(self.thread.is_alive())

    def request(self, method, path, body=None, token=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)
        headers = dict(headers or {})
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        if body is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(body).encode()
        try:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read()), dict(response.getheaders())
        finally:
            connection.close()

    def ready(self):
        status, _, _ = self.request("POST", "/api/v1/admin/password", {
            "current_password": "admin", "new_password": PASSWORD, "confirm_password": PASSWORD}, self.initial)
        self.assertEqual(status, 200)
        status, data, _ = self.request("POST", "/api/v1/admin/login", {"username": "admin", "password": PASSWORD})
        self.assertEqual(status, 200)
        return data["session_token"]

    def assert_error(self, result, status, code):
        self.assertEqual(result[0], status)
        self.assertEqual(result[1]["error"]["code"], code)

    def test_full_grant_issue_redeem_flow_and_credential_separation(self):
        self.assert_error(self.request("POST", BASE + "/grants", {}, self.initial), 403, "admin_password_change_required")
        self.assert_error(self.request("POST", BASE + "/grants", {}, CLIENT_TOKEN), 403, "admin_required")
        admin = self.ready()
        status, grant, headers = self.request("POST", BASE + "/grants", {}, admin)
        self.assertEqual(status, 200)
        self.assertEqual(grant["protocol_version"], "1.0")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assert_error(self.request("GET", "/api/v1/me", token=grant["grant_token"]), 401, "unauthorized")
        self.assert_error(self.request("POST", "/api/v1/heartbeat", {}, grant["grant_token"]), 401, "unauthorized")
        for token in (None, CLIENT_TOKEN, admin):
            self.assert_error(self.request("POST", BASE, {}, token), 401, "invalid_handoff_grant")
        status, ticket, _ = self.request("POST", BASE, {}, grant["grant_token"])
        self.assertEqual(status, 200)
        self.assertEqual(set(ticket), {"ticket", "expires_at", "protocol_version"})
        status, session, _ = self.request("POST", BASE + "/redeem", {"ticket": ticket["ticket"]})
        self.assertEqual(status, 200)
        self.assertEqual(session["role"], "admin")
        self.assertIs(session["must_change_password"], False)
        self.assertEqual(self.request("GET", "/api/v1/admin/shops", token=session["session_token"])[0], 200)
        self.assert_error(self.request("POST", "/api/v1/heartbeat", {}, session["session_token"]), 403, "client_required")
        self.assert_error(self.request("POST", BASE + "/redeem", {"ticket": ticket["ticket"]}), 401, "invalid_handoff")
        listed = self.request("GET", BASE + "/grants", token=admin)[1]
        self.assertEqual(listed, {"grants": [{"grant_id": grant["grant_id"], "created_at": grant["created_at"]}],
                                 "protocol_version": "1.0"})
        self.assertEqual(self.request("DELETE", BASE + "/grants/" + grant["grant_id"], token=admin)[1]["ok"], True)
        self.assert_error(self.request("POST", BASE, {}, grant["grant_token"]), 401, "invalid_handoff_grant")

    def test_route_schemas_and_malformed_values_do_not_leak(self):
        admin = self.ready()
        self.assert_error(self.request("POST", BASE + "/grants", {"extra": 1}, admin), 400, "invalid_handoff_request")
        grant = self.request("POST", BASE + "/grants", {}, admin)[1]
        self.assert_error(self.request("POST", BASE, {"extra": 1}, grant["grant_token"]), 400, "invalid_handoff_request")
        for payload in ({}, {"ticket": 1}, {"ticket": "虚构secret"}, {"ticket": "a" * 43, "extra": 1}):
            result = self.request("POST", BASE + "/redeem", payload)
            self.assert_error(result, 401, "invalid_handoff")
            self.assertNotIn("secret", json.dumps(result[1]))
        self.assert_error(self.request("DELETE", BASE + "/grants/not-an-id", token=admin), 400, "invalid_handoff_request")
        self.assert_error(self.request("POST", BASE + "/grants", {}), 401, "unauthorized")
        self.assertEqual(self.server.auth.list_handoff_grants(admin)["grants"][0]["grant_id"], grant["grant_id"])

    def test_nonlocal_peer_rejected_before_reading_body_or_credentials(self):
        admin = self.ready()
        original = Handler._require_local_handoff
        # Only the peer supplied to the real gate is fictional; HTTP routing stays real.
        def remote_peer(handler):
            return original(SimpleNamespace(client_address=("192.0.2.10", 1234), headers=handler.headers))
        with mock.patch.object(Handler, "_require_local_handoff", remote_peer):
            for method, path, body in (("POST", BASE, {}), ("POST", BASE + "/redeem", {}),
                                       ("GET", BASE + "/grants", None), ("POST", BASE + "/grants", {}),
                                       ("DELETE", BASE + "/grants/" + "0" * 32, None)):
                self.assert_error(self.request(method, path, body, admin,
                    {"X-Forwarded-For": "127.0.0.1", "Forwarded": "for=127.0.0.1"}), 403, "local_only")
        original(SimpleNamespace(client_address=("::1", 1234)))
        self.assertEqual(self.server.auth.list_handoff_grants(admin), {"grants": []})


class HandoffUiTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node is required for the browser fixture")
    def test_actual_management_code_with_fictional_dom_and_responses(self):
        result = subprocess.run([shutil.which("node"), str(ROOT / "tests/admin_handoff_ui.cjs")],
            cwd=ROOT, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
