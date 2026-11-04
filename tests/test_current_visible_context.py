"""Incomplete history stays honest without suppressing current-message replies."""
import copy
import json
import unittest
from unittest.mock import patch

from backend.engine import decide
from test_multimodal import CONFIG, job, message


class CurrentVisibleContextTests(unittest.TestCase):
    def partial(self, mode="hybrid"):
        item = job([message(name="old", content="虚构车型", role="buyer"),
                    message(name="latest", content="2024款")], mode)
        item["payload"]["context"]["history_complete"] = False
        return item

    def test_model_receives_visible_context_and_honest_incomplete_flag(self):
        item = self.partial()
        before = copy.deepcopy(item["payload"]["context"])
        reply = {"choices": [{"message": {"content": json.dumps({
            "action": "reply", "text": "请问需要哪个窗位？", "reason": "缺少窗位"})}}]}
        with patch("backend.engine._post", return_value=reply) as post:
            result = decide(item, CONFIG)
        self.assertEqual(result["action"], "reply")
        self.assertEqual(post.call_count, 1)
        body = post.call_args.args[1]
        self.assertEqual(json.loads(body["messages"][1]["content"]), before)
        system = body["messages"][0]["content"]
        self.assertIn("Do not hand off solely because history is incomplete", system)
        self.assertIn("Do not invent missing history", system)
        self.assertEqual(item["payload"]["context"], before)

    def test_current_keyword_rule_can_reply_without_model(self):
        item = self.partial("rules")
        item["settings"]["rules"] = [{"id": "year", "contains": "2024", "reply": "请补充具体车型和窗位。"}]
        with patch("backend.engine._post") as post:
            result = decide(item, CONFIG)
        self.assertEqual((result["action"], result["text"]), ("reply", "请补充具体车型和窗位。"))
        post.assert_not_called()

    def test_real_model_handoff_is_not_fabricated_into_a_reply(self):
        item = self.partial("model")
        output = {"choices": [{"message": {"content": json.dumps({
            "action": "handoff", "text": "", "reason": "退款需要人工授权"})}}]}
        with patch("backend.engine._post", return_value=output) as post:
            self.assertEqual(decide(item, CONFIG)["action"], "handoff")
        self.assertEqual(post.call_count, 1)

    def test_other_gates_still_apply_with_incomplete_history(self):
        for modifier, reason in (("disabled", "shop_disabled"), ("future", "message_future"),
                                 ("blocked", "settings_changed"), ("role", "no_new_buyer_message")):
            item = self.partial()
            if modifier == "disabled":
                item["settings"]["enabled"] = False
            elif modifier == "future":
                item["payload"]["received_at"] += 30
            elif modifier == "blocked":
                item["block_reason"] = "settings_changed"
            else:
                item["payload"]["context"]["messages"][-1]["role"] = "agent"
            with self.subTest(modifier=modifier), patch("backend.engine._post") as post:
                self.assertEqual(decide(item, CONFIG)["reason"], reason)
                post.assert_not_called()
