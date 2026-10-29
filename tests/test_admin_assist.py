"""Administrative previews use fictional shops and local synthetic providers."""
import copy
import json
import pathlib
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_model_settings as fixtures
from synthetic_provider import completion, http_error
from backend import promptmerge
from backend.engine import ProviderFailure


class AdminAssistTests(unittest.TestCase):
    setUp = fixtures.ModelSettingsTests.setUp
    start = fixtures.ModelSettingsTests.start
    stop = fixtures.ModelSettingsTests.stop
    stop_all = fixtures.ModelSettingsTests.stop_all
    request = fixtures.ModelSettingsTests.request
    get_config = fixtures.ModelSettingsTests.get_config
    save = fixtures.ModelSettingsTests.save
    slot_payload = staticmethod(fixtures.ModelSettingsTests.slot_payload)
    save_providers = fixtures.ModelSettingsTests.save_providers

    def payload(self):
        return {"shop_id": "demo", "version": self.get_config()["version"],
                "shop_version": self.server.store.shops()[0]["settings"]["version"],
                "current_prompt": "未确认的材质转人工；不要承诺退款。", "supplement": "回答简短一点。"}

    def call(self, endpoint="prompt-merge", payload=None, token=True):
        return self.request("POST", "/api/v1/admin/" + endpoint, payload or self.payload(),
                            token=self.token if token is True else token)

    def test_prompt_merge_uses_current_text_primary_only_without_persisting(self):
        self.save_providers()
        before = copy.deepcopy(self.server.store.shops())
        config_before = self.get_config()
        answer = {"draft": "未确认材质转人工，不承诺退款；简短回答。", "changes": ["回答更简短"], "conflicts": []}
        self.primary.queue(completion(json.dumps(answer, ensure_ascii=False)))
        payload = self.payload()
        status, value = self.call(payload=payload)
        self.assertEqual(status, 200, value)
        self.assertEqual(value["draft"], answer["draft"])
        sent = json.loads(self.primary.body()["messages"][1]["content"])
        self.assertEqual(sent, {k: payload[k] for k in ("current_prompt", "supplement")})
        self.assertEqual(self.server.store.shops(), before)
        self.assertEqual(self.get_config(), config_before)
        self.assertEqual(self.server.store.events(), [])
        self.assertEqual(self.backup.count(), 0)

    def test_unchanged_merge_warns_without_persisting_or_fallback(self):
        self.save_providers()
        before = copy.deepcopy(self.server.store.shops())
        payload = self.payload()
        answer = {"draft": payload["current_prompt"], "changes": ["已加入简短回复要求"], "conflicts": ["冲突要求待确认"]}
        self.primary.queue(completion(json.dumps(answer, ensure_ascii=False)))
        status, value = self.call(payload=payload)
        self.assertEqual(status, 200, value)
        self.assertEqual(value["draft"], answer["draft"])
        self.assertEqual(value["changes"], [promptmerge.NO_CHANGE])
        self.assertEqual(value["conflicts"], answer["conflicts"])
        self.assertEqual(self.server.store.shops(), before)
        self.assertEqual(self.server.store.events(), [])
        self.assertEqual(self.backup.count(), 0)

    def test_import_never_calls_model_and_removes_contact_metadata(self):
        before = copy.deepcopy(self.server.store.shops())
        text = json.dumps([{"buyer_id": "private-buyer-name", "messages": [
            {"role": "买家", "type": "文本", "content": "怎么清洁？"},
            {"role": "客服", "type": "文本", "content": "请按说明书清洁。"}]}])
        status, value = self.call("chat-import", {"shop_id": "demo", "filename": "test.json", "text": text})
        self.assertEqual(status, 200, value)
        self.assertEqual(len(value["pairs"]), 1)
        self.assertNotIn("private-buyer-name", json.dumps(value))
        self.assertEqual(self.primary.count(), 0)
        self.assertEqual(self.server.store.shops(), before)

    def test_all_preview_routes_enforce_admin_and_changed_password(self):
        for endpoint in ("chat-import", "rule-draft", "prompt-merge"):
            self.assertEqual(self.call(endpoint, token=None)[0], 401)
            self.assertEqual(self.call(endpoint, token=fixtures.CLIENT_TOKEN)[0], 403)
            payload = self.payload()
            with patch.object(self.server.auth, "identity", return_value={"role": "admin", "must_change_password": True}):
                self.assertEqual(self.call(endpoint, payload=payload)[0], 403)
        self.assertEqual(self.primary.count(), 0)

    def test_invalid_or_stale_payloads_do_not_call_provider(self):
        self.save_providers()
        for changes in ({"shop_version": -1}, {"version": 999}, {"current_prompt": ""},
                        {"current_prompt": "x" * 8001}, {"supplement": "x" * 4001},
                        {"version": True}, {"shop_id": "missing"}, {"extra": "no"}):
            with self.subTest(changes=changes):
                self.assertIn(self.call(payload={**self.payload(), **changes})[0], (400, 404, 409))
        self.assertEqual(self.primary.count(), 0)

    def test_invalid_import_and_rules_are_safe_errors(self):
        for text in ("not-json", "[]", "x" * (2 * 1024 * 1024 + 1)):
            status, value = self.call("chat-import", {"shop_id": "demo", "filename": "test.json", "text": text})
            self.assertEqual(status, 400, value)
            self.assertEqual(value["error"]["code"], "invalid_chat_import")
        payload = self.payload()
        for key in ("current_prompt", "supplement"):
            del payload[key]
        payload.update(pairs=[], existing_rules=[])
        self.assertEqual(self.call("rule-draft", payload)[0], 400)
        self.assertEqual(self.primary.count(), 0)

    def test_provider_failure_never_exposes_response_or_falls_back(self):
        self.save_providers()
        self.primary.queue(http_error(503), completion("PRIVATE malformed response"))
        for _ in range(2):
            status, value = self.call()
            self.assertEqual(status, 502, value)
            self.assertNotIn("PRIVATE", json.dumps(value))
        self.assertEqual(self.backup.count(), 0)

    def test_rule_rejection_logs_only_reason_and_keeps_api_error_generic(self):
        self.save_providers()
        before = copy.deepcopy(self.server.store.shops())
        pairs = [{"id": "p" + str(i), "conversation": "c" + str(i),
                  "question": "怎么清洁？", "answer": "使用软布。"} for i in (1, 2)]
        private = "PRIVATE-RESPONSE-SENTINEL"
        answer = {"candidates": [{"contains": "清洁", "description": "清洁方法", "reply": "使用软布。",
                  "evidence_ids": ["p1", "p2"], "conflicts": [private], "warnings": []}], "warnings": []}
        self.primary.queue(completion(json.dumps(answer)))
        payload = {k: v for k, v in self.payload().items() if k not in ("current_prompt", "supplement")}
        with patch("backend.diagnostics.emit") as emit:
            status, value = self.call("rule-draft", {**payload, "pairs": pairs, "existing_rules": []})
        self.assertEqual(status, 502, value)
        self.assertEqual(value["error"]["code"], "assist_unavailable")
        emit.assert_any_call("admin_assist_output_rejected", operation="rule_draft", reason="conflict_unknown")
        self.assertNotIn(private, str(emit.call_args_list) + json.dumps(value))
        self.assertEqual(self.server.store.shops(), before)
        self.assertEqual(self.server.store.events(), [])
        self.assertEqual(self.backup.count(), 0)

    def start_slow_merge(self):
        self.save_providers()
        self.primary.queue({**completion(json.dumps({"draft": "synthetic", "changes": [], "conflicts": []})), "delay": .8})
        payload, results = self.payload(), []
        thread = threading.Thread(target=lambda: results.append(self.call(payload=payload)))
        thread.start()
        self.addCleanup(thread.join)
        end = time.monotonic() + 5
        while not self.primary.count() and time.monotonic() < end:
            time.sleep(.01)
        self.assertEqual(self.primary.count(), 1)
        return thread, results

    def test_logout_revokes_inflight_preview_and_shared_slot_releases(self):
        thread, results = self.start_slow_merge()
        self.assertEqual(self.call()[0], 429)
        self.request("POST", "/api/v1/admin/logout", {}, token=self.token)
        thread.join(5)
        self.assertEqual(results[0][0], 401)
        self.assertTrue(self.server.prompt_draft_slot.acquire(blocking=False))
        self.server.prompt_draft_slot.release()

    def test_shop_change_discards_inflight_preview(self):
        thread, results = self.start_slow_merge()
        settings = self.server.store.shops()[0]["settings"]
        status, _ = self.request("PUT", "/api/v1/admin/shops/demo/settings", settings, token=self.token)
        self.assertEqual(status, 200)
        thread.join(5)
        self.assertEqual(results[0][0], 409)

    def test_model_change_discards_inflight_preview(self):
        thread, results = self.start_slow_merge()
        self.save_providers()
        thread.join(5)
        self.assertEqual(results[0][0], 409)


