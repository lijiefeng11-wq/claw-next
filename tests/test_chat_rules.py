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

REJECT_LABEL = "未通过来源、字段或冲突核验"


def session(question="怎么清洁？", answer="使用软布。"):
    return {"buyer_id": "private-user", "messages": [
        {"role": "买家", "type": "文本", "content": question},
        {"role": "客服", "type": "文本", "content": answer}]}


def wire_of(candidates, warnings=None):
    value = {"candidates": candidates, "warnings": [] if warnings is None else warnings}
    return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(value, ensure_ascii=False)}}]}


def labelled(result, label):
    return [w for w in result["warnings"] if label in w]


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

    def wire(self, candidate=None, warnings=None):
        return wire_of([candidate or self.candidate], warnings)

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
        with patch.object(rules, "_post", return_value=wire_of(value["candidates"])):
            result = rules.generate(pairs, self.existing, self.config)
        self.assertEqual(len(result["candidates"]), 1)
        self.assertEqual(result["candidates"][0]["count"], 3)
        self.assertTrue(any("不足两个独立来源" in w for w in result["warnings"]))
        self.assertEqual(len(labelled(result, REJECT_LABEL)), 0)

    def test_no_provider_fallback_and_no_response_echo(self):
        with patch.object(rules, "_post", side_effect=ProviderFailure("timeout")) as post:
            with self.assertRaises(ProviderFailure):
                rules.generate(self.pairs, [], self.config)
        post.assert_called_once()

    def test_empty_is_valid_when_there_are_no_repeated_topics(self):
        with patch.object(rules, "_post", return_value=wire_of([])):
            self.assertEqual(rules.generate(self.pairs, [], self.config)["candidates"], [])


