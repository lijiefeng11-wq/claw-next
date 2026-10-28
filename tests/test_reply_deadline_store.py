"""Contract A store-level tests: budgets, deadlines, cancel/claim races and timing.

Everything here is synthetic: fictional shops, clients, messages and model
outputs. No service, real model, credential or platform API is used. The store
is exercised directly; HTTP wiring belongs to the main agent's integration tests.
"""
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from backend import deadlines
from backend.engine import decide
from backend.store import ApiError, Store


class Clock:
    """Deterministic wall clock plus a monotonic clock tied to fake sleep."""

    def __init__(self, start=1790000000.0):
        self.wall = start
        self.mono = 100.0

    def time(self):
        return self.wall

    def sleep(self, seconds):
        self.wall += seconds
        self.mono += seconds

    def context(self):
        return patch("backend.store.time", _ClockProxy(self))


class _ClockProxy:
    def __init__(self, clock):
        self.clock = clock

    def time(self):
        return self.clock.wall

    def monotonic(self):
        return self.clock.mono

    def sleep(self, seconds):
        time.sleep(seconds)


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.shops = [{"shop_id": "a", "name": "虚构店铺甲"}, {"shop_id": "b", "name": "虚构店铺乙"}]
        self.store = Store(self.tmp.name, self.shops)
        self.addCleanup(self._close)
        self.identity = {"role": "client", "shop_id": "a", "client_id": "client-a"}
        self.other_identity = {"role": "client", "shop_id": "a", "client_id": "client-a2"}
        self.foreign = {"role": "client", "shop_id": "b", "client_id": "client-b"}
        self.clock = Clock(time.time())
        self.clock.context().start()
        self.addCleanup(patch.stopall)
        self.lease = self.heartbeat()
        for shop in ("a", "b"):
            self.store.update_settings(shop, {"enabled": True, "mode": "rules", "system_prompt": "虚构", "rules": [{"id": "r", "contains": "你好", "reply": "您好"}]})

    def _close(self):
        try:
            self.store.close()
        except Exception:
            pass

    def heartbeat(self, caps=("reply_deadline",), session="session", identity=None, instance="instance"):
        lease = self.store.heartbeat(identity or self.identity, {"instance_id": instance, "session_id": session, "capabilities": list(caps)})
        if identity is None:
            self.lease = lease
        return lease

    def restart(self):
        self.store.close()
        self.store = Store(self.tmp.name, self.shops)

    def payload(self, name="evt", revision=1, conversation=None, **extra):
        now = self.clock.time()
        body = {"event_id": name, **{k: self.lease[k] for k in ("instance_id", "session_id", "generation")},
                "conversation_id": conversation or "buyer", "message_id": name, "context_revision": revision,
                "received_at": now, "context": {"history_complete": True, "messages": [
                    {"id": name, "role": "buyer", "kind": "text", "content": "你好", "created_at": now}]}}
        body.update(extra)
        return body

    def enqueue(self, name="evt", identity=None, **extra):
        return self.store.enqueue(identity or self.identity, self.payload(name, **extra))

    def ready(self, name="evt", revision=1):
        result = self.enqueue(name, revision=revision)
        job = self.store.next_job(accept=lambda job: job["event_id"] == name)
        self.assertIsNotNone(job)
        self.store.finish(job, decide(job))
        return self.store.get(self.identity, name)

    def claim_body(self, **extra):
        return {**{k: self.lease[k] for k in ("instance_id", "session_id", "generation")}, "attempt_id": "attempt", **extra}

    def cancel_body(self, **extra):
        return {**{k: self.lease[k] for k in ("instance_id", "session_id", "generation")}, "reason": "reply_deadline_exceeded", **extra}

    def assert_code(self, code, call, status=409):
        with self.assertRaises(ApiError) as caught:
            call()
        self.assertEqual((caught.exception.status, caught.exception.code), (status, code))
        return caught.exception

    def rows(self, name, shop="a"):
        return self.store.db.execute("SELECT * FROM events WHERE shop_id=? AND event_id=?", (shop, name)).fetchall()


