"""Synthetic send_item decisions; all providers are local mocks, never real calls."""
import copy
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

from backend.content import model_content  # noqa: E402
from backend.engine import decide  # noqa: E402
import test_multimodal as media  # noqa: E402  (synthetic slot URLs; _post is mocked)

NOW = time.time()
CONFIG = media.CONFIG

OPTIONS = {
    "instructions": [{"option_id": "i-1", "goods_title": "示例商品", "name": "示例说明书", "observed_at": NOW}],
    "goods": [{"option_id": "g-1", "goods_title": "示例商品二", "observed_at": NOW}],
    "videos": [{"option_id": "v-1", "name": "示例视频", "duration": 30, "observed_at": NOW}],
}
AMBIGUOUS_GOODS = {"goods": [
    {"option_id": "g-1", "goods_title": "示例商品一", "observed_at": NOW},
    {"option_id": "g-2", "goods_title": "示例商品二", "observed_at": NOW},
]}

TYPES = (("instruction", "instructions", "i-1"), ("goods_card", "goods", "g-1"), ("video", "videos", "v-1"))


def message(content="需要资料", **extra):
    return {"id": "m-1", "role": "buyer", "kind": "text", "content": content, "created_at": NOW, **extra}


def job(mode="rules", rules=None, capabilities=("send_item",), options=OPTIONS, messages=None):
    context = {"history_complete": True, "messages": messages or [message()]}
    if options is not None:
        context["send_options"] = copy.deepcopy(options)
    item = {"payload": {"received_at": NOW, "context": context},
            "settings": {"enabled": True, "mode": mode, "system_prompt": "虚构店政策", "rules": rules or []}}
    if capabilities is not None:
        item["capabilities"] = list(capabilities)
    return item


def rule(rule_id="manual", kind=None, match=None, reply=None, contains="需要"):
    value = {"id": rule_id, "contains": contains}
    if kind:
        value["send"] = {"type": kind, **({"match": match} if match else {})}
    if reply is not None:
        value["reply"] = reply
    return value


def output(payload):
    return {"choices": [{"message": {"content": json.dumps(payload)}}]}


