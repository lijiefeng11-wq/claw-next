"""Local shop enrollment over real loopback HTTP with fictional credentials."""
import concurrent.futures
import json
import pathlib
import sys
import threading
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from backend.app import Handler, create_server
import test_handoff_http as handoff

BASE = "/api/v1/admin/handoff/shops"
TOKEN = "s" * 43


class LocalShopHttpTests(unittest.TestCase):
    setUp = handoff.HandoffHttpTests.setUp
    stop = handoff.HandoffHttpTests.stop
    request = handoff.HandoffHttpTests.request
    ready = handoff.HandoffHttpTests.ready
    assert_error = handoff.HandoffHttpTests.assert_error

    def payload(self):
        return {"shop_id": "new-fictional-shop", "name": "新虚构店铺", "client_id": "new-fictional-client", "client_token": TOKEN}

    def grant(self):
        self.admin = self.ready()
        return self.request("POST", "/api/v1/admin/handoff/grants", {}, self.admin)[1]

    def test_new_shop_is_visible_default_off_and_only_has_client_permissions(self):
        grant = self.grant()
        status, result, headers = self.request("POST", BASE, self.payload(), grant["grant_token"])
        self.assertEqual(status, 200)
        self.assertEqual(result, {"shop_id": "new-fictional-shop", "name": "新虚构店铺", "client_id": "new-fictional-client", "created": True, "protocol_version": "1.0"})
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn(TOKEN, json.dumps(result))
        shops = self.request("GET", "/api/v1/admin/shops", token=self.admin)[1]["shops"]
        added = next(shop for shop in shops if shop["shop_id"] == result["shop_id"])
        self.assertIs(added["settings"]["enabled"], False)
        identity = self.request("GET", "/api/v1/me", token=TOKEN)
        self.assertEqual(identity[0], 200)
        self.assertEqual(identity[1]["shop_id"], result["shop_id"])
        self.assertEqual(identity[1]["client_id"], result["client_id"])
        self.assert_error(self.request("GET", "/api/v1/admin/shops", token=TOKEN), 403, "admin_required")
        self.assert_error(self.request("POST", BASE, self.payload(), TOKEN), 401, "invalid_handoff_grant")

    def test_wrong_credential_classes_and_revoked_grant_cannot_add_shop(self):
        grant = self.grant()
        for credential in (None, handoff.CLIENT_TOKEN, self.admin, "invalid"):
            self.assert_error(self.request("POST", BASE, self.payload(), credential), 401, "invalid_handoff_grant")
        self.request("DELETE", "/api/v1/admin/handoff/grants/" + grant["grant_id"], token=self.admin)
        self.assert_error(self.request("POST", BASE, self.payload(), grant["grant_token"]), 401, "invalid_handoff_grant")
        self.assertEqual(len(self.server.store.shops()), 1)

    def test_admin_and_grant_credentials_cannot_become_shop_credentials(self):
        grant = self.grant()
        for credential in (grant["grant_token"], self.admin):
            result = self.request("POST", BASE, {**self.payload(), "client_token": credential}, grant["grant_token"])
            self.assert_error(result, 409, "client_registration_conflict")
            self.assertNotIn(credential, json.dumps(result[1]))
        self.assertEqual(len(self.server.store.shops()), 1)

    def test_nonlocal_peer_and_proxy_headers_do_not_authorize_registration(self):
        grant = self.grant()
        original = Handler._require_local_handoff
        def remote_peer(handler):
            return original(SimpleNamespace(client_address=("192.0.2.10", 1234), headers=handler.headers))
        with mock.patch.object(Handler, "_require_local_handoff", remote_peer):
            result = self.request("POST", BASE, self.payload(), grant["grant_token"], {"X-Forwarded-For": "127.0.0.1"})
        self.assert_error(result, 403, "local_only")
        self.assertEqual(len(self.server.store.shops()), 1)

    def test_restart_preserves_enrolled_identity_and_shop(self):
        grant = self.grant()
        self.assertEqual(self.request("POST", BASE, self.payload(), grant["grant_token"])[0], 200)
        config = self.server.config
        self.stop()
        self.server = create_server(config, self.tmp.name, host="127.0.0.1", port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.assertEqual(self.request("GET", "/api/v1/me", token=TOKEN)[0], 200)
        status, result, _ = self.request("POST", BASE, self.payload(), grant["grant_token"])
        self.assertEqual(status, 200)
        self.assertIs(result["created"], False)
        self.assertIn("new-fictional-shop", {shop["shop_id"] for shop in self.server.store.shops()})

    def test_concurrent_exact_registration_is_idempotent(self):
        grant = self.grant()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(lambda _: self.request("POST", BASE, self.payload(), grant["grant_token"]), range(4)))
        self.assertTrue(all(result[0] == 200 for result in results))
        self.assertEqual(sum(result[1]["created"] for result in results), 1)
        self.assertEqual(len(self.server.store.shops()), 2)