class BudgetValidationTests(StoreTestCase):
    def test_budget_type_and_range(self):
        invalid = [True, False, 1.0, 0.5, "10", None, [], {}, float("nan"), float("inf"), -1, 20001, 10 ** 9]
        for value in invalid:
            with self.subTest(value=value):
                self.assert_code("invalid_remaining_budget", lambda: self.enqueue("bad", remaining_budget_ms=value), 400)
                self.assertEqual(self.rows("bad"), [])

    def test_budget_edges_accepted(self):
        for index, value in enumerate((0, 1, 20000)):
            with self.subTest(value=value):
                snapshot = self.enqueue("edge" + str(index), revision=index + 1, remaining_budget_ms=value)
                self.assertIn("event_deadline", snapshot)
                self.assertEqual(snapshot["event_deadline"], self.clock.time() + value / 1000)
        self.assertEqual(self.enqueue("edge2", revision=3, remaining_budget_ms=20000)["state"], "pending")

    def test_field_absent_keeps_legacy_behaviour(self):
        snapshot = self.enqueue("legacy")
        self.assertNotIn("event_deadline", snapshot)
        self.assertEqual(snapshot["state"], "pending")
        self.assertNotIn("timing", snapshot)
        self.assertEqual(len(self.rows("legacy")), 1)

    def test_client_timing_field_rejected(self):
        for value in ({}, {"queue_wait_ms": 1}, {"decision_ms": 0, "failure_class": "cancelled"}):
            with self.subTest(value=value):
                self.assert_code("invalid_field", lambda: self.enqueue("t", timing=value), 400)
                self.assertEqual(self.rows("t"), [])
        self.ready("ready-evt", revision=2)
        self.assert_code("invalid_field", lambda: self.store.cancel(self.identity, "ready-evt", self.cancel_body(timing={})), 400)
        self.assertEqual(self.store.get(self.identity, "ready-evt")["state"], "ready")

    def test_zero_budget_is_ready_handoff_without_attempt_or_judgment(self):
        snapshot = self.enqueue("zero", remaining_budget_ms=0)
        self.assertEqual(snapshot["state"], "ready")
        self.assertEqual(snapshot["decision"], {"action": "handoff", "text": "", "reason": "reply_deadline_exceeded", "expires_at": self.clock.time()})
        self.assertEqual(snapshot["delivery"], {"status": "unclaimed", "attempt_id": None, "platform_message_id": None, "verification": None})
        self.assertEqual(snapshot["timing"], {"failure_class": "deadline_exceeded"})
        self.assertIsNone(self.store.next_job())
        self.assert_code("reply_deadline_exceeded", lambda: self.store.claim(self.identity, "zero", self.claim_body()))
        self.assertEqual(self.store.get(self.identity, "zero")["delivery"]["attempt_id"], None)

    def test_replay_is_idempotent_and_never_refreshes_the_deadline(self):
        payload = self.payload("replay", remaining_budget_ms=5000)
        first = self.store.enqueue(self.identity, payload)
        runtime = self.store._runtime("a", "replay")
        self.clock.sleep(3)
        # Replay with zero remaining budget is not allowed to extend or shorten it.
        replay = self.store.enqueue(self.identity, payload)
        self.assertEqual(replay, {**first, "timing": replay.get("timing")} if replay.get("timing") else first)
        self.assertEqual(replay["event_deadline"], first["event_deadline"])
        self.assertEqual(self.store._runtime("a", "replay")["wall_deadline"], runtime["wall_deadline"])
        changed = {**payload, "remaining_budget_ms": 20000}
        self.assert_code("event_conflict", lambda: self.store.enqueue(self.identity, changed))
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM events").fetchone()[0], 1)

    def test_replay_precedes_capability_and_lease_withdrawal(self):
        payload = self.payload("replay", remaining_budget_ms=5000)
        self.store.enqueue(self.identity, payload)
        # Capability withdrawn: a same-body retry is still answered with the record.
        self.heartbeat(caps=())
        self.assertEqual(self.store.enqueue(self.identity, payload)["event_id"], "replay")
        # A brand-new first submission without the capability is refused.
        self.assert_code("capability_not_confirmed", lambda: self.enqueue("fresh", revision=2, remaining_budget_ms=10), 400)
        self.assertEqual(self.rows("fresh"), [])

    def test_replay_precedes_lease_expiry(self):
        payload = self.payload("replay", remaining_budget_ms=5000)
        self.store.enqueue(self.identity, payload)
        self.clock.sleep(61)  # lease expired, budget still live
        self.assertEqual(self.store.enqueue(self.identity, payload)["event_id"], "replay")
        self.assert_code("lease_expired", lambda: self.enqueue("fresh", revision=2, remaining_budget_ms=10))

    def test_first_submission_requires_capability_and_lease(self):
        self.heartbeat(caps=())
        self.assert_code("capability_not_confirmed", lambda: self.enqueue("nocap", remaining_budget_ms=100), 400)
        self.assertEqual(self.rows("nocap"), [])
        self.heartbeat(caps=("send_item",))  # send_item does not imply reply_deadline
        self.assert_code("capability_not_confirmed", lambda: self.enqueue("nocap", remaining_budget_ms=100), 400)
        self.heartbeat(caps=("reply_deadline",))
        self.clock.sleep(61)
        self.assert_code("lease_expired", lambda: self.enqueue("nocap", remaining_budget_ms=100), 409)
        self.assertEqual(self.rows("nocap"), [])

    def test_send_options_and_budget_capabilities_are_independent(self):
        self.heartbeat(caps=("reply_deadline",))
        with_options = self.payload("opts", remaining_budget_ms=100)
        with_options["context"]["send_options"] = {}
        self.assert_code("capability_not_confirmed", lambda: self.store.enqueue(self.identity, with_options), 400)
        self.heartbeat(caps=("send_item",))
        self.assert_code("capability_not_confirmed", lambda: self.enqueue("budget", remaining_budget_ms=100), 400)