class CandidateIsolationTests(unittest.TestCase):
    setUp = RuleDraftTests.setUp
    wire = RuleDraftTests.wire
    """Invalid individual drafts drop only themselves; whole-response faults still raise."""

    def test_whole_response_rejection_still_raises_with_fixed_reason(self):
        private = "PRIVATE-MODEL-TEXT-9f3a7c"
        first = {**self.candidate, "evidence_ids": ["p1", "p2"]}
        cases = [(private, "output_schema"),
                 (json.dumps({"candidates": [], "warnings": [], "extra": private}), "output_schema"),
                 (json.dumps({"candidates": [first] * 31, "warnings": []}), "output_schema"),
                 (json.dumps({"candidates": first, "warnings": []}), "output_schema"),
                 (json.dumps(True), "output_schema"),
                 (json.dumps({"candidates": [], "warnings": [private + "x" * 500]}), "notes_malformed")]
        for content, reason in cases:
            with self.subTest(reason=reason, content=content[:20]):
                wire = {"choices": [{"message": {"content": content}}]}
                with patch.object(rules, "_post", return_value=wire) as post, \
                        patch.object(rules.diagnostics, "emit") as emit:
                    with self.assertRaises(ProviderFailure) as raised:
                        rules.generate(self.pairs, self.existing, self.config)
                self.assertEqual(raised.exception.code, "invalid_output")
                post.assert_called_once()
                emit.assert_called_once_with("admin_assist_output_rejected", operation="rule_draft", reason=reason)
                self.assertNotIn(private, str(emit.call_args) + str(raised.exception))
        for response in ({"choices": [{"finish_reason": "length"}]}, {}):
            with patch.object(rules, "_post", return_value=response):
                with self.assertRaises(ProviderFailure):
                    rules.generate(self.pairs, [], self.config)

    def test_invalid_candidates_drop_whole_draft_and_valid_unrelated_survive(self):
        private = "PRIVATE-MODEL-TEXT-9f3a7c"
        valid = {**self.candidate, "evidence_ids": ["p1", "p2", "p3"], "contains": "怎么清洁"}
        pairs = self.pairs + [{"id": "p" + str(i), "conversation": "c" + str(i),
                               "question": "安装第" + str(i) + "步？", "answer": "按说明书。"} for i in (4, 5)]
        changes = [{"evidence_ids": ["p1", "missing"]}, {"evidence_ids": [private, "p2"]},
                   {"evidence_ids": [["p4"], "p5"]}, {"evidence_ids": ["p4", "p4"]},
                   {"evidence_ids": []}, {"conflicts": ["unknown"]}, {"conflicts": [private]},
                   {"reply": "x" * 2001}, {"warnings": "none"}, {"contains": "   "},
                   {"extra": private}]
        for change in changes:
            with self.subTest(change=list(change)[0]):
                bad = {"contains": "安装步骤", "description": "安装", "reply": "按说明书操作。",
                       "evidence_ids": ["p4", "p5"], "conflicts": [], "warnings": []}
                bad.update(change)
                with patch.object(rules, "_post", return_value=wire_of([bad, valid])) as post, \
                        patch.object(rules.diagnostics, "emit") as emit:
                    result = rules.generate(pairs, self.existing, self.config)
                post.assert_called_once()
                emit.assert_called_once()
                self.assertEqual(emit.call_args.kwargs.get("operation"), "rule_draft")
                self.assertEqual(len(result["candidates"]), 1)
                self.assertEqual(result["candidates"][0]["contains"], "怎么清洁")
                self.assertEqual(result["candidates"][0]["evidence_ids"], ["p1", "p2", "p3"])
                self.assertTrue(any("已整条剔除 1 条" in w for w in result["warnings"]))
                self.assertNotIn(private, json.dumps(result, ensure_ascii=False))

    def test_all_candidates_invalid_returns_empty_with_one_fixed_warning(self):
        bad = {**self.candidate, "evidence_ids": ["p1", "missing"]}
        with patch.object(rules, "_post", return_value=wire_of([bad, {**bad, "contains": "维护"}])) as post, \
                patch.object(rules.diagnostics, "emit") as emit:
            result = rules.generate(self.pairs, self.existing, self.config)
        post.assert_called_once()
        self.assertEqual(emit.call_count, 2)
        self.assertEqual(result["candidates"], [])
        self.assertEqual(len(labelled(result, REJECT_LABEL)), 1)

    def test_rejected_candidate_consumes_no_evidence_for_later_candidate(self):
        # First draft is invalid (unknown conflict) while holding p1/p2; those refs
        # must stay available so a later valid draft reusing them is accepted.
        invalid = {**self.candidate, "evidence_ids": ["p1", "p2"], "conflicts": ["unknown"]}
        later = {**self.candidate, "evidence_ids": ["p1", "p2"]}
        with patch.object(rules, "_post", return_value=wire_of([invalid, later])), \
                patch.object(rules.diagnostics, "emit") as emit:
            result = rules.generate(self.pairs, [], self.config)
        self.assertEqual(emit.call_count, 1)
        self.assertEqual(len(result["candidates"]), 1)
        self.assertEqual(result["candidates"][0]["evidence_ids"], ["p1", "p2"])
        self.assertEqual(len(labelled(result, REJECT_LABEL)), 1)

    def test_rejected_candidate_before_frequency_check_reserves_no_evidence(self):
        # The malformed first draft is rejected while holding p1; the later draft
        # reusing p1 must still be evaluated on its own (here: singleton drop).
        malformed = {"contains": "单次维护", "description": "单次",
                     "reply": "需核实。", "evidence_ids": ["p1"], "conflicts": []}
        later = {"contains": "单次维护", "description": "单次",
                 "reply": "需核实。", "evidence_ids": ["p1"], "conflicts": [], "warnings": []}
        with patch.object(rules, "_post", return_value=wire_of([malformed, later])) as post, \
                patch.object(rules.diagnostics, "emit") as emit:
            result = rules.generate(self.pairs, [], self.config)
        post.assert_called_once()
        emit.assert_called_once()
        self.assertEqual(result["candidates"], [])
        self.assertEqual(len(labelled(result, REJECT_LABEL)), 1)
        self.assertTrue(any("不足两个独立来源" in w for w in result["warnings"]))

    def test_rejected_candidate_payload_is_not_echoed_or_scrubbed_into_result(self):
        private = "PRIVATE-MODEL-TEXT-9f3a7c"
        mixed = {**self.candidate, "description": private, "evidence_ids": ["p9"]}
        with patch.object(rules, "_post", return_value=wire_of([mixed])):
            result = rules.generate(self.pairs, [], self.config)
        self.assertEqual(result["candidates"], [])
        self.assertNotIn(private, json.dumps(result, ensure_ascii=False))


