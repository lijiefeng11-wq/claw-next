"""Template administration through real local HTTP with fictional credentials."""
import copy
import unittest

import test_api_contract as api
from test_reply_templates import SHARED


class ReplyTemplateHttpTests(unittest.TestCase):
    def setUp(self):
        self.fx = api.ApiContractTestCase()
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)

    def call(self, method, path, body=None, status=200, token=None):
        return self.fx.assert_status(self.fx.request(method, path, body,
            token=self.fx.admin_token if token is None else token), status)

    def test_create_bind_edit_sync_and_detach_over_http(self):
        template = self.call("POST", "/api/v1/admin/reply-templates", {"name": "HTTP虚构模板", **SHARED}, 201)
        version = {}
        for shop, enabled in (("shop-a", True), ("shop-b", False)):
            saved = self.call("PUT", f"/api/v1/admin/shops/{shop}/settings", {
                "enabled": enabled, **SHARED, "fallback": {"error": {"action": "none" if enabled else "handoff"}},
                "template_id": template["template_id"], "template_version": 1})
            version[shop] = saved["version"]
        edited = self.call("PUT", "/api/v1/admin/shops/shop-a/settings", {
            "enabled": True, **SHARED, "system_prompt": "同步后的话术", "template_id": template["template_id"], "template_version": 1})
        data = self.call("GET", "/api/v1/admin/shops")
        a, b = data["shops"]
        self.assertEqual(a["settings"]["system_prompt"], b["settings"]["system_prompt"])
        self.assertFalse(b["settings"]["enabled"])
        self.assertEqual(b["settings"]["fallback"]["error"], {"action": "handoff"})
        self.assertEqual(b["settings"]["version"], version["shop-b"] + 1)
        self.assertEqual(data["templates"][0]["version"], 2)
        self.assertEqual(edited["template_version"], 2)
        before = copy.deepcopy(data)
        self.call("PUT", "/api/v1/admin/shops/shop-b/settings", {**b["settings"], "template_version": 1}, 409)
        self.assertEqual(self.call("GET", "/api/v1/admin/shops"), before)
        detached = self.call("PUT", "/api/v1/admin/shops/shop-b/settings", {**b["settings"], "template_id": None, "template_version": None})
        self.assertNotIn("template_id", detached)
        self.assertEqual(detached["system_prompt"], "同步后的话术")

    def test_template_routes_require_admin_and_validate_shared_content(self):
        path = "/api/v1/admin/reply-templates"
        body = {"name": "虚构模板", **SHARED}
        self.fx.assert_status(self.fx.request("POST", path, body), 401)
        self.call("POST", path, body, 403, api.CLIENT_A_TOKEN)
        self.call("GET", "/api/v1/admin/shops", status=403, token=api.CLIENT_A_TOKEN)
        self.call("POST", path, {**body, "enabled": True}, 400)
        self.call("POST", path, body, 201)
        self.call("POST", path, body, 409)
        self.assertEqual(len(self.call("GET", "/api/v1/admin/shops")["templates"]), 1)