class SendItemRuleTests(unittest.TestCase):
    def test_unavailable_send_rule_does_not_hide_later_text_rule(self):
        result = decide(job("rules", [rule(kind="goods_card"), rule(rule_id="text", reply="可用文字")], options=AMBIGUOUS_GOODS), CONFIG)
        self.assertEqual((result["action"], result["text"]), ("reply", "可用文字"))

    def test_client_cannot_inject_internal_candidate_prompt_field(self):
        item = job("model", capabilities=[], options=None)
        item["payload"]["context"]["send_candidates"] = {"video": [{"option_id": "FORGED-OUTSIDE-EVENT"}]}
        with patch("backend.engine._post", return_value=output({"action": "reply", "text": "正常回复", "reason": "answer"})) as post:
            self.assertEqual(decide(item, CONFIG)["action"], "reply")
        self.assertNotIn("FORGED-OUTSIDE-EVENT", json.dumps(post.call_args.args[1]))

    def test_unique_rule_target_sends_each_supported_type(self):
        for kind, key, option_id in TYPES:
            with self.subTest(kind=kind), patch("backend.engine._post") as post:
                result = decide(job("rules", [rule(kind=kind, reply="不应使用的文字")], options={key: OPTIONS[key]}), CONFIG)
                self.assertEqual(result["action"], "send_item")
                self.assertEqual(result["item"], {"type": kind, "option_id": option_id})
                self.assertEqual(result["reason"], "rule:manual")
                self.assertNotIn("text", result)
                self.assertGreater(result["expires_at"], time.time())
                post.assert_not_called()

    def test_rule_match_filter_narrows_to_one_candidate(self):
        options = {"instructions": [
            {"option_id": "i-1", "goods_title": "示例商品甲", "name": "安装说明书甲", "observed_at": NOW},
            {"option_id": "i-2", "goods_title": "示例商品乙", "name": "安装说明书乙", "observed_at": NOW}]}
        result = decide(job("rules", [rule(kind="instruction", match="说明书乙")], options=options), CONFIG)
        self.assertEqual(result["item"], {"type": "instruction", "option_id": "i-2"})

    def test_ambiguous_or_missing_target_uses_reply_or_original_behaviour(self):
        for options in (AMBIGUOUS_GOODS, {"instructions": OPTIONS["instructions"]}):
            with self.subTest(options=sorted(options)), patch("backend.engine._post") as post:
                miss = decide(job("rules", [rule(kind="goods_card")], options=options), CONFIG)
                self.assertEqual((miss["action"], miss["reason"]), ("handoff", "no_matching_rule"))
                post.assert_not_called()
            fixed = decide(job("rules", [rule(kind="goods_card", reply=" 固定回复 ")], options=options), CONFIG)
            self.assertEqual((fixed["action"], fixed["text"], fixed["reason"]), ("reply", " 固定回复 ", "rule:manual"))

    def test_missing_rule_type_candidates_falls_through_to_hybrid_model(self):
        with patch("backend.engine._post", return_value=output({"action": "reply", "text": "请问需要哪类资料？", "reason": "clarify"})) as post:
            result = decide(job("hybrid", [rule(kind="video")], options={"instructions": OPTIONS["instructions"]}), CONFIG)
        self.assertEqual(result["text"], "请问需要哪类资料？")
        self.assertEqual(post.call_count, 1)

    def test_hybrid_unusable_send_only_rule_descriptor_is_omitted(self):
        with patch("backend.engine._post", return_value=output({"action": "reply", "text": "请问是哪件商品？", "reason": "clarify"})) as post:
            result = decide(job("hybrid", [rule(rule_id="ambiguous", kind="goods_card")], options=AMBIGUOUS_GOODS), CONFIG)
        self.assertEqual(result["action"], "reply")
        self.assertEqual(result["text"], "请问是哪件商品？")
        self.assertEqual(post.call_count, 1)
        system = post.call_args.args[1]["messages"][0]["content"]
        self.assertNotIn("ambiguous", system)

    def test_hybrid_omitted_send_only_rule_cannot_be_selected(self):
        with patch("backend.engine._post", side_effect=[
                output({"rule_id": "ambiguous"}),
                output({"action": "reply", "text": "备用澄清", "reason": "clarify"})]) as post:
            result = decide(job("hybrid", [rule(rule_id="ambiguous", kind="goods_card")], options=AMBIGUOUS_GOODS), CONFIG)
        self.assertEqual(post.call_count, 2)
        self.assertEqual(result["text"], "备用澄清")
        self.assertIn("fallback=invalid_output", result["reason"])

    def test_rules_mode_without_hit_never_calls_provider_or_sends(self):
        with patch("backend.engine._post") as post:
            result = decide(job("rules", [rule(kind="instruction", contains="未出现的词")]), CONFIG)
        self.assertEqual((result["action"], result["reason"]), ("handoff", "no_matching_rule"))
        post.assert_not_called()

    def test_integrity_gates_precede_item_send(self):
        for modifier, expected in (("disabled", "shop_disabled"), ("incomplete", "history_incomplete"),
                                   ("future", "message_future"), ("role", "no_new_buyer_message")):
            item = job("rules", [rule(kind="instruction")])
            if modifier == "disabled":
                item["settings"]["enabled"] = False
            if modifier == "incomplete":
                item["payload"]["context"]["history_complete"] = False
            if modifier == "future":
                item["payload"]["received_at"] = time.time() + 30
            if modifier == "role":
                item["payload"]["context"]["messages"][-1]["role"] = "system"
            with self.subTest(modifier=modifier), patch("backend.engine._post") as post:
                self.assertEqual(decide(item, CONFIG)["reason"], expected)
                post.assert_not_called()