class DequeueDeadlineTests(StoreTestCase):
    def test_next_job_exposes_absolute_monotonic_deadline(self):
        accepted = self.clock.mono
        self.enqueue("evt", remaining_budget_ms=10000)
        job = self.store.next_job()
        self.assertAlmostEqual(job["deadline_monotonic"], accepted + 10, delta=0.5)
        self.assertIsInstance(job["deadline_monotonic"], float)
        self.assertGreater(job["deadline_monotonic"], self.clock.mono)
        self.assertEqual(job["payload"]["remaining_budget_ms"], 10000)

    def test_queue_wait_and_decision_start_at_real_dequeue(self):
        self.enqueue("evt", remaining_budget_ms=20000)
        self.clock.sleep(2)
        job = self.store.next_job()
        timing = self.store._runtime("a", "evt")["timing"]
        self.assertGreaterEqual(timing["queue_wait_ms"], 2000)
        self.assertLess(timing["queue_wait_ms"], 2600)
        self.assertNotIn("decision_ms", timing)
        self.clock.sleep(1)
        self.store.finish(job, decide(job))
        snapshot = self.store.get(self.identity, "evt")
        self.assertEqual(snapshot["decision"]["action"], "reply")
        self.assertGreaterEqual(snapshot["timing"]["decision_ms"], 1000)
        self.assertLess(snapshot["timing"]["decision_ms"], 1600)
        self.assertNotIn("failure_class", snapshot["timing"])
        self.assertNotIn("model_slot", snapshot["timing"])

    def test_expired_pending_event_is_terminated_by_maintenance_without_judgment(self):
        self.enqueue("evt", remaining_budget_ms=1000)
        self.clock.sleep(1)
        self.store.expire_deadlines()
        snapshot = self.store.get(self.identity, "evt")
        self.assertEqual((snapshot["state"], snapshot["decision"]["action"], snapshot["decision"]["reason"]), ("ready", "handoff", "reply_deadline_exceeded"))
        self.assertEqual(snapshot["decision"]["text"], "")
        self.assertEqual(snapshot["delivery"]["status"], "unclaimed")
        self.assertNotIn("decision_ms", snapshot["timing"])
        self.assertIsNone(self.store.next_job())

    def test_processing_event_expires_and_late_result_cannot_overwrite(self):
        self.enqueue("evt", remaining_budget_ms=1000)
        job = self.store.next_job()
        self.clock.sleep(2)
        self.assertFalse(self.store.job_is_active(job))
        late = self.store.finish(job, {"action": "reply", "text": "晚到的回复", "reason": "model:primary:late", "expires_at": self.clock.time() + 60})
        self.assertEqual((late["action"], late["reason"]), ("handoff", "reply_deadline_exceeded"))
        snapshot = self.store.get(self.identity, "evt")
        self.assertEqual(snapshot["decision"]["text"], "")
        self.assertEqual(snapshot["timing"]["failure_class"], "deadline_exceeded")
        self.assertNotIn("decision_ms", snapshot["timing"])
        self.assert_code("reply_deadline_exceeded", lambda: self.store.claim(self.identity, "evt", self.claim_body()))

    def test_ready_unclaimed_reply_expires_and_cannot_be_claimed(self):
        self.enqueue("evt", remaining_budget_ms=1000)
        job = self.store.next_job()
        self.store.finish(job, decide(job))
        self.assertEqual(self.store.get(self.identity, "evt")["decision"]["action"], "reply")
        self.clock.sleep(1)
        self.store.expire_deadlines()
        snapshot = self.store.get(self.identity, "evt")
        self.assertEqual((snapshot["state"], snapshot["decision"]["action"], snapshot["decision"]["reason"]), ("ready", "handoff", "reply_deadline_exceeded"))
        self.assertEqual(snapshot["delivery"]["status"], "unclaimed")
        self.assert_code("reply_deadline_exceeded", lambda: self.store.claim(self.identity, "evt", self.claim_body()))
        self.assertEqual(self.store.get(self.identity, "evt")["delivery"]["attempt_id"], None)

    def test_claim_after_expiry_terminates_atomically(self):
        self.enqueue("evt", remaining_budget_ms=1000)
        job = self.store.next_job()
        self.store.finish(job, decide(job))
        self.clock.sleep(5)
        self.assert_code("reply_deadline_exceeded", lambda: self.store.claim(self.identity, "evt", self.claim_body()))
        snapshot = self.store.get(self.identity, "evt")
        self.assertEqual(snapshot["decision"]["reason"], "reply_deadline_exceeded")
        self.assertEqual(snapshot["delivery"]["status"], "unclaimed")
        self.assertIsNone(snapshot["delivery"]["attempt_id"])

    def test_handoff_decision_is_not_a_sendable_ready(self):
        self.enqueue("evt", remaining_budget_ms=1000)
        job = self.store.next_job()
        self.store.finish(job, {"action": "handoff", "text": "", "reason": "no_matching_rule", "expires_at": self.clock.time() + 60})
        self.clock.sleep(2)
        self.store.expire_deadlines()
        # A non-sendable handoff is not rewritten by the deadline.
        self.assertEqual(self.store.get(self.identity, "evt")["decision"]["reason"], "no_matching_rule")

    def test_expiry_preserves_superseded_reason_and_never_touches_attempt(self):
        self.enqueue("evt", remaining_budget_ms=1000)
        job = self.store.next_job()
        self.store.finish(job, {"action": "none", "text": "", "reason": "superseded", "expires_at": self.clock.time() + 60})
        self.clock.sleep(2)
        self.store.expire_deadlines()
        self.assertEqual(self.store.get(self.identity, "evt")["decision"]["reason"], "superseded")

    def test_claim_first_survives_deadline_and_receipt_still_works(self):
        self.enqueue("evt", remaining_budget_ms=1000)
        job = self.store.next_job()
        self.store.finish(job, decide(job))
        claimed = self.store.claim(self.identity, "evt", self.claim_body())
        self.assertEqual(claimed["delivery"]["status"], "claimed")
        self.clock.sleep(1)
        self.store.expire_deadlines()
        snapshot = self.store.get(self.identity, "evt")
        self.assertEqual(snapshot["delivery"]["status"], "claimed")
        receipt = self.store.receipt(self.identity, "evt", {"attempt_id": "attempt", "status": "not_sent"})
        self.assertEqual(receipt["delivery"]["status"], "not_sent")

    def test_claimed_attempt_then_backend_expiry_does_not_block_receipt(self):
        self.enqueue("evt", remaining_budget_ms=1000)
        job = self.store.next_job()
        self.clock.sleep(2)
        self.store.finish(job, decide(job))  # deadline terminated the event first
        self.assert_code("reply_deadline_exceeded", lambda: self.store.claim(self.identity, "evt", self.claim_body()))
        self.assertEqual(self.store.get(self.identity, "evt")["delivery"]["status"], "unclaimed")

    def test_other_shop_cannot_see_budget_event(self):
        self.enqueue("evt", remaining_budget_ms=1000)
        self.assert_code("event_not_found", lambda: self.store.get(self.foreign, "evt"), 404)
        self.assert_code("event_not_found", lambda: self.store.claim(self.foreign, "evt", self.claim_body()), 404)