class PromptMergeOutputTests(unittest.TestCase):
    def test_unchanged_draft_never_claims_additions_and_preserves_conflicts(self):
        config = {"primary": {"base_url": "http://127.0.0.1:9/v1", "model": "synthetic"}}
        current = "未确认车型和年份先询问，不承诺适配。"
        for draft, changes in ((current, ["已加入两句话以内"]), ("  " + current + "\n", [])):
            answer = {"draft": draft, "changes": changes, "conflicts": ["直接保证适配与原要求冲突"]}
            wire = {"choices": [{"message": {"content": json.dumps(answer)}}]}
            with patch.object(promptmerge, "_post", return_value=wire) as post:
                result = promptmerge.generate(current, "控制在两句话，车型未知也保证适配。", config)
            self.assertEqual(result["draft"], draft)
            self.assertEqual(result["changes"], [promptmerge.NO_CHANGE])
            self.assertEqual(result["conflicts"], answer["conflicts"])
            post.assert_called_once()

    def test_changed_draft_keeps_the_actual_change_summary(self):
        config = {"primary": {"base_url": "http://127.0.0.1:9/v1", "model": "synthetic"}}
        answer = {"draft": "未知材质转人工。回答尽量简短。", "changes": ["加入简短回复要求"], "conflicts": []}
        wire = {"choices": [{"message": {"content": json.dumps(answer)}}]}
        with patch.object(promptmerge, "_post", return_value=wire):
            self.assertEqual(promptmerge.generate("未知材质转人工。", "简短回答", config), answer)

    def test_schema_and_truncation_fail_closed(self):
        config = {"primary": {"base_url": "http://127.0.0.1:9/v1", "model": "synthetic"}}
        valid = {"draft": "保留原规则", "changes": ["简短"], "conflicts": []}
        invalid = ["private text", {}, {**valid, "conflicts": "none"}, {**valid, "draft": "x" * 8001},
                   {**valid, "changes": [True]}, {**valid, "extra": "ignored?"}]
        for value in invalid:
            with self.subTest(value=type(value)):
                with patch.object(promptmerge, "_post", return_value={"choices": [{"message": {"content": json.dumps(value)}}]}):
                    with self.assertRaises(ProviderFailure):
                        promptmerge.generate("old", "new", config)
        with patch.object(promptmerge, "_post", return_value={"choices": [{"finish_reason": "length"}]}):
            with self.assertRaises(ProviderFailure) as raised:
                promptmerge.generate("old", "new", config)
            self.assertEqual(raised.exception.code, "incomplete_draft")


if __name__ == "__main__":
    unittest.main()
