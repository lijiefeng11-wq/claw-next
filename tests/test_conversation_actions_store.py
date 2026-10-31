"""Isolated durable-store/engine checks. Capability enabling is patched only here."""
import tempfile
import time
import unittest
from unittest.mock import patch
from backend import conversation_actions as ca, deadlines
from backend.engine import decide, decision
from backend.store import ApiError, Store

MARK = {"action": "mark", "color": "red"}
TRANSFER = {"action": "transfer", "account": "虚构客服", "allow_unmark": True}


class StoreActionTests(unittest.TestCase):
    def setUp(self):
        self.cap = patch.object(ca, "READY_CAPABILITIES", ca.CAPABILITIES);self.cap.start();self.addCleanup(self.cap.stop)
        self.tmp = tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.shops = [{"shop_id": "a", "name": "虚构店铺"}, {"shop_id": "b", "name": "虚构店铺二"}]
        self.store = Store(self.tmp.name, self.shops);self.addCleanup(lambda: self.store.close())
        self.identity = {"shop_id": "a", "client_id": "client-a"}
        self.lease = self.heartbeat(ca.CAPABILITIES)
        self.settings = {"enabled": True, "mode": "rules", "system_prompt": "", "rules": [{"id": "r", "contains": "x", "handling": MARK}]}
        self.store.update_settings("a", self.settings)

    def heartbeat(self, caps):
        return self.store.heartbeat(self.identity, {"instance_id": "instance", "session_id": "session", "capabilities": list(caps)})

    def event(self, name="e", revision=1, marked=False, caps=ca.CAPABILITIES, **extra):
        now = time.time()
        ctx = {"history_complete": True, "messages": [{"id": name, "role": "buyer", "kind": "text", "content": "x", "created_at": now}]}
        if any(cap in caps for cap in ca.CAPABILITIES):ctx["conv_state"] = {"marked": marked, "color": None, "observed_at": now}
        if "transfer_conversation" in caps:ctx["transfer_targets"] = [{"target_id": "t1", "name": "虚构客服", "observed_at": now}]
        return {"event_id": name, "conversation_id": "buyer", "message_id": name, "received_at": now,
                **{k:self.lease[k] for k in ("instance_id", "session_id", "generation")}, "context_revision": revision, "context": ctx, **extra}

    def ready(self, event=None, result=None):
        self.store.enqueue(self.identity, event or self.event());job = self.store.next_job()
        return job, self.store.finish(job, result or decide(job))

    def claim(self, event="e"):
        return self.store.claim(self.identity, event, {**self.lease, "attempt_id": "attempt"})

    def receipt(self, status, steps, **extra):
        return self.store.receipt(self.identity, "e", {"attempt_id": "attempt", "status": status, "steps": steps, **extra})

    def code(self, expected, fn):
        with self.assertRaises(ApiError) as exc:fn()
        self.assertEqual(exc.exception.code, expected)

    def test_production_gate_stays_closed_even_if_client_requests_both(self):
        with patch.object(ca, "READY_CAPABILITIES", ()):
            lease = self.heartbeat(ca.CAPABILITIES)
        self.assertEqual(lease["capabilities"], [])
        self.code("capability_not_confirmed", lambda:self.store.enqueue(self.identity, self.event()))
        job, result = self.ready(self.event(caps=[]))
        self.assertEqual(result["action"], "handoff")
        self.code("not_reply", self.claim)

    def test_capability_combinations_and_required_fields(self):
        for i, caps in enumerate(([], ["mark_conversation"], ["transfer_conversation"], list(ca.CAPABILITIES))):
            self.lease = self.heartbeat(caps)
            value = self.event("e"+str(i), i+1, caps=caps)
            self.store.enqueue(self.identity, value)
            if caps:
                missing = self.event("missing"+str(i), i+10, caps=caps);del missing["context"]["conv_state"]
                self.code("conv_state_required", lambda:self.store.enqueue(self.identity, missing))

    def test_rule_and_fallback_decisions_omit_text_and_bind_policy(self):
        _, result = self.ready();self.assertEqual(result["action"], "mark");self.assertNotIn("text", result)
        self.assertEqual(result["policy_version"], self.store.shops()[0]["settings"]["version"])
        self.assertEqual(self.claim()["delivery"]["status"], "claimed")
        self.store.update_settings("a", {**self.settings, "rules": [], "fallback": {"unhandled": TRANSFER}})
        _, result = self.ready(self.event("other", 2))
        self.assertEqual(result["action"], "transfer");self.assertEqual(result["transfer"]["target_id"], "t1")
        self.assertNotIn("虚构客服", str(result));self.assertNotIn("text", result)

    def test_unknown_state_does_not_discard_normal_reply(self):
        _, result = self.ready(self.event(marked=None));self.assertEqual(result["action"], "handoff")
        self.store.update_settings("a", {**self.settings, "rules": [{"id": "r", "contains": "x", "reply": "虚构回答"}]})
        _, result = self.ready(self.event("later", 2, marked=None));self.assertEqual(result["action"], "reply")

    def test_no_platform_action_for_authority_or_history_errors(self):
        self.store.update_settings("a", {**self.settings, "fallback": {"error": MARK, "unhandled": MARK}})
        for i, reason in enumerate(("history_incomplete", "lease_busy", "settings_changed", "superseded", "reply_deadline_exceeded")):
            _, result = self.ready(self.event("e"+str(i), i+1), decision("handoff", reason))
            self.assertEqual(result["action"], "handoff")

    def test_timeout_fallback_only_for_model_timeout(self):
        self.store.update_settings("a", {**self.settings, "rules": [], "fallback": {"error": {"action": "handoff"}, "model_timeout": MARK}})
        _, result = self.ready(result=decision("handoff", "model_unavailable:primary=timeout,backup=not_configured"))
        self.assertEqual(result["action"], "mark")
        _, result = self.ready(self.event("error", 2), decision("handoff", "model_unavailable:primary=http_500,backup=not_configured"))
        self.assertEqual(result["action"], "handoff")

    def test_withdrawn_capability_and_changed_policy_reject_completion_or_claim(self):
        self.store.enqueue(self.identity, self.event());job = self.store.next_job();result = decide(job)
        self.heartbeat([])
        self.assertEqual(self.store.finish(job, result)["action"], "none")
        self.lease = self.heartbeat(ca.CAPABILITIES)
        self.ready(self.event("new", 2));self.store.update_settings("a", self.settings)
        self.code("settings_changed", lambda:self.claim("new"))

    def test_forged_color_or_unmark_policy_not_accepted(self):
        self.store.enqueue(self.identity, self.event());job = self.store.next_job();result = decide(job)
        result["mark"]["color"] = "blue"
        self.assertEqual(self.store.finish(job, result)["reason"], "invalid_conversation_action")
        self.store.update_settings("a", {**self.settings, "rules": [{"id": "r", "contains": "x", "handling": {**TRANSFER, "allow_unmark": False}}]})
        self.store.enqueue(self.identity, self.event("other", 2));job = self.store.next_job();result = decide(job)
        result["transfer"]["unmark_policy"]["allow"] = True
        self.assertEqual(self.store.finish(job, result)["action"], "none")

    def test_mark_receipt_is_durable_and_identical_retries_only(self):
        self.ready();self.claim();step = {"step": "mark", "status": "sent", "color": "red"}
        first = self.receipt("sent", [step]);self.assertEqual(first["delivery"]["status"], "sent")
        self.assertIsNone(first["delivery"]["platform_message_id"])
        self.assertEqual(self.receipt("sent", [step])["delivery"], first["delivery"])
        self.code("receipt_conflict", lambda:self.receipt("not_sent", [{**step, "status": "not_sent"}]))
        self.code("invalid_platform_message_id", lambda:self.receipt("sent", [step], platform_message_id="fake"))

    def test_partial_unmark_failure_preserved_and_cannot_be_retried(self):
        self.store.update_settings("a", {**self.settings, "rules": [{"id": "r", "contains": "x", "handling": TRANSFER}]})
        self.ready(self.event(marked=True));self.claim()
        steps = [{"step": "transfer", "status": "not_sent", "reason": "blocked_by_mark"}, {"step": "unmark_and_transfer", "status": "not_sent", "unmarked": True}]
        view = self.receipt("not_sent", steps);self.assertTrue(view["delivery"]["steps"][-1]["unmarked"])
        self.code("delivery_terminal", self.claim)
        self.assertIsNone(self.store.next_job())

    def test_unknown_receipt_and_expired_claim_are_never_overwritten(self):
        self.ready();self.claim();step = {"step": "mark", "status": "unknown", "color": "red"}
        self.receipt("unknown", [step]);self.code("receipt_conflict", lambda:self.receipt("sent", [{**step, "status": "sent"}]))
        self.code("delivery_terminal", self.claim)

    def test_budget_expiry_before_and_after_decision_cannot_revive_action(self):
        self.lease = self.heartbeat([*ca.CAPABILITIES, deadlines.CAPABILITY])
        value = self.event(remaining_budget_ms=1000)
        self.store.enqueue(self.identity, value);job = self.store.next_job()
        self.store._clocks[("a", "e")]["deadline"] = time.monotonic()-1
        result = self.store.finish(job, decide(job));self.assertEqual(result["reason"], "reply_deadline_exceeded")
        self.code("reply_deadline_exceeded", self.claim)
        self.ready(self.event("second", 2, remaining_budget_ms=1000))
        self.store._clocks[("a", "second")]["deadline"] = time.monotonic()-1
        self.code("reply_deadline_exceeded", lambda:self.claim("second"))

    def test_restart_claimed_action_stays_unknown_without_new_attempt(self):
        self.ready();self.claim();self.store.close();self.store = Store(self.tmp.name, self.shops)
        self.assertEqual(self.store.get(self.identity, "e")["delivery"]["status"], "unknown")
        self.code("delivery_terminal", self.claim)
        self.assertIsNone(self.store.next_job())