class TimingTests(StoreTestCase):
    def test_producer_timing_is_whitelisted(self):
        self.enqueue("evt", remaining_budget_ms=20000)
        job = self.store.next_job()
        job["timing"] = {"primary_ms": 12, "backup_ms": 7, "model_slot": "backup", "fallback_used": True,
                         "queue_wait_ms": 999, "decision_ms": 3, "failure_class": "model_unavailable",
                         "api_key": "sk-fake", "base_url": "http://127.0.0.1:1/v1", "text": "买家原文",
                         "prompt": "系统提示词", "raw": {"x": 1}}
        self.clock.sleep(.1)
        self.store.finish(job, {"action": "reply", "text": "您好", "reason": "model:backup:ok", "expires_at": self.clock.time() + 60})
        snapshot = self.store.get(self.identity, "evt")
        timing = snapshot["timing"]
        self.assertEqual(set(timing), {"queue_wait_ms", "decision_ms", "primary_ms", "backup_ms", "model_slot", "fallback_used"})
        self.assertGreaterEqual(timing["decision_ms"], 99)
        self.assertEqual(timing["queue_wait_ms"], 0)
        self.assertNotIn("sk-fake", json.dumps(snapshot))
        self.assertNotIn("买家原文", json.dumps(snapshot, ensure_ascii=False))
        self.assertNotIn("系统提示词", json.dumps(snapshot, ensure_ascii=False))
        self.assertNotIn("127.0.0.1", json.dumps(snapshot))

    def test_malformed_producer_timing_is_dropped_not_zeroed(self):
        self.enqueue("evt", remaining_budget_ms=20000)
        job = self.store.next_job()
        job["timing"] = {"primary_ms": True, "backup_ms": -3, "model_slot": "tertiary", "fallback_used": "yes", "decision_ms": "10"}
        self.store.finish(job, {"action": "reply", "text": "您好", "reason": "rule:r", "expires_at": self.clock.time() + 60})
        timing = self.store.get(self.identity, "evt")["timing"]
        for key in ("primary_ms", "backup_ms", "model_slot", "fallback_used"):
            self.assertNotIn(key, timing)

    def test_failure_class_from_model_unavailable(self):
        self.enqueue("evt", remaining_budget_ms=20000)
        job = self.store.next_job()
        self.store.finish(job, {"action": "handoff", "text": "", "reason": "model_unavailable:primary=timeout,backup=not_configured", "expires_at": self.clock.time() + 60})
        self.assertEqual(self.store.get(self.identity, "evt")["timing"]["failure_class"], "model_unavailable")

    def test_legacy_event_has_measured_timing_but_no_deadline(self):
        self.ready("evt")
        snapshot = self.store.get(self.identity, "evt")
        self.assertIn("decision_ms", snapshot["timing"])
        self.assertNotIn("event_deadline", snapshot)
        job = self.store.next_job()
        self.assertIsNone(job)


