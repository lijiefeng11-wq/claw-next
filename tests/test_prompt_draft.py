"""Draft generation uses synthetic providers and temporary data only."""
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
from backend import promptdraft
from backend.engine import ProviderFailure


class PromptDraftTests(unittest.TestCase):
    # Reuse only the fixture helpers, not the unrelated model-settings tests.
    setUp = fixtures.ModelSettingsTests.setUp
    start = fixtures.ModelSettingsTests.start
    stop = fixtures.ModelSettingsTests.stop
    stop_all = fixtures.ModelSettingsTests.stop_all
    request = fixtures.ModelSettingsTests.request
    get_config = fixtures.ModelSettingsTests.get_config
    save = fixtures.ModelSettingsTests.save
    slot_payload = staticmethod(fixtures.ModelSettingsTests.slot_payload)
    save_providers = fixtures.ModelSettingsTests.save_providers

    def draft(self, **changes):
        payload = {"shop_id": "demo", "brief": "材质未确认就先询问或转人工。", "version": self.get_config()["version"]}
        payload.update(changes)
        return self.request("POST", "/api/v1/admin/prompt-draft", payload, token=self.token)

    def test_generate_is_unapplied_and_uses_only_brief_and_primary(self):
        self.assertEqual(self.save_providers()[0], 200)
        before = self.server.store.shops()
        model_before = self.get_config()
        self.primary.queue(completion("材质待确认，先询问款式或转人工。"))
        status, value = self.draft()
        self.assertEqual(status, 200, value)
        self.assertEqual(value["shop_id"], "demo")
        self.assertIn("待确认", value["draft"])
        self.assertEqual(self.server.store.shops(), before)
        self.assertEqual(self.get_config(), model_before)
        self.assertEqual(self.server.store.events(), [])
        self.assertEqual(self.backup.count(), 0)
        body = self.primary.body()
        self.assertEqual(body["messages"][1]["content"], "材质未确认就先询问或转人工。")
        self.assertNotIn("response_format", body)  # Drafts need no model-side JSON grammar.
        self.assertNotIn("system_prompt", json.dumps(body))
        self.assertIn("禁止猜测", body["messages"][0]["content"])

    def test_rejects_invalid_input_without_provider_calls(self):
        self.save_providers()
        for changes, status in [({"brief": " "}, 400), ({"brief": "x" * 4001}, 400),
                                ({"brief": []}, 400), ({"shop_id": "missing"}, 404),
                                ({"version": True}, 400), ({"version": -1}, 400),
                                ({"version": 999}, 409), ({"base_url": "http://localhost"}, 400)]:
            with self.subTest(changes=list(changes)):
                self.assertEqual(self.draft(**changes)[0], status)
        self.assertEqual(self.primary.count(), 0)

    def test_rejects_unauthenticated_client_and_first_login(self):
        payload = {"shop_id": "demo", "brief": "test", "version": 0}
        self.assertEqual(self.request("POST", "/api/v1/admin/prompt-draft", payload)[0], 401)
        self.assertEqual(self.request("POST", "/api/v1/admin/prompt-draft", payload, token=fixtures.CLIENT_TOKEN)[0], 403)
        with patch.object(self.server.auth, "identity", return_value={"role": "admin", "must_change_password": True}):
            status, value = self.request("POST", "/api/v1/admin/prompt-draft", payload, token=self.token)
        self.assertEqual(status, 403)
        self.assertEqual(value["error"]["code"], "admin_password_change_required")
        self.assertEqual(self.primary.count(), 0)

    def test_failure_never_falls_back_or_exposes_provider_text(self):
        self.save_providers()
        self.primary.queue(http_error(503), {"raw": "PRIVATE invalid provider response"}, completion(" "))
        for _ in range(3):
            status, value = self.draft()
            self.assertEqual(status, 502)
            self.assertEqual(value["error"]["code"], "prompt_draft_unavailable")
            self.assertNotIn("PRIVATE", json.dumps(value))
        self.assertEqual(self.backup.count(), 0)
        self.primary.queue(completion("recovered"))
        self.assertEqual(self.draft()[0], 200)  # Capacity is released after failure.

    def slow_draft(self):
        self.save_providers()
        self.primary.queue({**completion("synthetic"), "delay": 0.7})
        results = []
        thread = threading.Thread(target=lambda: results.append(self.draft()))
        thread.start()
        self.addCleanup(thread.join)
        deadline = time.monotonic() + 5
        while self.primary.count() == 0 and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(self.primary.count(), 1)
        return thread, results

    def test_busy_is_bounded_and_logout_is_not_blocked(self):
        thread, results = self.slow_draft()
        self.assertEqual(self.draft()[0], 429)
        started = time.monotonic()
        self.assertEqual(self.request("POST", "/api/v1/admin/logout", {}, token=self.token)[0], 200)
        self.assertLess(time.monotonic() - started, .5)
        thread.join(timeout=5)
        self.assertEqual(results[0][0], 401)

    def test_configuration_change_discards_result(self):
        thread, results = self.slow_draft()
        self.assertEqual(self.save_providers()[0], 200)
        thread.join(timeout=5)
        self.assertEqual(results[0][0], 409)