class SourceAliasTests(unittest.TestCase):
    setUp = RuleDraftTests.setUp
    wire = RuleDraftTests.wire
    def _pairs(self):
        return [{"id": self.pairs[0]["id"], "conversation": self.pairs[0]["conversation"],
                 "question": self.pairs[0]["question"], "answer": self.pairs[0]["answer"]},
                {"id": "p900", "conversation": "c50", "question": "有异味吗？", "answer": "新货需通风。"},
                {"id": "p17", "conversation": "c7", "question": "怎么清洁？", "answer": "使用软布。"}]

    def test_sparse_ids_are_aliased_seqentially_and_mapped_back(self):
        pairs = self._pairs()
        sent_ids = []
        def fake_post(spec, body):
            sent_ids.extend(p["id"] for p in json.loads(body["messages"][1]["content"])["pairs"])
            return wire_of([{**self.candidate, "evidence_ids": ["p1", "p2", "p3"]}])
        with patch.object(rules, "_post", side_effect=fake_post) as post:
            result = rules.generate(pairs, [], self.config)
        post.assert_called_once()
        self.assertEqual(sent_ids, ["p1", "p2", "p3"])
        body = json.loads(post.call_args.args[1]["messages"][1]["content"])
        self.assertEqual([p["conversation"] for p in body["pairs"]], ["c1", "c50", "c7"])
        self.assertEqual(result["candidates"][0]["evidence_ids"], ["p1", "p900", "p17"])
        self.assertEqual(result["candidates"][0]["count"], 3)

    def test_count_uses_original_conversations_not_alias_index(self):
        pairs = self._pairs()
        pairs[1]["conversation"] = pairs[0]["conversation"]  # p900 shares c1 with p1; c50/c7 unused
        sent = []
        def fake_post(spec, body):
            sent.extend(json.loads(body["messages"][1]["content"])["pairs"])
            # Aliases p1+p2 span one original conversation -> must be dropped.
            return wire_of([{**self.candidate, "evidence_ids": ["p1", "p2"]},
                            {**self.candidate, "contains": "异味", "evidence_ids": ["p9"]}])
        with patch.object(rules, "_post", side_effect=fake_post):
            result = rules.generate(pairs, [], self.config)
        self.assertEqual([p["conversation"] for p in sent], ["c1", "c1", "c7"])
        self.assertEqual(result["candidates"], [])
        self.assertTrue(any("不足两个独立来源" in w for w in result["warnings"]))
        self.assertEqual(len(labelled(result, REJECT_LABEL)), 1)  # p9 is not a sent alias

    def test_alias_out_of_range_or_original_ids_are_rejected(self):
        pairs = self._pairs()
        for refs in (["p1", "p5"], ["p17", "p900"], ["p0", "p1"], ["p3", "c7"]):
            with self.subTest(refs=refs):
                with patch.object(rules, "_post", return_value=wire_of([{**self.candidate, "evidence_ids": refs}])):
                    result = rules.generate(pairs, [], self.config)
                self.assertEqual(result["candidates"], [])
                self.assertEqual(len(labelled(result, REJECT_LABEL)), 1)