class CancelTests(StoreTestCase):
    def test_strict_four_fields(self):
        self.ready("evt")
        good = self.cancel_body()
        for bad in (None, [], {}, {**good, "extra": 1}, {**good, "note": "x"}, {k: v for k, v in good.items() if k != "reason"},
                    {**good, "reason": "buyer asked"}, {**good, "reason": ""}, {**good, "generation": True},
                    {**good, "generation": 0}, {**good, "generation": "1"}, {**good, "instance_id": ""},
                    {**good, "session_id": ["x"]}, {**good, "reason": None}):
            with self.subTest(bad=bad):
                self.assert_code("invalid_cancel", lambda: self.store.cancel(self.identity, "evt", bad), 400)
        self.assertEqual(self.store.get(self.identity, "evt")["decision"]["action"], "reply")

    def test_foreign_shop_and_client_are_hidden_404(self):
        self.ready("evt")
        self.assert_code("event_not_found", lambda: self.store.cancel(self.foreign, "evt", self.cancel_body()), 404)
        self.assert_code("event_not_found", lambda: self.store.cancel(self.other_identity, "evt", self.cancel_body()), 404)
        self.assertEqual(self.store.get(self.identity, "evt")["decision"]["action"], "reply")

    def test_owner_mismatch(self):
        self.ready("evt")
        wrong = [{"session_id": "other-session"}, {"generation": self.lease["generation"] + 1}]
        for change in wrong:
            with self.subTest(change=change):
                self.assert_code("cancel_owner_mismatch", lambda: self.store.cancel(self.identity, "evt", {**self.cancel_body(), **change}))
        self.assertEqual(self.store.get(self.identity, "evt")["decision"]["action"], "reply")

    def test_successful_cancel_is_terminal_without_attempt(self):
        self.ready("evt")
        before = self.store.get(self.identity, "evt")["delivery"]
        snapshot = self.store.cancel(self.identity, "evt", self.cancel_body())
        self.assertEqual(snapshot["state"], "ready")
        self.assertEqual(snapshot["decision"], {"action": "handoff", "text": "", "reason": "reply_deadline_exceeded", "expires_at": self.clock.time()})
        self.assertEqual(snapshot["delivery"], before)
        self.assertIsNone(snapshot["delivery"]["attempt_id"])
        self.assertEqual(snapshot["timing"]["failure_class"], "cancelled")
        self.assertIn("decision_ms", snapshot["timing"])
        self.assert_code("reply_deadline_exceeded", lambda: self.store.claim(self.identity, "evt", self.claim_body()))

    def test_cancel_replay_is_read_only_and_survives_lease_expiry_and_restart(self):
        self.ready("evt")
        first = self.store.cancel(self.identity, "evt", self.cancel_body())
        self.clock.sleep(120)  # lease gone, capability irrelevant
        replay = self.store.cancel(self.identity, "evt", self.cancel_body())
        self.assertEqual(replay, first)
        self.restart()
        again = self.store.cancel(self.identity, "evt", self.cancel_body())
        self.assertEqual(again["decision"], first["decision"])
        self.assertEqual(again["delivery"], first["delivery"])
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM events").fetchone()[0], 1)

    def test_cancel_after_server_deadline_returns_terminal_idempotently(self):
        self.enqueue("evt", remaining_budget_ms=1000)
        job = self.store.next_job()
        self.store.finish(job, decide(job))
        self.clock.sleep(1)
        snapshot = self.store.cancel(self.identity, "evt", self.cancel_body())
        self.assertEqual(snapshot["decision"]["reason"], "reply_deadline_exceeded")
        self.assertEqual(snapshot["timing"]["failure_class"], "deadline_exceeded")
        replay = self.store.cancel(self.identity, "evt", self.cancel_body())
        self.assertEqual(replay, snapshot)

    def test_new_instance_or_session_cannot_first_cancel_old_event(self):
        self.ready("evt")
        new_lease = self.heartbeat(session="session-2")
        self.assert_code("cancel_owner_mismatch", lambda: self.store.cancel(self.identity, "evt", {**self.cancel_body(), **{k: new_lease[k] for k in ("instance_id", "session_id", "generation")}}))
        self.clock.sleep(61)
        newer = self.heartbeat(session="session-3")
        body = {**self.cancel_body(), **{k: newer[k] for k in ("instance_id", "session_id", "generation")}}
        self.assert_code("cancel_owner_mismatch", lambda: self.store.cancel(self.identity, "evt", body))
        self.assertEqual(self.store.get(self.identity, "evt")["decision"]["action"], "reply")

    def test_first_cancel_requires_capability(self):
        self.ready("evt")
        self.heartbeat(caps=("send_item",))
        self.assert_code("capability_not_confirmed", lambda: self.store.cancel(self.identity, "evt", self.cancel_body()))
        self.assertEqual(self.store.get(self.identity, "evt")["decision"]["action"], "reply")

    def test_first_cancel_legacy_event_requires_capability_and_lease(self):
        self.heartbeat(caps=("send_item",))
        self.enqueue("legacy")
        self.assert_code("capability_not_confirmed", lambda: self.store.cancel(self.identity, "legacy", self.cancel_body()))
        self.heartbeat(caps=("reply_deadline",))
        self.clock.sleep(61)
        self.assert_code("lease_expired", lambda: self.store.cancel(self.identity, "legacy", self.cancel_body()))
        self.assertEqual(self.store.get(self.identity, "legacy")["decision"], None)

    def test_legacy_pending_event_can_be_cancelled(self):
        self.enqueue("legacy")
        snapshot = self.store.cancel(self.identity, "legacy", self.cancel_body())
        self.assertEqual((snapshot["state"], snapshot["decision"]["reason"]), ("ready", "reply_deadline_exceeded"))
        self.assertNotIn("event_deadline", snapshot)
        self.assertIsNone(self.store.next_job())

    def test_terminal_and_attempt_states_cannot_be_cancelled(self):
        self.ready("sent")
        self.store.claim(self.identity, "sent", self.claim_body(attempt_id="a1"))
        self.store.receipt(self.identity, "sent", {"attempt_id": "a1", "status": "sent", "platform_message_id": "p1"})
        self.assert_code("cancel_not_allowed", lambda: self.store.cancel(self.identity, "sent", self.cancel_body()))
        self.ready("unknown", revision=2)
        self.store.claim(self.identity, "unknown", self.claim_body(attempt_id="a2"))
        self.store.receipt(self.identity, "unknown", {"attempt_id": "a2", "status": "unknown"})
        self.assert_code("cancel_not_allowed", lambda: self.store.cancel(self.identity, "unknown", self.cancel_body()))
        self.assertEqual(self.store.get(self.identity, "unknown")["delivery"]["status"], "unknown")

    def test_claimed_but_unstarted_cannot_cancel(self):
        self.ready("evt")
        self.store.claim(self.identity, "evt", self.claim_body())
        self.assert_code("cancel_not_allowed", lambda: self.store.cancel(self.identity, "evt", self.cancel_body()))
        self.assertEqual(self.store.get(self.identity, "evt")["delivery"]["status"], "claimed")

    def test_superseded_event_cannot_be_cancelled(self):
        self.enqueue("old")
        self.enqueue("new", revision=2)
        job = self.store.next_job(accept=lambda job: job["event_id"] == "old")
        self.store.finish(job, decide(job))
        self.assertEqual(self.store.get(self.identity, "old")["decision"]["reason"], "superseded")
        self.assert_code("cancel_not_allowed", lambda: self.store.cancel(self.identity, "old", self.cancel_body()))


