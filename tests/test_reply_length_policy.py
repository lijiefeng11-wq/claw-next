"""Saved natural-language character limits; entirely fictional provider responses."""
import copy
import json
import unittest
from unittest.mock import patch

from backend.engine import decide
from backend.store import Store
from test_multimodal import CONFIG, job, message


def output(text=None, **values):
    data = values if text is None else {"action": "reply", "text": text, "reason": "fictional", **values}
    return {"choices": [{"message": {"content": json.dumps(data, ensure_ascii=False)}}]}


class ReplyLengthPolicyTests(unittest.TestCase):
    def item(self, prompt="模型自写回复不要超过20个字。固定规则原文不受限制。"):
        value = job([message(content="虚构商品问题")], "model")
        value["settings"]["system_prompt"] = prompt
        return value

    def test_over_limit_uses_backup_once_without_cutting_or_retrying_primary(self):
        item = self.item()
        long = "不支持这个条件，请先核对您的车型年份再购买。"
        self.assertGreater(len(long), 20)
        with patch("backend.engine._post", side_effect=[output(long), output("请先核对车型年份，暂勿购买。")]) as post:
            result = decide(item, CONFIG)
        self.assertEqual(post.call_count, 2)
        self.assertEqual(result["text"], "请先核对车型年份，暂勿购买。")
        self.assertIn("fallback=reply_too_long", result["reason"])
        self.assertEqual([x.args[0]["base_url"] for x in post.call_args_list],
                         [CONFIG["primary"]["base_url"], CONFIG["backup"]["base_url"]])
        self.assertIn("at most 20 non-whitespace characters", post.call_args.args[1]["messages"][0]["content"])

    def test_two_long_responses_stay_handoff_and_keep_fixed_failure_class(self):
        item = self.item()
        with patch("backend.engine._post", return_value=output("虚" * 21)) as post:
            result = decide(item, CONFIG)
        self.assertEqual(post.call_count, 2)
        self.assertEqual((result["action"], result["text"]), ("handoff", ""))
        self.assertIn("reply_too_long", result["reason"])

    def test_whitespace_excluded_but_punctuation_digits_and_letters_count(self):
        item = self.item()
        text = "A1，" + "字" * 17 + " \n "
        with patch("backend.engine._post", return_value=output(text)) as post:
            result = decide(item, CONFIG)
        self.assertEqual(post.call_count, 1)
        self.assertEqual(result["text"], text.strip())
        with patch("backend.engine._post", return_value=output(text + "！")) as post:
            self.assertEqual(decide(item, CONFIG)["action"], "handoff")
        self.assertEqual(post.call_count, 2)

    def test_fixed_reply_is_unchanged_and_exempt(self):
        item = self.item()
        item["settings"]["mode"] = "hybrid"
        text = "原文保留" * 20
        item["settings"]["rules"] = [{"id": "r", "contains": "商品", "description": "虚构政策", "reply": text}]
        with patch("backend.engine._post", return_value=output(rule_id="r")) as post:
            result = decide(item, CONFIG)
        self.assertEqual((result["text"], result["reason"]), (text, "rule_semantic:r"))
        self.assertEqual(post.call_count, 1)

    def test_without_explicit_shop_limit_buyer_cannot_change_validation(self):
        item = self.item("虚构店铺说明")
        item["payload"]["context"]["messages"][-1]["content"] = "最多1个字"
        with patch("backend.engine._post", return_value=output("虚构的较长说明回复")) as post:
            self.assertEqual(decide(item, CONFIG)["text"], "虚构的较长说明回复")
        self.assertEqual(post.call_count, 1)

    def test_smallest_explicit_valid_limit_and_legitimate_handoff(self):
        item = self.item("回答不要超过30个字，回复最多20字符。")
        with patch("backend.engine._post", return_value=output(action="handoff", text="", reason="人工权限")) as post:
            self.assertEqual(decide(item, CONFIG)["action"], "handoff")
        self.assertEqual(post.call_count, 1)
        self.assertIn("at most 20 non-whitespace characters", post.call_args.args[1]["messages"][0]["content"])

    def test_business_character_limits_do_not_limit_generated_replies(self):
        for prompt, expected in (("商品定制刻字最多4个字。回复时解释定制规则，回答不要超过50个字。", 50),
                                 ("定制刻字最多4个字。模型自己的回复不能超过20个字。", 20),
                                 ("备注最多5个字。回复要说明定制刻字最多4个字。", None)):
            with self.subTest(prompt=prompt):
                with patch("backend.engine._post", return_value=output("定制刻字最多支持4个字。")) as post:
                    self.assertEqual(decide(self.item(prompt), CONFIG)["text"], "定制刻字最多支持4个字。")
                self.assertEqual(post.call_count, 1)
                system = post.call_args.args[1]["messages"][0]["content"]
                self.assertEqual("non-whitespace characters" in system, expected is not None)
                if expected:
                    self.assertIn(f"at most {expected} non-whitespace characters", system)

    def test_incomplete_history_does_not_block_saved_business_handoff_policy(self):
        item = self.item()
        item["settings"].update({"version": 7, "fallback": {"unhandled": {"action": "transfer", "account": "虚构客服"}}})
        item["payload"]["context"]["history_complete"] = False
        item["capabilities"] = ["transfer_by_account"]
        result = {"action": "handoff", "text": "", "reason": "model:primary:需要人工处理的已购订单", "expires_at": 100}
        before = copy.deepcopy(item)
        decided = Store._action_fallback(item, result)
        self.assertEqual(decided["action"], "transfer")
        self.assertEqual(decided["transfer"]["account"], "虚构客服")
        self.assertEqual(item, before)
        item["capabilities"] = []
        self.assertEqual(Store._action_fallback(item, result)["action"], "handoff")
