"""Fictional 1.3 preparation: strict data, policy resolution and receipt aggregation."""
import copy
import time
import unittest
from backend import conversation_actions as ca
from backend.store import ApiError, require, validate_settings


def context(marked=False, color=None, targets=None):
    return {"conv_state": {"marked": marked, "color": color, "observed_at": 100},
            "transfer_targets": targets if targets is not None else [{"target_id": "t1", "name": "虚构客服", "observed_at": 100}]}


def resolved(policy, ctx=None, caps=ca.CAPABILITIES):
    return {**ca.resolve(policy, ctx if ctx is not None else context(), caps, 3, "fallback:error"), "expires_at": time.time() + 60}


MARK = {"action": "mark", "color": "red"}
TRANSFER = {"action": "transfer", "account": "虚构客服", "allow_unmark": True}


class ActionDataTests(unittest.TestCase):
    def test_policies_and_existing_settings_roundtrip(self):
        for policy in (MARK, TRANSFER, {"action": "none"}, {"action": "handoff"}):
            self.assertEqual(ca.validate_policy(policy, require), policy)
        p = {"enabled": True, "mode": "rules", "system_prompt": "", "rules": [{"id": "r", "contains": "x", "handling": MARK}], "fallback": {"error": TRANSFER}}
        self.assertEqual(validate_settings(p), p)
        self.assertFalse(ca.validate_policy({"action": "transfer", "account": "虚构客服"}, require)["allow_unmark"])
        for extra in ({"reply": "x"}, {"send": {"type": "video"}}):
            with self.assertRaises(ApiError):
                validate_settings({**p, "rules": [{**p["rules"][0], **extra}]})

    def test_bad_policy_types_and_unknown_keys(self):
        for policy in (None, [], {}, {"action": []}, {"action": "mark", "color": []}, {"action": "mark", "color": "yellow"}, {"action": "mark", "color": "red", "extra": 1}, {"action": "transfer", "account": "x" * 41}, {"action": "transfer", "account": " "}, {"action": "transfer", "account": "x", "allow_unmark": 1}):
            with self.subTest(policy=policy), self.assertRaises(ApiError):
                ca.validate_policy(policy, require)
        for value in (None, [], {"other": MARK}):
            with self.assertRaises(ApiError):ca.validate_fallback(value, require)

    def test_context_unknown_color_is_distinct_from_unknown_state(self):
        for ctx in ({}, context(), context(None), context(True, None), context(True, "green")):
            before = copy.deepcopy(ctx);ca.validate_context(ctx, require);self.assertEqual(ctx, before)
        for change in ({"marked": 0}, {"marked": None, "color": "red"}, {"observed_at": True}, {"observed_at": float("inf")}, {"color": []}, {"extra": "x"}):
            ctx = context();ctx["conv_state"].update(change)
            with self.subTest(change=change), self.assertRaises(ApiError):ca.validate_context(ctx, require)
        for targets in ([None], [{"target_id": [], "name": "x", "observed_at": 1}], context()["transfer_targets"] * 2, context()["transfer_targets"] * 51):
            with self.assertRaises(ApiError):ca.validate_context({"transfer_targets": targets}, require)

    def test_only_explicit_policy_and_readable_state_can_resolve(self):
        self.assertEqual(ca.READY_CAPABILITIES, ())
        for policy in (MARK, TRANSFER):
            for ctx, caps in ((context(None), ca.CAPABILITIES), ({}, ca.CAPABILITIES), (context(), [])):
                self.assertEqual(resolved(policy, ctx, caps)["action"], "handoff")
        self.assertEqual(resolved(MARK)["action"], "mark")
        self.assertEqual(resolved(MARK, context(True, "red"))["action"], "none")
        self.assertEqual(resolved(MARK, context(True, None))["action"], "mark")
        self.assertEqual(resolved(MARK, context(True, "blue"))["action"], "mark")
        self.assertEqual(resolved(TRANSFER, context(True, "red"))["action"], "transfer")
        self.assertNotIn("text", resolved(MARK))
        self.assertNotIn("text", resolved(TRANSFER))

    def test_recipient_requires_one_exact_name(self):
        target = context()["transfer_targets"][0]
        for targets in ([], [{**target, "name": "虚构客服乙"}], [target, {**target, "target_id": "t2"}]):
            self.assertEqual(resolved(TRANSFER, context(targets=targets))["action"], "handoff")
        self.assertEqual(resolved(TRANSFER)["transfer"]["target_id"], "t1")

    def test_current_version_and_unambiguous_target_are_rechecked(self):
        for policy in (MARK, TRANSFER):
            result = resolved(policy)
            self.assertTrue(ca.valid_decision(result, context(), ca.CAPABILITIES, 3))
            for changed in ({"policy_version": True}, {"policy_version": 2}, {"text": "x"}, {"expires_at": float("inf")}):
                self.assertFalse(ca.valid_decision({**result, **changed}, context(), ca.CAPABILITIES, 3))
            self.assertFalse(ca.valid_decision(result, context(None), ca.CAPABILITIES, 3))
            self.assertFalse(ca.valid_decision(result, context(), [], 3))


