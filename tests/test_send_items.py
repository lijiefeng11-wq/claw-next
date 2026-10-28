"""Synthetic candidate, capability and durable delivery contract regressions."""
import copy
import tempfile
import time
import unittest
from unittest.mock import patch

from backend.engine import decide
from backend.senditems import validate_options
from backend.store import ApiError, Store, require, validate_settings
import test_api_contract as api


def options():
    return {"instructions": [{"option_id": "i-1", "goods_title": "示例商品", "name": "示例说明书", "observed_at": 1}],
            "goods": [{"option_id": "g-1", "goods_title": "示例商品", "observed_at": 1}],
            "videos": [{"option_id": "v-1", "name": "示例视频", "observed_at": 1, "duration": 30}]}


def settings():
    return {"enabled": True, "mode": "rules", "system_prompt": "", "rules": [
        {"id": "manual", "contains": "安装", "send": {"type": "instruction", "match": "示例"}}]}


class CandidateValidationTests(unittest.TestCase):
    def test_optional_empty_and_maximum_candidates(self):
        for ctx in ({}, {"send_options": {}}, {"send_options": {"goods": []}}, {"send_options": options()}):
            before = copy.deepcopy(ctx)
            validate_options(ctx, require)
            self.assertEqual(ctx, before)
        maximum = {kind: [{**items[0], "option_id": kind + str(i)} for i in range(limit)]
                   for (kind, items), limit in zip(options().items(), (10, 20, 50))}
        validate_options({"send_options": maximum}, require)
        for kind in maximum:
            bad = copy.deepcopy(maximum)
            bad[kind].append({**bad[kind][0], "option_id": "extra"})
            with self.subTest(kind=kind), self.assertRaises(ApiError):
                validate_options({"send_options": bad}, require)

    def test_missing_unknown_fields_and_wrong_types(self):
        bad_values = [None, [], "x", {"unknown": []}, {"goods": {}}, {"goods": [None]}]
        for kind, items in options().items():
            item = items[0]
            for key in set(item) - {"duration"}:
                bad_values.append({kind: [{k: v for k, v in item.items() if k != key}]})
            for key, value in (("extra", "secret"), ("option_id", ""), ("option_id", "x" * 65),
                               ("option_id", []), ("observed_at", True), ("observed_at", float("nan")),
                               ("observed_at", float("inf")), ("observed_at", "1")):
                bad_values.append({kind: [{**item, key: value}]})
            label = "name" if kind == "videos" else "goods_title"
            for value in (False, " ", "x" * 201):
                bad_values.append({kind: [{**item, label: value}]})
        bad_values += [{"goods": [{**options()["goods"][0], "name": "extra"}]},
                       {"instructions": [{**options()["instructions"][0], "duration": 3}]}]
        for value in (0, -1, True, 1.5, "3"):
            bad_values.append({"videos": [{**options()["videos"][0], "duration": value}]})
        for value in bad_values:
            with self.subTest(value=value), self.assertRaises(ApiError):
                validate_options({"send_options": value}, require)

    def test_duplicate_ids_rejected_across_and_within_types(self):
        for kind in ("instructions", "goods"):
            data = options()
            data[kind].append({**data[kind][0], "option_id": "i-1"})
            with self.subTest(kind=kind), self.assertRaises(ApiError) as error:
                validate_options({"send_options": data}, require)
            self.assertEqual(error.exception.code, "duplicate_option_id")

    def test_rule_target_validation_and_text_backwards_compatibility(self):
        base = settings()
        self.assertEqual(validate_settings(base), base)
        base["rules"][0]["reply"] = "保留的文字"
        self.assertEqual(validate_settings(base), base)
        for bad in (None, {}, {"type": []}, {"type": "upload"}, {"type": "video", "url": "x"},
                    {"type": "video", "match": ""}, {"type": "video", "match": "x" * 51}):
            data = settings()
            data["rules"][0]["send"] = bad
            with self.subTest(bad=bad), self.assertRaises(ApiError):
                validate_settings(data)
        for rule in ({"id": "r", "contains": "a"}, {"id": "r", "contains": "a", "reply": ""}):
            with self.assertRaises(ApiError):
                validate_settings({**base, "rules": [rule]})


class SendItemStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.shops = [{"shop_id": "a", "name": "虚构店铺"}, {"shop_id": "b", "name": "虚构店铺二"}]
        self.store = Store(self.tmp.name, self.shops)
        self.addCleanup(lambda: self.store.close())
        self.identity = {"shop_id": "a", "client_id": "client-a"}
        self.lease = self.heartbeat(["send_item"])
        self.store.update_settings("a", settings())

    def heartbeat(self, caps, session="session"):
        return self.store.heartbeat(self.identity, {"instance_id": "instance", "session_id": session, "capabilities": caps})

    def event(self, name="event", revision=1, conversation="buyer", lease=None):
        lease = lease or self.lease
        return {"event_id": name, **{k: lease[k] for k in ("instance_id", "session_id", "generation")},
                "context_revision": revision, "conversation_id": conversation, "message_id": name, "received_at": time.time(),
                "context": {"history_complete": True, "messages": [{"id": name, "role": "buyer", "kind": "text", "content": "安装", "created_at": time.time()}], "send_options": options()}}

    def ready(self, event=None, item=None):
        event = event or self.event()
        self.store.enqueue(self.identity, event)
        job = self.store.next_job()
        result = {"action": "send_item", "item": item or {"type": "instruction", "option_id": "i-1"}, "reason": "rule:manual", "expires_at": time.time() + 60}
        self.store.finish(job, result)
        return job, result

    def claim(self, name="event", lease=None):
        return self.store.claim(self.identity, name, {**(lease or self.lease), "attempt_id": "attempt"})

    def assert_code(self, code, fn, status=409):
        with self.assertRaises(ApiError) as caught:
            fn()
        self.assertEqual((caught.exception.status, caught.exception.code), (status, code))

    def test_capability_intersection_withdrawal_and_validation(self):
        lease = self.heartbeat(["future", "send_item"])
        self.assertEqual(lease["capabilities"], ["send_item"])
        old = self.store.heartbeat(self.identity, {"instance_id": "instance", "session_id": "session"})
        self.assertEqual(old["generation"], lease["generation"])
        self.assertEqual(old["capabilities"], [])
        self.assert_code("capability_not_confirmed", lambda: self.store.enqueue(self.identity, self.event()), 400)
        for caps in (None, {}, "send_item", [True], ["send_item"] * 2, ["a"] * 11, ["x" * 33]):
            self.assert_code("invalid_capabilities", lambda: self.heartbeat(caps), 400)

    def test_inflight_capability_withdrawal_rechecks_before_persisting(self):
        self.store.enqueue(self.identity, self.event())
        job = self.store.next_job()
        self.assertEqual(job["capabilities"], ["send_item"])
        self.heartbeat([])
        result = self.store.finish(job, {"action": "send_item", "item": {"type": "video", "option_id": "v-1"}, "reason": "model", "expires_at": time.time()+60})
        self.assertEqual((result["action"], result["reason"]), ("none", "capability_not_confirmed"))
        self.assertEqual(self.store.get(self.identity, "event")["decision"], result)

    def test_withdrawal_before_decision_uses_no_item_capability(self):
        self.store.enqueue(self.identity, self.event())
        self.heartbeat([])
        job = self.store.next_job()
        self.assertEqual(job["capabilities"], [])
        self.assertNotEqual(decide(job)["action"], "send_item")

    def test_ready_item_cannot_claim_after_withdrawal(self):
        self.ready()
        self.heartbeat([])
        self.assert_code("capability_not_confirmed", self.claim)

    def test_claimed_item_receipt_survives_withdrawal(self):
        self.ready()
        claimed = self.claim()
        self.assertAlmostEqual(claimed["delivery"]["claim_expires_at"] - time.time(), 10, delta=.2)
        self.heartbeat([])
        receipt = self.store.receipt(self.identity, "event", {"attempt_id": "attempt", "status": "sent", "platform_message_id": "platform-1"})
        self.assertEqual(receipt["delivery"]["status"], "sent")
        self.assert_code("delivery_terminal", self.claim)

    def test_invalid_or_cross_type_model_result_is_not_persisted_as_send(self):
        for i, item in enumerate(({"type": "video", "option_id": "i-1"}, {"type": "video", "option_id": "not-offered"})):
            self.ready(self.event("bad"+str(i), conversation=str(i)), item)
            self.assertEqual(self.store.get(self.identity, "bad"+str(i))["decision"]["reason"], "invalid_send_item")

    def test_superseded_revision_and_session_and_shop_are_rejected(self):
        self.ready()
        self.store.enqueue(self.identity, self.event("new", 2))
        self.assert_code("superseded", self.claim)
        new_lease = self.heartbeat(["send_item"], "new-session")
        self.assert_code("event_session_mismatch", lambda: self.claim(lease=new_lease))
        other = {"shop_id": "b", "client_id": "client-b"}
        self.assert_code("event_not_found", lambda: self.store.claim(other, "event", {**self.lease, "attempt_id": "attempt"}), 404)

    def test_tenth_second_unknown_is_permanent_and_new_message_is_allowed(self):
        self.ready()
        expires = self.claim()["delivery"]["claim_expires_at"]
        with patch("backend.store.time.time", return_value=expires):
            self.assert_code("receipt_conflict", lambda: self.store.receipt(self.identity, "event", {"attempt_id": "attempt", "status": "sent", "platform_message_id": "late"}))
            self.assertEqual(self.store.get(self.identity, "event")["delivery"]["status"], "unknown")
        self.assertEqual(self.store.get(self.identity, "event")["delivery"]["status"], "unknown")
        self.assert_code("delivery_terminal", self.claim)
        self.ready(self.event("new", 2))
        self.assertEqual(self.claim("new")["delivery"]["status"], "claimed")

    def test_restart_cannot_reuse_old_capability_without_confirmation(self):
        self.ready()
        self.store.close()
        self.store = Store(self.tmp.name, self.shops)
        self.assert_code("lease_expired", self.claim)
        self.lease = self.heartbeat([])
        self.assert_code("capability_not_confirmed", self.claim)