class ReplyGuardTests(unittest.TestCase):
    setUp = RuleDraftTests.setUp
    wire = RuleDraftTests.wire
    """Conservative heuristics only: drafts, not semantic proof of policy."""

    def _generate(self, candidate, pairs=None, existing=None):
        with patch.object(rules, "_post", return_value=wire_of([candidate])):
            return rules.generate(pairs or self.pairs, self.existing if existing is None else existing, self.config)

    def test_vehicle_broad_fit_and_action_promise_become_verify_question(self):
        pairs = [{"id": "p1", "conversation": "c1", "question": "这个车型能用吗？",
                  "answer": "适用的，可以直接下单，我来帮您备注。"},
                 {"id": "p2", "conversation": "c2", "question": "我的车适配吗？",
                  "answer": "这款适配，已给您标红星。"}]
        candidate = {"contains": "车型适配", "description": "车型能不能用", "evidence_ids": ["p1", "p2"],
                     "reply": "适用的，可以直接下单，我来帮您备注。", "conflicts": [], "warnings": []}
        entry = self._generate(candidate, pairs, [])["candidates"][0]
        self.assertEqual(entry["evidence_ids"], ["p1", "p2"])
        self.assertEqual(entry["conflicts"], [])
        self.assertNotIn("可以直接下单", entry["reply"])
        self.assertNotIn("我来帮您备注", entry["reply"])
        self.assertIn("核对", entry["reply"])
        self.assertTrue(any("核对条件" in w for w in entry["warnings"]))
        self.assertTrue(any("代为操作" in w for w in entry["warnings"]))

    def test_unsupported_actions_become_manual_verification_with_warning(self):
        for text in ("我来帮您备注一下。", "已经转人工了。", "已经帮您标红星。", "已为您转接。"):
            with self.subTest(text=text):
                candidate = {**self.candidate, "contains": "备注改地址", "reply": "已确认。" + text}
                entry = self._generate(candidate, existing=[])["candidates"][0]
                self.assertIn("这项操作需要人工进一步确认和处理。", entry["reply"])
                self.assertNotIn(text.rstrip("。"), entry["reply"])
                self.assertTrue(any("人工核对" in w for w in entry["warnings"]))
                self.assertEqual(entry["evidence_ids"], ["p1", "p2", "p3"])
                self.assertEqual(entry["conflicts"], [])

    def test_supported_action_wording_keeps_keyword_conflict_detection(self):
        # A broad existing rule still conflicts with an overlapping keyword, and the
        # guard must not disturb that conflict list or the source refs.
        candidate = {**self.candidate, "contains": "怎么清洁方法",
                     "reply": "我来帮您备注。", "conflicts": []}
        entry = self._generate(candidate)["candidates"][0]
        self.assertEqual(entry["conflicts"], ["old"])
        self.assertEqual(entry["evidence_ids"], ["p1", "p2", "p3"])
        self.assertNotIn("我来帮您备注", entry["reply"])

    def test_explicit_negation_is_not_treated_as_action_promise(self):
        for text in ("我不能帮您备注。", "无法为您标红星。", "不会帮您转人工。"):
            with self.subTest(text=text):
                pairs = [{"id": "p1", "conversation": "c1", "question": "能帮我备注吗？", "answer": text},
                         {"id": "p2", "conversation": "c2", "question": "能标星吗？", "answer": text}]
                candidate = {"contains": "备注协助", "description": "能否代为操作", "evidence_ids": ["p1", "p2"],
                             "reply": text, "conflicts": [], "warnings": []}
                entry = self._generate(candidate, pairs, [])["candidates"][0]
                self.assertEqual(entry["reply"], text)
                self.assertEqual(entry["warnings"], [])

    def test_static_policy_answers_stay_unchanged(self):
        for text in ("材质是304不锈钢。", "安装时请先拧松螺丝。", "退换政策以页面说明为准。",
                     "请使用软布清洁。", "已售出的商品支持七天无理由。"):
            with self.subTest(text=text):
                pairs = [{"id": "p1", "conversation": "c1", "question": "材质/安装/退换？", "answer": text},
                         {"id": "p2", "conversation": "c2", "question": "退换政策？", "answer": text}]
                candidate = {"contains": "商品说明", "description": "资料性咨询", "evidence_ids": ["p1", "p2"],
                             "reply": text, "conflicts": [], "warnings": []}
                entry = self._generate(candidate, pairs, [])["candidates"][0]
                self.assertEqual(entry["reply"], text)
                self.assertEqual(entry["warnings"], [])

    def test_valid_source_ids_and_declared_conflicts_survive_guard(self):
        candidate = {"contains": "车型适配", "description": "适配", "evidence_ids": ["p1", "p2"],
                     "reply": "适配，已给您标红星。", "conflicts": ["old"], "warnings": ["来源不一致"]}
        entry = self._generate(candidate)["candidates"][0]
        self.assertEqual(entry["evidence_ids"], ["p1", "p2"])
        self.assertEqual(entry["conflicts"], ["old"])
        self.assertIn("来源不一致", entry["warnings"])
        self.assertNotIn("标红星", entry["reply"])


