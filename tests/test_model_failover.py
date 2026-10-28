"""Real primary -> backup failover against a local synthetic HTTP provider."""
import json
import os
import sys
import time
import unittest
from unittest.mock import patch

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
for path in (_REPO_ROOT, _TESTS_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)

from backend import modelconfig  # noqa: E402
from backend.engine import decide, model_decide, test_slot  # noqa: E402
from synthetic_provider import (  # noqa: E402
    SyntheticProvider,
    bad_shape,
    completion,
    decision,
    http_error,
    invalid_content,
    redirect,
    timeout,
)

ENV_NAME = "CLAW_NEXT_TEST_UNSET_KEY"
FAST_TIMEOUT = 1


def slot(base_url, model="synthetic-model", timeout=FAST_TIMEOUT, key=""):
    return {"base_url": base_url, "model": model, "timeout_seconds": timeout, "api_key": key}


def config(primary=None, backup=None, version=3):
    return {"version": version,
            "primary": primary or modelconfig.empty_slot(),
            "backup": backup or modelconfig.empty_slot(),
            "api_key_env": ENV_NAME}


def context(text="你好，请问营业时间？"):
    return {"history_complete": True,
            "messages": [{"role": "buyer", "kind": "text", "content": text, "created_at": time.time()}]}


SETTINGS = {"system_prompt": "仅根据已知店铺规则回答；无法确认则转人工。"}