class RaceTests(StoreTestCase):
    def test_cancel_and_claim_race_has_no_mixed_state(self):
        for iteration in range(6):
            name, revision = "race" + str(iteration), iteration + 1
            self.ready(name, revision=revision)
            barrier, results = threading.Barrier(3), []

            def cancel():
                barrier.wait()
                try:
                    self.store.cancel(self.identity, name, self.cancel_body())
                    results.append("cancelled")
                except ApiError as exc:
                    results.append(exc.code)

            def claim():
                barrier.wait()
                try:
                    self.store.claim(self.identity, name, self.claim_body())
                    results.append("claimed")
                except ApiError as exc:
                    results.append(exc.code)

            workers = [threading.Thread(target=cancel), threading.Thread(target=claim)]
            for worker in workers:
                worker.start()
            barrier.wait()
            for worker in workers:
                worker.join(5)
                self.assertFalse(worker.is_alive())
            snapshot = self.store.get(self.identity, name)
            if "claimed" in results:
                self.assertEqual(snapshot["delivery"]["status"], "claimed")
                self.assertEqual(snapshot["decision"]["action"], "reply")
            else:
                self.assertIn("reply_deadline_exceeded", results)
                self.assertEqual(snapshot["delivery"]["status"], "unclaimed")
                self.assertIsNone(snapshot["delivery"]["attempt_id"])
                self.assertEqual(snapshot["decision"]["reason"], "reply_deadline_exceeded")

    def test_cancel_and_model_return_race_keeps_one_outcome(self):
        for iteration in range(6):
            name, revision = "late" + str(iteration), iteration + 1
            self.enqueue(name, revision=revision)
            job = self.store.next_job(accept=lambda job: job["event_id"] == name)
            outcome = decide(job)
            barrier = threading.Barrier(3)
            results = []

            def cancel():
                barrier.wait()
                try:
                    self.store.cancel(self.identity, name, self.cancel_body())
                    results.append("cancelled")
                except ApiError as exc:
                    results.append(exc.code)

            def finish():
                barrier.wait()
                results.append("finished:" + self.store.finish(job, outcome)["action"])

            workers = [threading.Thread(target=cancel), threading.Thread(target=finish)]
            for worker in workers:
                worker.start()
            barrier.wait()
            for worker in workers:
                worker.join(5)
            snapshot = self.store.get(self.identity, name)
            timed = [r for r in results if r.startswith("finished:")][0]
            if snapshot["decision"]["reason"] == "reply_deadline_exceeded":
                self.assertIn(timed, ("finished:handoff", "finished:reply"))
                self.assertEqual(snapshot["timing"]["failure_class"], "cancelled")
            else:
                self.assertEqual(snapshot["decision"]["action"], "reply")
                self.assertEqual(timed, "finished:reply")

    def test_cancelled_event_does_not_freeze_new_buyer_message(self):
        self.ready("old")
        self.store.cancel(self.identity, "old", self.cancel_body())
        snapshot = self.ready("new", revision=2)
        self.assertEqual(snapshot["decision"]["action"], "reply")
        claimed = self.store.claim(self.identity, "new", self.claim_body(attempt_id="new-attempt"))
        self.assertEqual(claimed["delivery"]["status"], "claimed")