class SendItemHttpTests(unittest.TestCase):
    def test_real_api_send_only_rule_and_receive_only_and_old_client(self):
        fixture = api.ApiContractTestCase()
        fixture.setUp()
        try:
            rules = settings()["rules"]
            saved = fixture.enable_shop(rules=rules)
            self.assertEqual(saved["rules"], rules)
            lease = fixture.acquire()
            event = fixture.make_event(lease, content="安装")
            event["context"]["send_options"] = options()
            fixture.submit_event(lease, event, expected=400)
            fixture.assert_status(fixture.request("POST", "/api/v1/heartbeat", {**lease, "capabilities": ["send_item"]}, token=lease["token"]), 200)
            fixture.submit_event(lease, event)
            result = fixture.wait_ready(lease, event["event_id"])
            self.assertEqual(result["decision"]["action"], "send_item")
            self.assertNotIn("text", result["decision"])
            fixture.claim(lease, event["event_id"], "attempt")
            fixture.assert_status(fixture.receipt(lease, event["event_id"], "attempt", "sent"), 400)
            fixture.assert_status(fixture.receipt(lease, event["event_id"], "attempt", "not_sent"), 200)
            fixture.enable_shop(enabled=False, rules=rules)
            disabled = fixture.make_event(lease, content="安装", context_revision=2)
            disabled["context"]["send_options"] = options()
            fixture.submit_event(lease, disabled)
            result = fixture.wait_ready(lease, disabled["event_id"])
            self.assertEqual((result["decision"]["action"], result["decision"]["reason"]), ("none", "shop_disabled"))
            fixture.claim(lease, disabled["event_id"], "disabled-attempt", expected=409)
        finally:
            fixture.doCleanups()
