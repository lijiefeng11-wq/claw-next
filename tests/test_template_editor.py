"""Independent template saves use fictional stores and local HTTP only."""
import copy
import tempfile
import unittest

from backend.store import ApiError, Store
import test_api_contract as api
from test_reply_templates import SHARED, SHOPS


class TemplateEditorStoreTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = Store(tmp.name, SHOPS)
        self.addCleanup(self.store.close)
        self.template = self.store.create_reply_template({"name": "虚构模板", **SHARED})

    def edit(self, template=None, **changes):
        t = template or self.template
        return self.store.update_reply_template(t["template_id"], {
            "name": t["name"], "version": t["version"], **copy.deepcopy(SHARED), **changes})

    def snapshot(self):
        return self.store.shops(), self.store.reply_templates()

    def test_unbound_template_update(self):
        before = self.store.shops()
        saved = self.edit(system_prompt="只修改独立模板")
        self.assertEqual(saved["version"], 2)
        self.assertEqual(self.store.reply_templates(), [saved])
        self.assertEqual(self.store.shops(), before)

    def test_sync_preserves_each_shop_local_settings(self):
        before = {}
        for shop in ("a", "b"):
            before[shop] = self.store.update_settings(shop, {
                "enabled": shop == "a", **SHARED,
                "fallback": {"error": {"action": "none" if shop == "a" else "handoff"}},
                "template_id": self.template["template_id"], "template_version": 1})
        saved = self.edit(system_prompt="两店同步的新提示词", rules=[])
        for shop in ("a", "b"):
            current = self.store._admin_settings(shop, self.store._settings(shop))
            self.assertEqual(current["system_prompt"], saved["system_prompt"])
            self.assertEqual(current["rules"], [])
            self.assertEqual(current["enabled"], before[shop]["enabled"])
            self.assertEqual(current["fallback"], before[shop]["fallback"])
            self.assertEqual(current["version"], before[shop]["version"] + 1)
            self.assertEqual(current["template_version"], 2)
        self.assertNotIn("fallback", saved)

    def test_noop_and_rename_versions(self):
        before = self.snapshot()
        self.assertEqual(self.edit(), self.template)
        self.assertEqual(self.snapshot(), before)
        renamed = self.edit(name="  新名称  ")
        self.assertEqual(renamed["name"], "新名称")
        self.assertEqual(renamed["version"], 2)
        self.assertEqual(self.store.shops(), before[0])
        self.assertEqual(self.edit(renamed), renamed)

    def test_stale_and_invalid_edits_are_atomic(self):
        saved = self.edit(system_prompt="新版本")
        self.store.create_reply_template({"name": "其他名称", **SHARED})
        before = self.snapshot()
        valid = {"name": saved["name"], "version": saved["version"], **SHARED}
        cases = [("template_changed", {**valid, "version": 1}),
                 ("template_name_exists", {**valid, "name": "其他名称"}),
                 ("invalid_template_name", {**valid, "name": " "}),
                 ("invalid_template", {**valid, "enabled": True}),
                 ("invalid_rule_contains", {**valid, "rules": [{"id": "r", "contains": "", "reply": "x"}]})]
        cases += [("invalid_template", {**valid, "version": v}) for v in (True, False, 0, -1, "2", 2.0, None)]
        for code, payload in cases:
            with self.subTest(code=code, payload=payload):
                with self.assertRaises(ApiError) as result:
                    self.store.update_reply_template(saved["template_id"], payload)
                self.assertEqual(result.exception.code, code)
                self.assertEqual(self.snapshot(), before)
        for value, code in [("not-a-template", "invalid_template"), ("0" * 32, "template_not_found")]:
            with self.assertRaises(ApiError) as result:
                self.store.update_reply_template(value, valid)
            self.assertEqual(result.exception.code, code)
            self.assertEqual(self.snapshot(), before)

    def test_sync_failure_rolls_back_all_rows(self):
        import sqlite3
        for shop in ("a", "b"):
            self.store.update_settings(shop, {"enabled": False, **SHARED,
                "template_id": self.template["template_id"], "template_version": 1})
        before = self.snapshot()
        self.store.db.execute("CREATE TRIGGER reject_b BEFORE UPDATE ON shops WHEN old.shop_id='b' "
                              "BEGIN SELECT RAISE(ABORT,'fictional failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.edit(system_prompt="不能只保存一半")
        self.assertEqual(self.snapshot(), before)


class TemplateEditorHttpTests(unittest.TestCase):
    def setUp(self):
        self.fx = api.ApiContractTestCase()
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)

    def call(self, method, path, body=None, status=200, token=None):
        return self.fx.assert_status(self.fx.request(method, path, body,
            token=self.fx.admin_token if token is None else token), status)

    def test_independent_save_authorization_and_version_over_http(self):
        template = self.call("POST", "/api/v1/admin/reply-templates", {"name": "HTTP模板", **SHARED}, 201)
        path = "/api/v1/admin/reply-templates/" + template["template_id"]
        body = {"name": template["name"], "version": 1, **SHARED, "system_prompt": "HTTP新提示词"}
        self.fx.assert_status(self.fx.request("PUT", path, body), 401)
        self.call("PUT", path, body, 403, api.CLIENT_A_TOKEN)
        saved = self.call("PUT", path, body)
        self.assertEqual(saved["version"], 2)
        self.assertEqual(saved["system_prompt"], body["system_prompt"])
        self.call("PUT", path, body, 409)
        self.assertEqual(self.call("GET", "/api/v1/admin/shops")["templates"], [saved])