class RestartTests(StoreTestCase):
    def restart_at(self, wall):
        self.clock.wall = wall
        self.restart()

    def test_budget_expired_during_downtime_is_conservatively_terminated(self):
        self.enqueue("evt", remaining_budget_ms=1000)
        self.clock.sleep(30)
        self.restart()
        snapshot = self.store.get(self.identity, "evt")
        self.assertEqual((snapshot["state"], snapshot["decision"]["reason"]), ("ready", "reply_deadline_exceeded"))
        self.assert_code("reply_deadline_exceeded", lambda: self.store.claim(self.identity, "evt", self.claim_body()))

    def test_restart_conservatively_expires_even_if_wall_clock_looks_valid(self):
        self.enqueue("evt", remaining_budget_ms=10000)
        self.clock.sleep(1)
        self.restart()
        snapshot = self.store.get(self.identity, "evt")
        self.assertEqual(snapshot["decision"]["reason"], "reply_deadline_exceeded")
        self.assertIsNone(self.store.next_job())
        columns = [row[1] for row in self.store.db.execute("PRAGMA table_info(event_runtime)")]
        self.assertNotIn("accepted_mono", columns)

    def test_missing_or_corrupt_metadata_cannot_revive_budget(self):
        for index, mutation in enumerate(("DELETE FROM event_runtime", "UPDATE event_runtime SET wall_deadline=NULL,timing='broken'", "UPDATE event_runtime SET budget_ms=30000,wall_deadline=1e99")):
            name = "corrupt" + str(index)
            self.heartbeat()
            self.enqueue(name, revision=index + 1, remaining_budget_ms=15000)
            with self.store.db:
                self.store.db.execute(mutation)
            self.restart()
            self.assertEqual(self.store.get(self.identity, name)["decision"]["reason"], "reply_deadline_exceeded")

    def test_detectable_clock_step_back_expires(self):
        self.enqueue("evt", remaining_budget_ms=15000)
        self.store.expire_deadlines()  # writes a checkpoint
        self.clock.sleep(-120)
        self.restart()
        self.assertEqual(self.store.get(self.identity, "evt")["decision"]["reason"], "reply_deadline_exceeded")

    def test_legacy_events_recover_unchanged_without_deadline(self):
        self.enqueue("legacy")
        job = self.store.next_job()
        self.clock.sleep(120)
        self.restart()
        snapshot = self.store.get(self.identity, "legacy")
        self.assertEqual((snapshot["state"], snapshot["decision"]), ("pending", None))
        self.assertNotIn("event_deadline", snapshot)
        renewed = self.heartbeat(caps=("reply_deadline",))
        self.assertEqual(renewed["generation"], self.lease["generation"])
        processed = self.store.next_job()
        self.assertEqual(processed["event_id"], "legacy")
        self.assertNotIn("deadline_monotonic", processed)
        self.store.finish(processed, decide(processed))
        self.assertNotIn("queue_wait_ms", self.store.get(self.identity, "legacy")["timing"])
        self.assertIn("decision_ms", self.store.get(self.identity, "legacy")["timing"])

    def test_restart_does_not_refresh_accepted_budget(self):
        self.enqueue("evt", remaining_budget_ms=2000)
        first = self.store._runtime("a", "evt")["wall_deadline"]
        self.clock.sleep(1)
        self.restart()
        self.assertEqual(self.store._runtime("a", "evt")["wall_deadline"], first)
        self.clock.sleep(2)
        self.restart()
        self.assertEqual(self.store.get(self.identity, "evt")["decision"]["reason"], "reply_deadline_exceeded")

    def test_unknown_and_claimed_receipt_rules_survive_restart(self):
        self.enqueue("evt", remaining_budget_ms=20000)
        job = self.store.next_job()
        self.store.finish(job, decide(job))
        self.store.claim(self.identity, "evt", self.claim_body())
        self.restart()
        snapshot = self.store.get(self.identity, "evt")
        self.assertEqual(snapshot["delivery"]["status"], "unknown")
        self.assertEqual(snapshot["delivery"]["attempt_id"], "attempt")
        self.assert_code("delivery_terminal", lambda: self.store.claim(self.identity, "evt", self.claim_body()))
        self.assert_code("receipt_conflict", lambda: self.store.receipt(self.identity, "evt", {"attempt_id": "attempt", "status": "not_sent"}))
        self.assertEqual(self.store.get(self.identity, "evt")["delivery"]["status"], "unknown")

    def test_interrupted_processing_budget_event_waits_for_owner_then_follows_deadline(self):
        self.enqueue("evt", remaining_budget_ms=20000)
        self.store.next_job()
        self.restart()
        self.assertIsNone(self.store.next_job())
        self.clock.sleep(30)
        self.restart()
        snapshot = self.store.get(self.identity, "evt")
        self.assertEqual(snapshot["decision"]["reason"], "reply_deadline_exceeded")


