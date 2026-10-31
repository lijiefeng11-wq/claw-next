"""Saved handling rules are resolved by the server; model output cannot mint actions."""
import json
import time
import unittest
from unittest.mock import patch
from backend.engine import decide
from backend import conversation_actions as ca

SLOT = {"base_url":"http://127.0.0.1:12345/v1", "model":"fictional", "timeout_seconds":1, "api_key":""}
CONFIG = {"primary":SLOT, "backup":SLOT}


def job(caps=ca.CAPABILITIES):
    now=time.time()
    return {"payload":{"received_at":now,"context":{"history_complete":True,
            "messages":[{"id":"fake","role":"buyer","kind":"text","content":"请帮我核对","created_at":now}],
            "conv_state":{"marked":False,"color":None,"observed_at":now},
            "transfer_targets":[{"target_id":"opaque-fake","name":"虚构专用账号","observed_at":now}]}},
            "settings":{"enabled":True,"mode":"hybrid","version":3,"system_prompt":"虚构政策", "rules":[
                {"id":"r","contains":"维修","description":"需要人工协助核对", "handling":{"action":"transfer","account":"虚构专用账号","allow_unmark":False}}]},
            "capabilities":list(caps)}


def output(value):return {"choices":[{"message":{"content":json.dumps(value)}}]}


class EngineActionTests(unittest.TestCase):
    def test_model_only_selects_rule_id_and_never_sees_state_or_recipient(self):
        with patch('backend.engine._post',return_value=output({'rule_id':'r'})) as post:
            result=decide(job(),CONFIG)
        self.assertEqual(result['action'],'transfer')
        self.assertEqual(result['transfer'],{'target_id':'opaque-fake','unmark_policy':{'allow':False,'version':3}})
        self.assertNotIn('text',result)
        request=json.dumps(post.call_args.args[1],ensure_ascii=False)
        for private in ('transfer_targets','conv_state','虚构专用账号','opaque-fake','allow_unmark'):
            self.assertNotIn(private,request)

    def test_semantic_rule_without_capability_stays_handoff(self):
        with patch('backend.engine._post',return_value=output({'rule_id':'r'})) as post:
            result=decide(job([]),CONFIG)
        self.assertEqual(result['action'],'handoff');self.assertEqual(post.call_count,1)

    def test_model_cannot_directly_generate_platform_actions(self):
        for action in ('mark','transfer'):
            with patch('backend.engine._post',return_value=output({'action':action,'reason':'fake','text':''})):
                result=decide(job(),CONFIG)
            self.assertEqual(result['action'],'handoff')
            self.assertTrue(result['reason'].startswith('model_unavailable:'))

    def test_unknown_mark_state_still_allows_saved_plain_text_rule(self):
        value=job();value['payload']['context']['conv_state']['marked']=None
        value['settings']['rules'][0]={'id':'r','contains':'维修','reply':'虚构核对话术'}
        with patch('backend.engine._post',return_value=output({'rule_id':'r'})):
            self.assertEqual(decide(value,CONFIG)['text'],'虚构核对话术')
