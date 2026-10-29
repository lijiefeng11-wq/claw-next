"""Synthetic imports and model responses; no customer records or live requests."""
import copy
import json
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from backend import chatrules as rules
from backend.engine import ProviderFailure


def session(question="怎么清洁？", answer="使用软布。"):
    return {"buyer_id": "private-user", "messages": [
        {"role": "买家", "type": "文本", "content": question},
        {"role": "客服", "type": "文本", "content": answer}]}


class ChatImportTests(unittest.TestCase):
    def test_jsonl_and_json_preserve_anonymous_distinct_conversations(self):
        for filename, text in (("a.json", json.dumps([session(), session()])),
                               ("a.jsonl", "\n".join(json.dumps(session()) for _ in range(2)))):
            result = rules.parse_import(filename, text)
            self.assertEqual(len(result["pairs"]), 2)
            self.assertEqual(rules.validate_pairs(result["pairs"]), result["pairs"])
            self.assertNotEqual(result["pairs"][0]["conversation"], result["pairs"][1]["conversation"])
            self.assertNotIn("private-user", json.dumps(result))

    def test_csv_and_txt_roles(self):
        for filename, text in (("a.csv", "问题,回答\n怎么清洁,软布\n怎样清洁,软布"),
                               ("a.txt", "买家：怎么清洁\n客服：软布\n\nbuyer: 如何清洁\nagent: 软布")):
            pairs = rules.parse_import(filename, text)["pairs"]
            self.assertEqual(len(pairs), 2)
            self.assertNotEqual(pairs[0]["conversation"], pairs[1]["conversation"])

    def test_no_pair_across_media_unknown_role_or_session_boundary(self):
        for gap in ({"role": "系统", "content": "notice"}, {"role": "买家", "type": "图片", "content": "url"}, {}):
            record = session()
            record["messages"].insert(1, gap)
            with self.assertRaises(ValueError):
                rules.parse_import("test.json", json.dumps(record))
        record = session()["messages"]
        with self.assertRaises(ValueError):
            rules.parse_import("test.json", json.dumps([{"messages": [record[0]]}, {"messages": [record[1]]}]))

    def test_bursts_preserve_conditions_and_never_truncate(self):
        record = session()
        record["messages"].insert(1, {"role": "买家", "content": "仅外侧吗？"})
        record["messages"].append({"role": "客服", "content": "仅外侧，不用溶剂。"})
        pair = rules.parse_import("test.json", json.dumps(record))["pairs"][0]
        self.assertIn("仅外侧吗", pair["question"])
        self.assertIn("不用溶剂", pair["answer"])
        with self.assertRaises(ValueError):
            rules.parse_import("test.json", json.dumps(session(answer="长" * 1001)))

    def test_contact_metadata_and_urls_do_not_leave_import(self):
        record = session(question="链接 https://example.test/private 看一下，怎么清洁？", answer="软布。电话13812345678")
        result = rules.parse_import("private-name.json", json.dumps(record))
        encoded = json.dumps(result, ensure_ascii=False)
        for private in ("https://", "13812345678", "private-name", "private-user"):
            self.assertNotIn(private, encoded)
        with self.assertRaises(ValueError):
            rules.parse_import("test.json", json.dumps(session(answer="收货地址：某市某路1号")))

    def test_sampling_is_spread_and_reported_not_only_prefix(self):
        records = [session(question="怎么清洁第" + str(i) + "种？") for i in range(450)]
        result = rules.parse_import("a.json", json.dumps(records))
        self.assertEqual(result["stats"]["eligible"], 450)
        self.assertEqual(result["stats"]["selected"], 200)
        self.assertIn("447", result["pairs"][-1]["question"])
        self.assertTrue(any("抽样" in w for w in result["warnings"]))

    def test_revalidate_rejects_forged_shapes_duplicates_and_overlong_values(self):
        pairs = rules.parse_import("a.json", json.dumps([session(), session()]))["pairs"]
        bad = [[], [pairs[0], pairs[0]], [{**pairs[0], "question": "x" * 501}],
               [{**pairs[0], "conversation": "private-external-id"}], [{**pairs[0], "extra": "secret"}]]
        for value in bad:
            with self.assertRaises(ValueError):
                rules.validate_pairs(value)