class SendItemHybridTests(unittest.TestCase):
    def test_semantic_hit_sends_rule_target_and_ignores_forged_model_item(self):
        forged = {"rule_id": "manual", "item": {"type": "video", "option_id": "v-1"},
                  "action": "reply", "text": "模型改写"}
        with patch("backend.engine._post", return_value=output(forged)) as post:
            result = decide(job("hybrid", [rule(kind="instruction", contains="无关关键词")]), CONFIG)
        self.assertEqual(post.call_count, 1)
        self.assertEqual(result["action"], "send_item")
        self.assertEqual(result["item"], {"type": "instruction", "option_id": "i-1"})
        self.assertEqual(result["reason"], "rule_semantic:manual")
        self.assertNotIn("text", result)

    def test_semantic_hit_keeps_exact_fixed_text_reply(self):
        with patch("backend.engine._post", return_value=output({"rule_id": "fixed", "text": "模型改写"})):
            result = decide(job("hybrid", [rule(rule_id="fixed", reply=" 固定文字 ", contains="无关关键词")]), CONFIG)
        self.assertEqual((result["action"], result["text"], result["reason"]), ("reply", " 固定文字 ", "rule_semantic:fixed"))


class SendItemCapabilityTests(unittest.TestCase):
    def test_missing_or_empty_capability_never_sends(self):
        for capabilities in (None, [], ["other_capability"]):
            with self.subTest(capabilities=capabilities):
                result = decide(job("rules", [rule(kind="instruction")], capabilities=capabilities), CONFIG)
                self.assertEqual((result["action"], result["reason"]), ("handoff", "no_matching_rule"))
                self.assertNotIn("item", result)
                fixed = decide(job("rules", [rule(kind="instruction", reply="固定回复")], capabilities=capabilities), CONFIG)
                self.assertEqual((fixed["action"], fixed["text"]), ("reply", "固定回复"))

    def test_model_send_item_without_capability_is_invalid_output(self):
        send = {"action": "send_item", "item": {"type": "instruction", "option_id": "i-1"}, "reason": "send"}
        with patch("backend.engine._post", side_effect=[output(send), output({"action": "reply", "text": "普通回复", "reason": "text"})]) as post:
            result = decide(job("model", capabilities=[]), CONFIG)
        self.assertEqual(post.call_count, 2)
        self.assertEqual(result["text"], "普通回复")
        self.assertIn("fallback=invalid_output", result["reason"])
        prompt = post.call_args_list[0].args[1]["messages"][1]["content"]
        self.assertNotIn("send_options", prompt)
        self.assertNotIn("send_candidates", prompt)
        self.assertNotIn("i-1", prompt)