class ReceiptTests(unittest.TestCase):
    def check(self, policy, status, steps, **extra):
        expected = resolved(policy)
        return ca.receipt(expected["action"], expected, {"attempt_id": "fake", "status": status, "steps": steps, **extra}, require)

    def test_mark_all_statuses_and_not_started(self):
        for status in ("sent", "not_sent", "unknown"):
            result = self.check(MARK, status, [{"step": "mark", "status": status, "color": "red"}])
            self.assertEqual(result["status"], status)
        self.assertEqual(self.check(MARK, "not_sent", [])["steps"], [])
        with self.assertRaises(ApiError):self.check(MARK, "sent", [], page_observed="marked")
        with self.assertRaises(ApiError):self.check(MARK, "sent", [{"step": "mark", "status": "sent", "color": "blue"}])

    def test_transfer_receipt_table_preserves_partial_side_effect(self):
        blocked = {"step": "transfer", "status": "not_sent", "reason": "blocked_by_mark"}
        for status in ("sent", "not_sent", "unknown"):
            self.assertEqual(self.check(TRANSFER, status, [{"step": "transfer", "status": status}])["status"], status)
        self.assertEqual(self.check({**TRANSFER, "allow_unmark": False}, "not_sent", [blocked])["status"], "not_sent")
        for step_status, unmarked, status in (("sent", True, "sent"), ("not_sent", True, "not_sent"), ("not_sent", False, "not_sent"), ("not_sent", None, "unknown"), ("unknown", True, "unknown"), ("unknown", None, "unknown"), ("sent", False, "unknown")):
            steps = [blocked, {"step": "unmark_and_transfer", "status": step_status, "unmarked": unmarked}]
            result = self.check(TRANSFER, status, steps)
            self.assertEqual(result["steps"][-1]["unmarked"], unmarked)

    def test_unknown_cannot_be_followed_or_aggregated_as_success(self):
        second = {"step": "unmark_and_transfer", "status": "sent", "unmarked": True}
        for first in ({"step": "transfer", "status": "unknown"}, {"step": "transfer", "status": "sent"}, {"step": "transfer", "status": "not_sent"}):
            with self.assertRaises(ApiError):self.check(TRANSFER, "sent", [first, second])
        blocked = {"step": "transfer", "status": "not_sent", "reason": "blocked_by_mark"}
        with self.assertRaises(ApiError):self.check({**TRANSFER, "allow_unmark": False}, "sent", [blocked, second])
        with self.assertRaises(ApiError):self.check(TRANSFER, "sent", [blocked, {**second, "unmarked": None}])

    def test_no_message_ids_raw_values_or_action_mismatch(self):
        mark = [{"step": "mark", "status": "unknown", "color": "red"}]
        for extra in ({"platform_message_id": "invented"}, {"reason": "raw private text"}, {"page_observed": "private-id"}, {"extra": "x"}):
            with self.assertRaises(ApiError):self.check(MARK, "unknown", mark, **extra)
        self.check(MARK, "unknown", mark, platform_message_id=None)
        with self.assertRaises(ApiError):self.check(TRANSFER, "unknown", mark)