class RuleDraftTests(unittest.TestCase):
    def setUp(self):
        self.pairs = rules.parse_import("a.json", json.dumps([session(), session(), session()]))["pairs"]
        self.existing = [{"id": "old", "contains": "清洁", "description": "清洁方法", "reply": "旧说明"}]
        self.config = {"primary": {"base_url": "http://127.0.0.1:8000/v1", "model": "Qwen3.6-35B-A3B-4bit", "timeout_seconds": 10},
                       "backup": {"base_url": "http://127.0.0.1:9", "model": "never-called"}}
        self.candidate = {"contains": "怎么清洁", "description": "咨询清洁方法", "reply": "请使用软布。",
                          "evidence_ids": [p["id"] for p in self.pairs], "conflicts": [], "warnings": []}

    def wire(self, candidate=None):
        return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(
            {"candidates": [candidate or self.candidate], "warnings": []}, ensure_ascii=False)}}]}

    def test_source_count_conflict_and_request_only_options(self):
        before = copy.deepcopy((self.config, self.pairs, self.existing))
        with patch.object(rules, "_post", return_value=self.wire()) as post:
            result = rules.generate(self.pairs, self.existing, self.config)
        self.assertEqual(result["candidates"][0]["count"], 3)
        self.assertEqual(result["candidates"][0]["conflicts"], ["old"])
        self.assertEqual((self.config, self.pairs, self.existing), before)
        post.assert_called_once()
        spec, body = post.call_args.args
        self.assertEqual(spec["timeout_seconds"], 60)
        self.assertEqual(body["chat_template_kwargs"], {"enable_thinking": False})
        sent = json.loads(body["messages"][1]["content"])
        self.assertEqual(sent["existing_rules"][0]["reply"], "旧说明")

    def test_frequency_uses_distinct_conversations_not_number_of_pairs(self):
        self.pairs[1]["conversation"] = self.pairs[0]["conversation"]
        with patch.object(rules, "_post", return_value=self.wire()):
            self.assertEqual(rules.generate(self.pairs, [], self.config)["candidates"][0]["count"], 2)
        self.pairs[2]["conversation"] = self.pairs[0]["conversation"]
        with patch.object(rules, "_post", return_value=self.wire()):
            result = rules.generate(self.pairs, [], self.config)
            self.assertEqual(result["candidates"], [])
            self.assertTrue(any("不足两个独立来源" in w for w in result["warnings"]))

    def test_singleton_is_filtered_without_discarding_valid_topics(self):
        pairs = self.pairs + [{"id": "p4", "conversation": "c4", "question": "价格？", "answer": "需人工核实。"}]
        value = {"candidates": [self.candidate, {**self.candidate, "contains": "价格", "evidence_ids": ["p4"]}], "warnings": []}
        wire = {"choices": [{"message": {"content": json.dumps(value)}}]}
        with patch.object(rules, "_post", return_value=wire):
            result = rules.generate(pairs, self.existing, self.config)
        self.assertEqual(len(result["candidates"]), 1)
        self.assertEqual(result["candidates"][0]["count"], 3)
        self.assertTrue(any("已剔除 1 条" in w for w in result["warnings"]))

    def test_invalid_evidence_unknown_conflict_and_partial_output_are_rejected(self):
        for change in ({"evidence_ids": ["p1", "missing"]}, {"evidence_ids": ["p1", "p1"]},
                       {"evidence_ids": [["p1"], "p2"]}, {"conflicts": ["unknown"]},
                       {"reply": "x" * 2001}, {"warnings": "none"}):
            with patch.object(rules, "_post", return_value=self.wire({**self.candidate, **change})):
                with self.assertRaises(ProviderFailure):
                    rules.generate(self.pairs, self.existing, self.config)
        with patch.object(rules, "_post", return_value={"choices": [{"finish_reason": "length"}]}):
            with self.assertRaises(ProviderFailure):
                rules.generate(self.pairs, [], self.config)

    def test_no_provider_fallback_and_no_response_echo(self):
        with patch.object(rules, "_post", side_effect=ProviderFailure("timeout")) as post:
            with self.assertRaises(ProviderFailure):
                rules.generate(self.pairs, [], self.config)
        post.assert_called_once()

    def test_empty_is_valid_when_there_are_no_repeated_topics(self):
        wire = {"choices": [{"message": {"content": '{"candidates":[],"warnings":[]}'}}]}
        with patch.object(rules, "_post", return_value=wire):
            self.assertEqual(rules.generate(self.pairs, [], self.config)["candidates"], [])

    def test_more_than_30_and_reused_evidence_are_rejected(self):
        for candidates in ([self.candidate] * 31, [self.candidate, {**self.candidate, "contains": "维护"}]):
            wire = {"choices": [{"message": {"content": json.dumps({"candidates": candidates, "warnings": []})}}]}
            with patch.object(rules, "_post", return_value=wire):
                with self.assertRaises(ProviderFailure):
                    rules.generate(self.pairs, [], self.config)


if __name__ == "__main__":
    unittest.main()