class AdditionalBoundaryTests(StoreTestCase):
    def test_wall_clock_jump_does_not_extend_or_shorten_running_budget(self):
        for index, jump in enumerate((-300, 300)):
            self.heartbeat()
            name = "clock" + str(index)
            snapshot = self.enqueue(name, revision=index + 1, remaining_budget_ms=1000)
            self.clock.wall += jump
            self.store.expire_deadlines()
            self.assertEqual(self.store.get(self.identity, name)["state"], "pending")
            self.clock.mono += 1
            self.store.expire_deadlines()
            result = self.store.get(self.identity, name)
            self.assertEqual(result["decision"]["reason"], "reply_deadline_exceeded")
            self.assertEqual(result["event_deadline"], snapshot["event_deadline"])

    def test_capability_withdrawal_blocks_first_cancel_but_cannot_stop_expiry(self):
        self.enqueue(remaining_budget_ms=1000)
        self.heartbeat(caps=())
        self.assert_code("capability_not_confirmed", lambda: self.store.cancel(self.identity, "evt", self.cancel_body()))
        self.assertEqual(self.store.get(self.identity, "evt")["state"], "pending")
        self.clock.sleep(1)
        ended = self.store.cancel(self.identity, "evt", self.cancel_body())
        self.assertEqual(ended["timing"]["failure_class"], "deadline_exceeded")
        self.assertEqual(self.store.cancel(self.identity, "evt", self.cancel_body()), ended)

    def test_same_attempt_after_permit_expiry_is_rejected_and_unknown_is_durable(self):
        self.enqueue(remaining_budget_ms=20000)
        work = self.store.next_job()
        self.store.finish(work, decide(work))
        self.store.claim(self.identity, "evt", self.claim_body())
        self.clock.sleep(11)
        self.assert_code("delivery_terminal", lambda: self.store.claim(self.identity, "evt", self.claim_body()))
        row = self.rows("evt")[0]  # Inspect without GET performing more maintenance.
        self.assertEqual(json.loads(row["delivery"])["status"], "unknown")
        self.assert_code("cancel_not_allowed", lambda: self.store.cancel(self.identity, "evt", self.cancel_body()))

    def test_ready_send_item_expires_or_restarts_without_attempt(self):
        from test_send_items import options, settings
        for index, restart in enumerate((False, True)):
            self.heartbeat(caps=("send_item", "reply_deadline"))
            self.store.update_settings("a", settings())
            name = "item" + str(index)
            payload = self.payload(name, revision=index + 1, remaining_budget_ms=1000)
            payload["context"]["messages"][0]["content"] = "安装"
            payload["context"]["send_options"] = options()
            self.store.enqueue(self.identity, payload)
            work = self.store.next_job()
            self.store.finish(work, decide(work))
            self.assertEqual(self.store.get(self.identity, name)["decision"]["action"], "send_item")
            if restart:
                self.restart()
            else:
                self.clock.sleep(1)
            self.assert_code("reply_deadline_exceeded", lambda: self.store.claim(self.identity, name, self.claim_body()))
            self.assertIsNone(self.store.get(self.identity, name)["delivery"]["attempt_id"])

    def test_expired_claim_rejection_commits_without_get_or_maintenance(self):
        self.enqueue(remaining_budget_ms=1000)
        work = self.store.next_job()
        self.store.finish(work, decide(work))
        self.clock.sleep(1)
        self.assert_code("reply_deadline_exceeded", lambda: self.store.claim(self.identity, "evt", self.claim_body()))
        self.assertEqual(json.loads(self.rows("evt")[0]["decision"])["reason"], "reply_deadline_exceeded")



if __name__ == "__main__":
    unittest.main()