class DiagnosticTests(unittest.TestCase):
    setUp = RuleDraftTests.setUp
    wire = RuleDraftTests.wire
    def test_validation_reasons_are_fixed_metadata_through_partial_results(self):
        private = "PRIVATE-MODEL-TEXT-9f3a7c"
        self.pairs.append({"id": "p4", "conversation": "c4", "question": "怎么清洁？", "answer": "使用软布。"})
        first = {**self.candidate, "evidence_ids": ["p1", "p2"]}
        cases = [
            ({**first, "extra": private}, "candidate_fields"),
            ({**first, "reply": private + "x" * 2001}, "candidate_fields"),
            ({**first, "evidence_ids": [private, "p2"]}, "evidence_invalid"),
            ({**first, "evidence_ids": [["p1"], "p2"]}, "evidence_invalid"),
            ({**first, "evidence_ids": ["p1", "p1"]}, "evidence_duplicate"),
            ({**first, "conflicts": [private]}, "conflict_unknown"),
            ({**first, "warnings": private}, "notes_malformed"),
        ]
        for bad, reason in cases:
            with self.subTest(reason=reason):
                with patch.object(rules, "_post", return_value=wire_of([bad])) as post, \
                        patch.object(rules.diagnostics, "emit") as emit:
                    result = rules.generate(self.pairs, self.existing, self.config)
                post.assert_called_once()
                emit.assert_called_once_with("admin_assist_output_rejected", operation="rule_draft", reason=reason)
                self.assertEqual(result["candidates"], [])
                self.assertEqual(len(labelled(result, REJECT_LABEL)), 1)
                self.assertNotIn(private, str(emit.call_args) + json.dumps(result, ensure_ascii=False))

    def test_evidence_reuse_drops_later_duplicate_draft(self):
        first = {**self.candidate, "evidence_ids": ["p1", "p2"]}
        with patch.object(rules, "_post", return_value=wire_of([first, {**first, "contains": "维护"}])), \
                patch.object(rules.diagnostics, "emit") as emit:
            result = rules.generate(self.pairs, self.existing, self.config)
        emit.assert_called_once_with("admin_assist_output_rejected", operation="rule_draft", reason="evidence_reused")
        self.assertEqual(len(result["candidates"]), 1)
        self.assertEqual(result["candidates"][0]["evidence_ids"], ["p1", "p2"])
        self.assertEqual(len(labelled(result, REJECT_LABEL)), 1)

    def test_same_keyword_with_disjoint_valid_sources_drops_later_draft(self):
        self.pairs.append({"id": "p4", "conversation": "c4", "question": "如何保养？", "answer": "使用软布。"})
        first = {**self.candidate, "evidence_ids": ["p1", "p2"]}
        later = {**self.candidate, "evidence_ids": ["p3", "p4"], "contains": " 怎么清洁 "}
        with patch.object(rules, "_post", return_value=wire_of([first, later])), \
                patch.object(rules.diagnostics, "emit") as emit:
            result = rules.generate(self.pairs, self.existing, self.config)
        emit.assert_called_once_with("admin_assist_output_rejected", operation="rule_draft", reason="keyword_duplicate")
        self.assertEqual(len(result["candidates"]), 1)
        self.assertEqual(result["candidates"][0]["evidence_ids"], ["p1", "p2"])
        self.assertTrue(any("剔除 1 条" in warning for warning in result["warnings"]))

    def test_unknown_diagnostic_reason_cannot_echo_content(self):
        with patch.object(rules.diagnostics, "emit") as emit:
            with self.assertRaises(ProviderFailure):
                rules._reject("PRIVATE-MODEL-TEXT-9f3a7c")
        emit.assert_called_once_with("admin_assist_output_rejected", operation="rule_draft", reason="output_schema")

    def test_valid_and_singleton_results_do_not_emit_rejection(self):
        singleton = {**self.candidate, "contains": "单次维护", "evidence_ids": ["p1"]}
        with patch.object(rules, "_post", return_value=wire_of([singleton, self.candidate])), \
                patch.object(rules.diagnostics, "emit") as emit:
            result = rules.generate(self.pairs, self.existing, self.config)
        self.assertEqual(len(result["candidates"]), 1)
        self.assertEqual(result["candidates"][0]["count"], 3)
        emit.assert_not_called()


if __name__ == "__main__":
    unittest.main()