class SendItemModelTests(unittest.TestCase):
    def test_direct_send_item_uses_current_candidate_and_no_text(self):
        send = {"action": "send_item", "item": {"type": "video", "option_id": "v-1"}, "reason": "choose"}
        with patch("backend.engine._post", return_value=output(send)) as post:
            result = decide(job("model"), CONFIG)
        self.assertEqual(result["action"], "send_item")
        self.assertEqual(result["item"], {"type": "video", "option_id": "v-1"})
        self.assertEqual(result["reason"], "model:primary:choose")
        self.assertNotIn("text", result)
        parsed = json.loads(post.call_args.args[1]["messages"][1]["content"])
        self.assertNotIn("send_options", parsed)
        self.assertEqual(parsed["send_candidates"]["video"], [{"option_id": "v-1", "name": "示例视频", "duration": 30}])
        self.assertEqual(parsed["send_candidates"]["instruction"],
                         [{"option_id": "i-1", "goods_title": "示例商品", "name": "示例说明书"}])
        self.assertNotIn("observed_at", json.dumps(parsed["send_candidates"]))

    def test_invalid_direct_send_items_fall_back_once(self):
        invalid = [{"type": "video", "option_id": "i-1"},        # cross-type id
                   {"type": "video", "option_id": "v-9"},        # invented id
                   {"type": "image", "option_id": "v-1"},        # unsupported type
                   {"type": "video", "option_id": "v-1", "name": "x"},
                   "v-1", None]
        for item in invalid:
            with self.subTest(item=item), patch("backend.engine._post", side_effect=[
                    output({"action": "send_item", "item": item, "reason": "send"}),
                    output({"action": "reply", "text": "备用回复", "reason": "ok"})]) as post:
                result = decide(job("model"), CONFIG)
            self.assertEqual(post.call_count, 2)
            self.assertEqual(result["text"], "备用回复")
            self.assertIn("fallback=invalid_output", result["reason"])

    def test_two_invalid_outputs_hand_off_without_sending(self):
        send = {"action": "send_item", "item": {"type": "goods_card", "option_id": "v-1"}, "reason": "send"}
        with patch("backend.engine._post", side_effect=[output(send), output(send)]) as post:
            result = decide(job("model"), CONFIG)
        self.assertEqual(post.call_count, 2)
        self.assertEqual(result["action"], "handoff")
        self.assertEqual(result["reason"], "model_unavailable:primary=invalid_output,backup=invalid_output")

    def test_model_mode_cannot_select_a_send_rule(self):
        with patch("backend.engine._post", side_effect=[
                output({"rule_id": "manual"}),
                output({"action": "reply", "text": "备用回复", "reason": "ok"})]) as post:
            result = decide(job("model", [rule(kind="instruction")]), CONFIG)
        self.assertEqual(post.call_count, 2)
        self.assertEqual(result["text"], "备用回复")
        self.assertIn("fallback=invalid_output", result["reason"])
        self.assertNotIn("manual", post.call_args_list[0].args[1]["messages"][0]["content"])

    def test_other_events_candidates_never_reach_prompt_or_decision(self):
        with patch("backend.engine._post", side_effect=[
                output({"action": "send_item", "item": {"type": "video", "option_id": "other-v"}, "reason": "send"}),
                output({"action": "reply", "text": "备用回复", "reason": "ok"})]) as post:
            result = decide(job("model", options=OPTIONS), CONFIG)
        self.assertIn("fallback=invalid_output", result["reason"])
        for call in post.call_args_list:
            prompt = call.args[1]["messages"][1]["content"]
            self.assertNotIn("other-v", prompt)
            self.assertNotIn("其他视频", prompt)
        with patch("backend.engine._post") as post:
            miss = decide(job("rules", [rule(kind="video")], options={"instructions": OPTIONS["instructions"]}), CONFIG)
        self.assertEqual((miss["action"], miss["reason"]), ("handoff", "no_matching_rule"))
        post.assert_not_called()

    def test_model_content_never_carries_raw_send_options(self):
        context = {"history_complete": True, "messages": [message()], "send_options": copy.deepcopy(OPTIONS)}
        text = model_content(context)
        self.assertNotIn("send_options", text)
        self.assertNotIn("i-1", text)
        self.assertIn("m-1", text)


class SendItemMultimodalTests(unittest.TestCase):
    def test_text_with_image_goes_to_model_instead_of_keyword_item(self):
        context_message = message("需要资料", attachments=[media.ATTACHMENT])
        with patch("backend.engine._post", return_value=output({"action": "reply", "text": "看图回复", "reason": "image"})) as post:
            result = decide(job("hybrid", [rule(kind="instruction")], messages=[context_message]), CONFIG)
        self.assertEqual(result["action"], "reply")
        self.assertEqual(post.call_count, 1)
        parts = post.call_args.args[1]["messages"][1]["content"]
        self.assertEqual(parts[-1], {"type": "image_url", "image_url": {"url": media.ATTACHMENT["data_url"]}})
        self.assertNotIn("send_options", parts[0]["text"])


if __name__ == "__main__":
    unittest.main()
