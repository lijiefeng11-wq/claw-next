"""Real batch generator/response validation, fictional provider responses only."""
import copy
import json
import pathlib
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from backend import chatbatch, chatrules
from backend.engine import ProviderFailure

CONFIG = {"primary": {"base_url":"http://127.0.0.1:9/v1","model":"primary"},
          "backup": {"base_url":"http://127.0.0.1:9/v1","model":"backup"}}


def pair(number, sources=None, question=None, answer="请人工核对。"):
    source = sources or ["c"+str(number)]
    return {"id":"p"+str(number),"conversation":source[0],"conversations":source,"count":len(set(source)),
            "question":question or "问题"+str(number),"answer":answer}


def candidate(ids, keyword="清洁", reply="请用软布。"):
    return {"contains":keyword,"description":"按具体情况核对","reply":reply,"evidence_ids":ids,"conflicts":[],"warnings":[]}


def wire(*candidates):
    return {"choices":[{"finish_reason":"stop","message":{"content":json.dumps({"candidates":list(candidates),"warnings":[]})}}]}


def model_input(body):
    return json.loads(body["messages"][1]["content"])["pairs"]


class ChatBatchTests(unittest.TestCase):
    def test_every_unique_pair_reaches_a_batch_and_progress_covers_the_entire_file(self):
        pairs=[pair(i) for i in range(1,451)]
        seen,progress=[],[]
        def provider(spec,body):
            sent=model_input(body)
            self.assertLessEqual(len(sent),200)
            self.assertLessEqual(sum(len(p["question"])+len(p["answer"]) for p in sent),24000)
            seen.extend(p["question"] for p in sent)
            return wire()
        with patch.object(chatrules,"_post",side_effect=provider) as post:
            result=chatbatch.analyze(pairs,[],CONFIG,progress=progress.append)
        self.assertEqual(len(seen),450)
        self.assertEqual(len(set(seen)),450)
        self.assertEqual(post.call_count,3)
        self.assertEqual([p["processed_pairs"] for p in progress],[0,200,400,450])
        self.assertEqual(progress[-1]["total_batches"],3)
        self.assertEqual(result["candidates"],[])

    def test_character_bound_does_not_drop_or_truncate_any_pair(self):
        pairs=[pair(i,question="问"*440+str(i),answer="答"*950) for i in range(1,51)]
        sent=[]
        def provider(spec,body):
            batch=model_input(body);sent.extend(batch)
            self.assertLessEqual(sum(len(p["question"])+len(p["answer"]) for p in batch),24000)
            return wire()
        with patch.object(chatrules,"_post",side_effect=provider) as post:
            chatbatch.analyze(pairs,[],CONFIG)
        self.assertEqual(len(sent),50)
        self.assertEqual(post.call_count,3)
        self.assertEqual(sorted(p["question"] for p in sent),sorted(p["question"] for p in pairs))

    def test_cross_batch_source_frequency_is_a_union_and_differing_answers_remain_visible(self):
        pairs=[pair(i,["c"+str(i*2),"c"+str(i*2+1)]) for i in range(1,202)]
        pairs[0]=pair(1,["c1","c2"])
        pairs[-1]=pair(201,["c2","c3"],answer="不用溶剂。")
        calls=[]
        def provider(spec,body):
            calls.append(body)
            return wire(candidate(["p1"],reply="请用软布。" if len(calls)==1 else "不用溶剂。"))
        with patch.object(chatrules,"_post",side_effect=provider):
            result=chatbatch.analyze(pairs,[],CONFIG)
        item=result["candidates"][0]
        self.assertEqual(item["evidence_ids"],["p1","p201"])
        self.assertEqual(item["count"],3)
        self.assertEqual(item["reply"],"请用软布。")
        self.assertIn(chatbatch.VARIANT_NOTE,item["warnings"])

    def test_top30_is_global_frequency_order_after_all_batches(self):
        pairs=[pair(i,["c"+str(n) for n in range(i+1)]) for i in range(1,63)]
        seen=[]
        def provider(spec,body):
            sent=model_input(body);seen.extend(p["question"] for p in sent)
            return wire(*(candidate([p["id"]],keyword=p["question"]) for p in sent))
        with patch.object(chatrules,"MAX_PAIRS",2),patch.object(chatrules,"_post",side_effect=provider):
            result=chatbatch.analyze(pairs,[],CONFIG)
        self.assertEqual(len(seen),62)
        self.assertEqual(len(result["candidates"]),30)
        self.assertEqual([p["count"] for p in result["candidates"]],list(range(63,33,-1)))

    def test_primary_failure_uses_backup_once_with_same_input_and_validation(self):
        pairs=[pair(1,["c1","c2"])]
        with patch.object(chatrules,"_post",side_effect=[ProviderFailure("timeout"),wire(candidate(["p1"]))]) as post:
            result=chatbatch.analyze(pairs,[],CONFIG)
        self.assertEqual([c.args[1]["model"] for c in post.call_args_list],["primary","backup"])
        self.assertEqual(post.call_args_list[0].args[1]["messages"],post.call_args_list[1].args[1]["messages"])
        self.assertEqual(result["candidates"][0]["count"],2)
        self.assertIn(chatbatch.BACKUP_NOTE,result["warnings"])

    def test_valid_empty_or_individually_rejected_candidate_does_not_use_backup(self):
        for output in (wire(),wire(candidate(["missing"]))):
            with self.subTest(output=output),patch.object(chatrules,"_post",return_value=output) as post:
                self.assertEqual(chatbatch.analyze([pair(1,["c1","c2"])],[],CONFIG)["candidates"],[])
                post.assert_called_once()

    def test_invalid_whole_primary_uses_backup_but_does_not_echo_raw_response(self):
        private="PRIVATE-UPSTREAM-SENTINEL"
        bad={"choices":[{"message":{"content":private}}]}
        with patch.object(chatrules,"_post",side_effect=[bad,wire(candidate(["p1"]))]),patch("backend.diagnostics.emit") as emit:
            result=chatbatch.analyze([pair(1,["c1","c2"])],[],CONFIG)
        self.assertEqual(result["candidates"][0]["count"],2)
        self.assertNotIn(private,str(emit.call_args_list)+json.dumps(result))

    def test_both_models_fail_exactly_once_and_no_backup_config_has_one_call(self):
        for config,expected in ((CONFIG,2),({"primary":CONFIG["primary"]},1)):
            with self.subTest(expected=expected),patch.object(chatrules,"_post",side_effect=ProviderFailure("timeout")) as post:
                with self.assertRaises(ProviderFailure):
                    chatbatch.analyze([pair(1,["c1","c2"])],[],config)
                self.assertEqual(post.call_count,expected)

    def test_failed_batch_is_explicit_partial_coverage_and_other_batches_continue(self):
        pairs=[pair(i,["c1","c2"]) for i in range(1,4)]
        progress=[]
        with patch.object(chatrules,"MAX_PAIRS",2),patch.object(chatrules,"_post",side_effect=[ProviderFailure("timeout"),ProviderFailure("timeout"),wire(candidate(["p1"]))]) as post:
            result=chatbatch.analyze(pairs,[],CONFIG,progress=progress.append)
        self.assertEqual(post.call_count,3)
        self.assertEqual(progress[-1]["failed_batches"],1)
        self.assertEqual(progress[-1]["processed_pairs"],3)
        self.assertTrue(any("部分结果" in n and "1/2" in n for n in result["warnings"]))

    def test_cancellation_before_backup_or_next_batch_prevents_another_call(self):
        cancel=threading.Event()
        def fail(spec,body):
            cancel.set();raise ProviderFailure("timeout")
        with patch.object(chatrules,"_post",side_effect=fail) as post:
            with self.assertRaises(chatrules.ImportCancelled):
                chatbatch.analyze([pair(1)],[],CONFIG,cancelled=cancel.is_set)
            self.assertEqual(post.call_count,1)
        cancel.clear()
        def progress(value):
            if value["processed_batches"]==1:cancel.set()
        with patch.object(chatrules,"MAX_PAIRS",2),patch.object(chatrules,"_post",return_value=wire()) as post:
            with self.assertRaises(chatrules.ImportCancelled):
                chatbatch.analyze([pair(i) for i in range(1,4)],[],CONFIG,progress=progress,cancelled=cancel.is_set)
            self.assertEqual(post.call_count,1)

    def test_single_source_topics_can_merge_across_batches_before_frequency_filter(self):
        pairs=[pair(i) for i in range(1,202)]
        with patch.object(chatrules,"_post",return_value=wire(candidate(["p1"]))) as post:
            result=chatbatch.analyze(pairs,[],CONFIG)
        self.assertEqual(post.call_count,2)
        self.assertEqual(result["candidates"][0]["evidence_ids"],["p1","p201"])
        self.assertEqual(result["candidates"][0]["count"],2)

    def test_punctuation_and_answer_variants_are_not_silently_deduplicated(self):
        pairs=[pair(1,question="型号-A？",answer="不支持。"),pair(2,question="型号A？",answer="支持。")]
        before=copy.deepcopy((pairs,CONFIG))
        with patch.object(chatrules,"_post",return_value=wire()) as post:
            chatbatch.analyze(pairs,[],CONFIG)
        sent=model_input(post.call_args.args[1])
        self.assertEqual(len(sent),2)
        self.assertEqual((pairs,CONFIG),before)

    def test_many_batch_warnings_cannot_expand_without_bound(self):
        def provider(spec, body):
            note=model_input(body)[0]["question"]
            value=wire()
            value["choices"][0]["message"]["content"]=json.dumps({"candidates":[],"warnings":[note+str(i) for i in range(20)]})
            return value
        with patch.object(chatrules,"MAX_PAIRS",2),patch.object(chatrules,"_post",side_effect=provider):
            result=chatbatch.analyze([pair(i) for i in range(1,11)],[],CONFIG)
        self.assertLessEqual(len(result["warnings"]),21)
        self.assertIn(chatbatch.NOTES_LIMIT,result["warnings"])


if __name__=="__main__":unittest.main()
