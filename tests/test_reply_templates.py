"""Shared reply content in a temporary Store; no model, platform or real shop."""
import copy
import json
import tempfile
import unittest

from backend.store import ApiError, Store

SHARED = {"mode": "hybrid", "system_prompt": "虚构提示词", "rules": [{"id": "r", "contains": "营业时间", "reply": "虚构营业时间"}]}
SHOPS = [{"shop_id": "a", "name": "虚构甲店"}, {"shop_id": "b", "name": "虚构乙店"}]


class ReplyTemplateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(self.tmp.name, SHOPS)
        self.addCleanup(lambda: self.store.close())

    def create(self, **changes):
        return self.store.create_reply_template({"name": "共用模板", **copy.deepcopy(SHARED), **changes})

    def bind(self, shop, template, **changes):
        return self.store.update_settings(shop, {"enabled": shop == "a", **copy.deepcopy(SHARED),
            "fallback": {"error": {"action": "none" if shop == "a" else "handoff"}},
            "template_id": template["template_id"], "template_version": template["version"], **changes})

    def code(self, code, callback):
        with self.assertRaises(ApiError) as result:
            callback()
        self.assertEqual(result.exception.code, code)

    def test_create_validates_and_has_no_store_switch_or_binding(self):
        before = self.store.shops()
        template = self.create(name="  示例模板  ")
        self.assertEqual(template["name"], "示例模板")
        self.assertEqual(set(template), {"template_id", "name", "version", *SHARED})
        self.assertEqual(template["version"], 1)
        self.assertEqual(self.store.reply_templates(), [template])
        self.assertEqual(self.store.shops(), before)
        for bad in ("", " " * 4, "x" * 81, False, []):
            self.code("invalid_template_name", lambda: self.create(name=bad))
        self.code("template_name_exists", lambda: self.create(name="示例模板"))
        self.code("invalid_template", lambda: self.create(enabled=True))
        self.code("invalid_rule_contains", lambda: self.create(rules=[{"id": "r", "contains": " ", "reply": "x"}]))

    def test_edit_syncs_all_bound_shops_preserving_local_switch_and_fallback(self):
        template = self.create()
        a = self.bind("a", template)
        b = self.bind("b", template)
        updated = self.bind("a", template, system_prompt="更新提示词", enabled=False,
                            rules=[{"id": "new", "contains": "规格", "reply": "请补充车型"}])
        other = self.store._settings("b")
        self.assertEqual(other["system_prompt"], "更新提示词")
        self.assertEqual(other["rules"], updated["rules"])
        self.assertFalse(other["enabled"])
        self.assertEqual(other["fallback"], b["fallback"])
        self.assertEqual(other["version"], b["version"] + 1)
        self.assertEqual(updated["version"], a["version"] + 1)
        self.assertEqual(updated["template_version"], 2)
        self.assertNotIn("template_id", other)
        self.assertEqual(self.store.shops()[1]["settings"]["template_version"], 2)

    def test_unchanged_template_and_switch_only_save_do_not_touch_other_shop(self):
        template = self.create()
        self.bind("a", template)
        self.bind("b", template)
        before = self.store._settings("b")
        self.bind("a", template, enabled=False)
        self.assertEqual(self.store._settings("b"), before)
        self.assertEqual(self.store.reply_templates()[0]["version"], 1)

    def test_stale_template_version_rejects_without_any_partial_update(self):
        template = self.create()
        self.bind("a", template)
        self.bind("b", template)
        self.bind("a", template, system_prompt="新版本")
        before = (self.store.shops(), self.store.reply_templates())
        self.code("template_changed", lambda: self.bind("b", template, system_prompt="陈旧内容"))
        self.assertEqual((self.store.shops(), self.store.reply_templates()), before)

    def test_detach_keeps_effective_content_and_stops_future_sync(self):
        template = self.create()
        self.bind("a", template)
        b = self.bind("b", template)
        detached = self.store.update_settings("b", {**b, "template_id": None, "template_version": None})
        self.assertNotIn("template_id", detached)
        self.bind("a", template, system_prompt="只更新甲店")
        self.assertEqual(self.store._settings("b"), detached)
        self.assertEqual(detached["system_prompt"], SHARED["system_prompt"])

    def test_unaware_old_form_keeps_binding_but_cannot_overwrite_shared_content(self):
        template = self.create()
        self.bind("a", template)
        old = {"enabled": False, **copy.deepcopy(SHARED)}
        saved = self.store.update_settings("a", old)
        self.assertEqual(saved["template_id"], template["template_id"])
        self.code("template_changed", lambda: self.store.update_settings("a", {**old, "system_prompt": "旧界面修改"}))
        self.assertEqual(self.store.reply_templates()[0]["system_prompt"], SHARED["system_prompt"])
        self.assertFalse(self.store._settings("a")["enabled"])

    def test_invalid_binding_and_unknown_id_do_not_modify_shop(self):
        before = self.store.shops()
        for value in (False, 0, [], {}, True):
            self.code("invalid_template", lambda: self.store.update_settings("a", {"enabled": False, **SHARED, "template_id": value}))
        self.code("template_not_found", lambda: self.store.update_settings("a", {"enabled": False, **SHARED, "template_id": "missing", "template_version": 1}))
        self.code("invalid_template", lambda: self.store.update_settings("a", {"enabled": False, **SHARED, "template_id": None, "template_version": 1}))
        self.assertEqual(self.store.shops(), before)

    def test_template_and_binding_survive_reopen_and_old_unbound_api_is_unchanged(self):
        template = self.create()
        self.bind("a", template)
        old = {"enabled": False, **SHARED}
        saved = self.store.update_settings("b", old)
        self.assertEqual(set(saved), {*old, "version"})
        before = self.store.shops()
        self.store.close()
        self.store = Store(self.tmp.name, SHOPS)
        self.assertEqual(self.store.reply_templates(), [template])
        self.assertEqual(self.store.shops(), before)

    def test_rule_targets_and_handling_are_shared_but_fallback_remains_local(self):
        rules = [{"id": "item", "contains": "说明书", "send": {"type": "instruction", "match": "安装"}},
                 {"id": "handle", "contains": "人工", "handling": {"action": "handoff"}}]
        template = self.create(rules=rules)
        saved = self.bind("a", template, rules=rules)
        self.assertEqual(saved["rules"], rules)
        self.assertNotIn("fallback", self.store.reply_templates()[0])

    def test_transaction_failure_rolls_back_template_and_all_shops(self):
        import sqlite3
        template = self.create()
        self.bind("a", template)
        self.bind("b", template)
        before = (self.store.shops(), self.store.reply_templates())
        self.store.db.execute("CREATE TRIGGER deny_sync BEFORE UPDATE ON shops WHEN old.shop_id='b' BEGIN SELECT RAISE(ABORT,'fictional denial'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.bind("a", template, system_prompt="不能只提交一半")
        self.assertEqual((self.store.shops(), self.store.reply_templates()), before)