class FailoverTests(unittest.TestCase):
    def test_image_bytes_and_card_fields_reach_real_http_provider(self):
        from test_multimodal import ATTACHMENT
        ctx = context()
        ctx["messages"][0].update(id="synthetic-image", kind="card", attachments=[ATTACHMENT],
                                  card={"type": "goods", "title": "虚构商品", "fields": [{"label": "规格", "value": "测试"}]})
        self.primary.queue(http_error(503))
        self.backup.queue(decision("reply", "请问商品哪一方面？", "vision"))
        result = model_decide(ctx, SETTINGS, config(slot(self.primary.base_url), slot(self.backup.base_url)))
        self.assertEqual(result["action"], "reply")
        for provider in (self.primary, self.backup):
            body = provider.body()
            parts = body["messages"][1]["content"]
            self.assertEqual(parts[-1]["image_url"]["url"], ATTACHMENT["data_url"])
            self.assertEqual(json.loads(parts[0]["text"])["messages"][0]["card"]["title"], "虚构商品")

    def setUp(self):
        self.primary = SyntheticProvider().start()
        self.backup = SyntheticProvider().start()
        self.addCleanup(self.backup.stop)
        self.addCleanup(self.primary.stop)
        # The legacy environment key must not leak into these synthetic tests.
        patcher = patch.dict(os.environ, {ENV_NAME: ""})
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_model(self, primary, backup):
        return model_decide(context(), SETTINGS, config(primary, backup))

    def test_primary_success_leaves_backup_untouched(self):
        self.primary.queue(decision("reply", "主用回复", "primary-ok"))
        self.backup.queue(decision("reply", "备用回复", "backup-ok"))
        result = self.run_model(slot(self.primary.base_url), slot(self.backup.base_url))
        self.assertEqual(result["action"], "reply")
        self.assertEqual(result["text"], "主用回复")
        self.assertEqual(result["reason"], "model:primary:primary-ok")
        self.assertEqual(self.primary.count(), 1)
        self.assertEqual(self.backup.count(), 0)
        self.assertEqual(self.primary.body()["model"], "synthetic-model")

    def test_primary_http_503_falls_back_once_to_backup(self):
        self.primary.queue(http_error(503))
        self.backup.queue(decision("reply", "备用回复", "backup-ok"))
        result = self.run_model(slot(self.primary.base_url), slot(self.backup.base_url))
        self.assertEqual(result["action"], "reply")
        self.assertEqual(result["text"], "备用回复")
        self.assertEqual(result["reason"], "model:backup:backup-ok:fallback=http_503")
        self.assertEqual(self.primary.count(), 1)
        self.assertEqual(self.backup.count(), 1)

    def test_primary_429_falls_back_once_to_backup(self):
        self.primary.queue(http_error(429))
        self.backup.queue(decision("reply", "备用回复", "rate-limited-backup"))
        result = self.run_model(slot(self.primary.base_url), slot(self.backup.base_url))
        self.assertEqual(result["action"], "reply")
        self.assertIn("fallback=http_429", result["reason"])
        self.assertEqual(self.primary.count(), 1)

    def test_primary_timeout_falls_back_to_backup(self):
        self.primary.queue(timeout(delay=2.0))
        self.backup.queue(decision("reply", "备用回复", "backup-after-timeout"))
        result = self.run_model(slot(self.primary.base_url, timeout=1), slot(self.backup.base_url, timeout=2))
        self.assertEqual(result["action"], "reply")
        self.assertEqual(result["reason"], "model:backup:backup-after-timeout:fallback=timeout")
        self.assertEqual(self.backup.count(), 1)

    def test_unusable_primary_response_falls_back(self):
        cases = [bad_shape(), invalid_content(), completion("x" * 70000), redirect("http://127.0.0.1:9/v1/chat/completions")]
        expected = ["invalid_response", "invalid_output", "response_too_large", "http_302"]
        for behaviour, reason in zip(cases, expected):
            with self.subTest(reason=reason):
                self.primary.queue(behaviour)
                self.backup.queue(decision("reply", "备用回复", "backup-recovered"))
                result = self.run_model(slot(self.primary.base_url), slot(self.backup.base_url))
                self.assertEqual(result["action"], "reply")
                self.assertIn(":fallback=" + reason, result["reason"])

    def test_valid_primary_handoff_is_never_retried_on_backup(self):
        self.primary.queue(decision("handoff", reason="policy-uncovered"))
        self.backup.queue(decision("reply", "不应使用的备用回复", "should-not-run"))
        result = self.run_model(slot(self.primary.base_url), slot(self.backup.base_url))
        self.assertEqual(result["action"], "handoff")
        self.assertEqual(result["text"], "")
        self.assertEqual(result["reason"], "model:primary:policy-uncovered")
        self.assertEqual(self.backup.count(), 0)

    def test_both_failing_hands_off_without_a_reply(self):
        self.primary.queue(http_error(503))
        self.backup.queue(http_error(500))
        result = self.run_model(slot(self.primary.base_url), slot(self.backup.base_url))
        self.assertEqual(result["action"], "handoff")
        self.assertEqual(result["text"], "")
        self.assertEqual(result["reason"], "model_unavailable:primary=http_503,backup=http_500")
        self.assertEqual((self.primary.count(), self.backup.count()), (1, 1))

    def test_unconfigured_primary_uses_configured_backup(self):
        self.backup.queue(decision("reply", "备用回复", "backup-only"))
        result = self.run_model(None, slot(self.backup.base_url))
        self.assertEqual(result["action"], "reply")
        self.assertEqual(result["reason"], "model:backup:backup-only:fallback=not_configured")
        self.assertEqual(self.primary.count(), 0)

    def test_nothing_configured_hands_off_without_network(self):
        result = self.run_model(None, None)
        self.assertEqual(result["action"], "handoff")
        self.assertEqual(result["reason"], "model_not_configured")
        self.assertEqual(self.primary.count(), 0)
        self.assertEqual(self.backup.count(), 0)

    def test_local_provider_without_key_sends_no_authorization_header(self):
        self.primary.queue(decision())
        result = self.run_model(slot(self.primary.base_url), None)
        self.assertEqual(result["action"], "reply")
        self.assertIsNone(self.primary.header(0, "Authorization"))

    def test_saved_keys_are_sent_but_environment_key_only_for_primary(self):
        with patch.dict(os.environ, {ENV_NAME: "env-synthetic-key"}):
            self.primary.queue(http_error(503))
            self.backup.queue(decision("reply", "备用回复", "backup-keyed"))
            result = self.run_model(slot(self.primary.base_url), slot(self.backup.base_url, key="saved-backup-key"))
            self.assertEqual(result["action"], "reply")
        self.assertEqual(self.primary.header(0, "Authorization"), "Bearer env-synthetic-key")
        self.assertEqual(self.backup.header(0, "Authorization"), "Bearer saved-backup-key")

    def test_backup_never_uses_the_primary_environment_key(self):
        with patch.dict(os.environ, {ENV_NAME: "env-synthetic-key"}):
            self.backup.queue(decision())
            self.run_model(None, slot(self.backup.base_url))
        self.assertIsNone(self.backup.header(0, "Authorization"))

    def test_decide_routes_model_mode_through_failover(self):
        self.primary.queue(http_error(503))
        self.backup.queue(decision("reply", "备用回复", "integration"))
        now = time.time()
        job = {"payload": {"received_at": now, "context": context()},
               "settings": {"enabled": True, "mode": "model", "system_prompt": "测试", "rules": []}}
        result = decide(job, config(slot(self.primary.base_url), slot(self.backup.base_url)))
        self.assertEqual(result["action"], "reply")
        self.assertEqual(result["text"], "备用回复")

    def test_test_slot_uses_a_harmless_synthetic_prompt(self):
        self.primary.queue(completion("OK"))
        before = config(slot(self.primary.base_url))
        snapshot = json.dumps(before, sort_keys=True)
        result = test_slot(before, "primary")
        self.assertTrue(result["ok"])
        self.assertEqual(result["reason"], "ok")
        self.assertEqual(result["slot"], "primary")
        self.assertIsInstance(result["latency_ms"], int)
        self.assertNotIn("OK", json.dumps(result))
        body = self.primary.body(0)
        joined = json.dumps(body, ensure_ascii=False)
        self.assertIn("connectivity check", joined)
        self.assertNotIn("Shop policy", joined)
        self.assertEqual(self.primary.count(), 1)
        # The probe never rewrites the saved configuration.
        self.assertEqual(json.dumps(before, sort_keys=True), snapshot)

    def test_test_slot_allows_reasoning_before_final_content(self):
        def reasoning_response(spec, body):
            # Simulate a model that spends 64 tokens reasoning before its answer.
            answered = body["max_tokens"] > 64
            return {"choices": [{"message": {
                "reasoning_content": "synthetic private reasoning",
                "content": "OK" if answered else ""},
                "finish_reason": "stop" if answered else "length"}]}

        for name in ("primary", "backup"):
            with self.subTest(slot=name), patch("backend.engine._post", side_effect=reasoning_response) as post:
                result = test_slot(config(slot(self.primary.base_url), slot(self.backup.base_url)), name)
                self.assertTrue(result["ok"])
                self.assertEqual(result["reason"], "ok")
                self.assertEqual(set(result), {"slot", "version", "ok", "reason", "latency_ms"})
                post.assert_called_once()
                self.assertEqual(post.call_args.args[0]["timeout_seconds"], FAST_TIMEOUT)
                self.assertNotIn("synthetic private reasoning", json.dumps(result))

    def test_test_slot_rejects_empty_or_malformed_success_responses(self):
        responses = [
            {"choices": [{"message": {"content": "", "reasoning_content": "private reasoning"},
                          "finish_reason": "length"}]},
            {"choices": [{"message": {"content": None}}]},
            {"choices": [{"message": {"content": "  "}}]},
            {"choices": [{"message": {"content": ["OK"]}}]},
            {"choices": []},
        ]
        for response in responses:
            with self.subTest(response=response):
                self.primary.queue({"raw": json.dumps(response)})
                result = test_slot(config(slot(self.primary.base_url)), "primary")
                self.assertFalse(result["ok"])
                self.assertEqual(result["reason"], "invalid_response")
                self.assertNotIn("private reasoning", json.dumps(result))

    def test_test_slot_reports_safe_failure_codes(self):
        self.primary.queue(http_error(503))
        result = test_slot(config(slot(self.primary.base_url)), "primary")
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "http_503")
        self.assertEqual(set(result), {"slot", "version", "ok", "reason", "latency_ms"})
        self.assertEqual(self.primary.count(), 1)

    def test_test_slot_unconfigured_slot_never_calls_network(self):
        result = test_slot(config(None, None), "backup")
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "not_configured")
        self.assertEqual(self.primary.count(), 0)
        self.assertEqual(self.backup.count(), 0)


if __name__ == "__main__":
    unittest.main()
