"""Synthetic mode isolation and semantic fixed-reply selection."""
import json
import unittest
from unittest.mock import patch

from backend.engine import decide, ProviderFailure
from backend.store import ApiError, validate_settings
import test_multimodal as media
import test_api_contract as api


def completion(value):
    return {"choices": [{"message": {"content": json.dumps(value)}}]}


class HybridTests(unittest.TestCase):
    def item(self, text="When does the parcel leave?", mode="hybrid"):
        job = media.job([media.message(content=text)], mode)
        job["settings"]["rules"] = [{"id": "dispatch", "contains": "dispatch time",
                                     "description": "Questions about when an order is dispatched",
                                     "reply": "  Fixed reply, unchanged.  "}]
        return job

    def test_rules_mode_never_calls_model_for_text_image_or_card(self):
        for kind in ("text", "image", "card"):
            job = self.item(mode="rules")
            msg = job["payload"]["context"]["messages"][-1]
            msg["kind"] = kind
            if kind == "image":
                msg["attachments"] = [media.ATTACHMENT]
            if kind == "card":
                msg["card"] = {"type": "goods", "title": "Synthetic"}
            with self.subTest(kind=kind), patch("backend.engine._post") as post:
                result = decide(job, media.CONFIG)
                self.assertEqual(result["reason"], "no_matching_rule")
                post.assert_not_called()

    def test_keyword_hit_never_calls_model(self):
        with patch("backend.engine._post") as post:
            result = decide(self.item("dispatch time please"), media.CONFIG)
        post.assert_not_called()
        self.assertEqual(result["reason"], "rule:dispatch")

    def test_text_with_image_never_shortcuts_through_keyword_rule(self):
        for mode in ("rules", "hybrid"):
            job = self.item("dispatch time please", mode)
            job["payload"]["context"]["messages"][-1]["attachments"] = [media.ATTACHMENT]
            output = completion({"action": "reply", "text": "Image-informed reply", "reason": "image"})
            with self.subTest(mode=mode), patch("backend.engine._post", return_value=output) as post:
                result = decide(job, media.CONFIG)
                if mode == "rules":
                    post.assert_not_called()
                    self.assertEqual(result["reason"], "no_matching_rule")
                else:
                    self.assertEqual(post.call_count, 1)
                    self.assertEqual(result["reason"], "model:primary:image")
                    parts = post.call_args.args[1]["messages"][1]["content"]
                    self.assertEqual([p["image_url"]["url"] for p in parts if p["type"] == "image_url"],
                                     [media.ATTACHMENT["data_url"]])

    def test_semantic_hit_uses_exact_saved_reply_and_sends_only_descriptors(self):
        job = self.item()
        with patch("backend.engine._post", return_value=completion({"rule_id": "dispatch", "text": "model rewrite"})) as post:
            result = decide(job, media.CONFIG)
        self.assertEqual(result["text"], job["settings"]["rules"][0]["reply"])
        self.assertEqual(result["reason"], "rule_semantic:dispatch")
        self.assertEqual(post.call_count, 1)
        system = post.call_args.args[1]["messages"][0]["content"]
        self.assertIn("Questions about when", system)
        self.assertNotIn("Fixed reply", system)

    def test_unknown_rule_id_with_valid_generated_response_is_not_a_rule_hit(self):
        with patch("backend.engine._post", return_value=completion({"rule_id": "absent", "action": "reply", "text": "Generated clarification", "reason": "clarify"})):
            result = decide(self.item(), media.CONFIG)
        self.assertEqual(result["text"], "Generated clarification")
        self.assertTrue(result["reason"].startswith("model:primary:"))

    def test_invalid_rule_only_output_uses_backup_once(self):
        with patch("backend.engine._post", side_effect=[completion({"rule_id": "absent"}), completion({"rule_id": "dispatch"})]) as post:
            result = decide(self.item(), media.CONFIG)
        self.assertEqual(post.call_count, 2)
        self.assertEqual(result["reason"], "rule_semantic:dispatch")

    def test_unconfigured_and_failed_models_handoff(self):
        with patch("backend.engine._post") as post:
            self.assertEqual(decide(self.item(), {})["reason"], "model_not_configured")
            post.assert_not_called()
        with patch("backend.engine._post", side_effect=ProviderFailure("timeout")) as post:
            self.assertEqual(decide(self.item(), media.CONFIG)["action"], "handoff")
            self.assertEqual(post.call_count, 2)

    def test_model_mode_cannot_select_rules_even_if_model_returns_id(self):
        output = {"rule_id": "dispatch", "action": "reply", "text": "Generated", "reason": "answer"}
        with patch("backend.engine._post", return_value=completion(output)) as post:
            result = decide(self.item("dispatch time", "model"), media.CONFIG)
        self.assertEqual(result["text"], "Generated")
        self.assertTrue(result["reason"].startswith("model:primary:"))
        self.assertNotIn("Questions about when", post.call_args.args[1]["messages"][0]["content"])

    def test_settings_description_roundtrip_and_limits_over_http(self):
        fixture = api.ApiContractTestCase()
        fixture.setUp()
        try:
            settings = self.item()["settings"]
            path = "/api/v1/admin/shops/shop-a/settings"
            saved = fixture.assert_status(fixture.request("PUT", path, settings, token=fixture.admin_token), 200)
            self.assertEqual(saved["mode"], "hybrid")
            self.assertEqual(saved["rules"], settings["rules"])
            settings["rules"][0]["description"] = "x" * 501
            fixture.assert_status(fixture.request("PUT", path, settings, token=fixture.admin_token), 400)
            settings["rules"][0]["description"] = False
            with self.assertRaises(ApiError):
                validate_settings(settings)
        finally:
            fixture.doCleanups()