class DraftOutputTests(unittest.TestCase):
    def test_thinking_opt_out_is_limited_to_local_qwen_drafts(self):
        cases = [
            ("http://127.0.0.1:8000/v1", "Qwen3.6-35B-A3B-4bit", True),
            ("http://localhost:8000/v1", "mlx-community/Qwen3.6-35B-A3B-4bit", True),
            ("http://[::1]:8000/v1", "qwen3.6-35b-a3b", True),
            ("https://models.example/v1", "Qwen3.6-35B-A3B-4bit", False),
            ("https://127.0.0.1.example/v1", "Qwen3.6-35B-A3B-4bit", False),
            ("http://127.0.0.1:8000/v1", "Qwen3.6-27B", False),
            ("http://127.0.0.1:8000/v1", "deepseek-flash", False),
        ]
        for base_url, model, disable_thinking in cases:
            with self.subTest(base_url=base_url, model=model):
                config = {"primary": {"base_url": base_url, "model": model, "timeout_seconds": 10}}
                before = copy.deepcopy(config)
                value = {"choices": [{"finish_reason": "stop", "message": {"content": "synthetic draft"}}]}
                with patch.object(promptdraft, "_post", return_value=value) as post:
                    self.assertEqual(promptdraft.generate("synthetic brief", config), "synthetic draft")
                spec, body = post.call_args.args
                post.assert_called_once()
                self.assertEqual(spec["timeout_seconds"], 45)
                self.assertEqual(body["max_tokens"], 2048)
                if disable_thinking:
                    self.assertEqual(body["chat_template_kwargs"], {"enable_thinking": False})
                else:
                    self.assertNotIn("chat_template_kwargs", body)
                self.assertEqual(config, before)

    def test_length_finish_is_incomplete_even_without_final_content(self):
        config = {"primary": {"base_url": "http://127.0.0.1:9/v1", "model": "synthetic"}}
        for message in [{"reasoning_content": "synthetic thinking"},
                        {"content": None}, {"content": ""}, {"content": "partial draft"}]:
            with self.subTest(message=message):
                value = {"choices": [{"finish_reason": "length", "message": message}]}
                with patch.object(promptdraft, "_post", return_value=value):
                    with self.assertRaises(ProviderFailure) as raised:
                        promptdraft.generate("synthetic brief", config)
                self.assertEqual(raised.exception.code, "incomplete_draft")

    def test_malformed_truncated_or_overlong_output_is_rejected(self):
        config = {"primary": {"base_url": "http://127.0.0.1:9/v1", "model": "synthetic", "timeout_seconds": 60}}
        for value in [None, {"choices": []}, {"choices": [None]}, {"choices": ["invalid"]},
                      {"choices": [{"message": {"content": " "}}]},
                      {"choices": [{"finish_reason": "length", "message": {"content": '{"draft":"partial"}'}}]},
                      {"choices": [{"message": {"content": "x" * 8001}}]}]:
            with patch.object(promptdraft, "_post", return_value=value) as post:
                with self.assertRaises(ProviderFailure):
                    promptdraft.generate("synthetic", config)
                self.assertEqual(post.call_args[0][0]["timeout_seconds"], 45)


if __name__ == "__main__":
    unittest.main()
