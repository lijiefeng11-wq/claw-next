import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from backend.engine import decide
from backend.store import ApiError, Store


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.shops = [{"shop_id": s, "name": "虚构店铺"} for s in ("a", "b")]
        self.store = Store(self.tmp.name, self.shops)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(lambda: self.store.close())
        self.admin = {"role": "admin", "username": "admin"}
        self.identities = {s: {"role": "client", "shop_id": s, "client_id": s} for s in ("a", "b")}
        self.leases = {}
        for s in self.identities:
            self.leases[s] = self.store.heartbeat(self.identities[s], {"instance_id": "instance", "session_id": "session"})
            self.store.update_settings(s, {"enabled": True, "mode": "rules", "system_prompt": "测试", "rules": [{"id": "r", "contains": "你好", "reply": "您好"}]})

    def ready(self, name, revision=1, conversation="buyer", shop="a"):
        now = time.time()
        payload = {**self.leases[shop], "event_id": name, "message_id": name, "conversation_id": conversation,
                   "context_revision": revision, "received_at": now,
                   "context": {"history_complete": True, "messages": [{"id": name, "role": "buyer", "kind": "text", "content": "你好", "created_at": now}]}}
        self.store.enqueue(self.identities[shop], payload)
        job = self.store.next_job()
        self.store.finish(job, decide(job))
        return self.store.get(self.identities[shop], name)

    def claim(self, name, shop="a"):
        return self.store.claim(self.identities[shop], name, {**self.leases[shop], "attempt_id": name})

    def unknown(self, name, shop="a"):
        return self.store.receipt(self.identities[shop], name, {"attempt_id": name, "status": "unknown"})

    def verify(self, name, outcome="not_sent", shop="a"):
        return self.store.verify(self.admin, name, {"outcome": outcome, "note": "已核对虚构平台记录"}, shop)

    def assert_code(self, code, call):
        with self.assertRaises(ApiError) as error:
            call()
        self.assertEqual(error.exception.code, code)

    def test_manual_verification_is_audit_only_and_never_resends_old_event(self):
        for outcome in ("sent", "not_sent"):
            shop = "a" if outcome == "sent" else "b"
            self.ready("old", shop=shop)
            self.claim("old", shop)
            before = self.unknown("old", shop)["delivery"]
            blocked = self.ready("blocked", 2, shop=shop)
            self.assertEqual(blocked["decision"]["action"], "reply")
            self.claim("blocked", shop)
            result = self.verify("old", outcome, shop)["delivery"]
            self.assertEqual({k: v for k, v in result.items() if k != "verification"}, {k: v for k, v in before.items() if k != "verification"})
            self.assertEqual(result["verification"]["outcome"], outcome)
            self.assertIsNone(result["platform_message_id"])
            self.assert_code("delivery_terminal", lambda: self.claim("old", shop))
            new = self.ready("new", 3, shop=shop)
            self.assertEqual(new["decision"]["action"], "reply")
            self.assertEqual(self.claim("new", shop)["delivery"]["status"], "claimed")
            self.assert_code("receipt_conflict", lambda: self.store.receipt(self.identities[shop], "old", {"attempt_id": "old", "status": "not_sent"}))
            self.assertEqual(self.unknown("old", shop)["delivery"], result)

    def test_new_message_claim_allowed_with_multiple_unverified_unknowns(self):
        # Multiple claims can precede their receipts; a pending receipt must still fence later sends.
        self.ready("first")
        self.claim("first")
        self.ready("second", 2)
        self.claim("second")
        self.ready("third", 3)
        self.unknown("first")
        self.unknown("second")
        self.assertEqual(self.claim("third")["delivery"]["status"], "claimed")
        self.verify("first")
        self.assertEqual(self.claim("third")["delivery"]["status"], "claimed")
        self.verify("second")
        self.assertEqual(self.claim("third")["delivery"]["status"], "claimed")

    def test_isolation_and_ambiguous_event_ids(self):
        for shop in ("a", "b"):
            self.ready("same", shop=shop)
            self.claim("same", shop)
            self.unknown("same", shop)
        self.ready("other", conversation="other")
        self.claim("other")
        self.unknown("other")
        self.assert_code("ambiguous_event", lambda: self.verify("same", shop=None))
        self.verify("same", shop="a")
        self.assertIsNotNone(self.store.get(self.identities["a"], "same")["delivery"]["verification"])
        self.assertIsNone(self.store.get(self.identities["b"], "same")["delivery"]["verification"])
        self.assertIsNone(self.store.get(self.identities["a"], "other")["delivery"]["verification"])
        self.assert_code("event_not_found", lambda: self.verify("other", shop="b"))

    def test_validation_no_auto_unlock_and_terminal_states(self):
        self.ready("old")
        self.assert_code("verification_conflict", lambda: self.verify("old"))
        self.claim("old")
        self.assert_code("verification_conflict", lambda: self.verify("old"))
        with patch("backend.store.time.time", return_value=time.time() + 11):
            self.store.get(self.identities["a"], "old")
        with patch("backend.store.time.time", return_value=time.time() + 86400):
            self.assertIsNone(self.store.get(self.identities["a"], "old")["delivery"]["verification"])
        for payload in ([], {}, {"outcome": "unknown", "note": "x"}, {"outcome": "sent", "note": " "}, {"outcome": "sent", "note": "x" * 201}, {"outcome": "sent", "note": 3}):
            with self.assertRaises(ApiError):
                self.store.verify(self.admin, "old", payload, "a")
        self.assert_code("admin_required", lambda: self.store.verify(self.identities["a"], "old", {"outcome": "sent", "note": "x"}, "a"))
        self.assertIsNone(self.store.get(self.identities["a"], "old")["delivery"]["verification"])
        self.verify("old")
        self.assert_code("verification_conflict", lambda: self.verify("old", "sent"))

    def test_verification_and_admin_audit_survive_restart(self):
        self.ready("old")
        self.claim("old")
        self.unknown("old")
        result = self.verify("old")["delivery"]
        self.store.close()
        self.store = Store(self.tmp.name, self.shops)
        self.assertEqual(self.store.get(self.identities["a"], "old")["delivery"], result)
        audit = self.store.db.execute("SELECT * FROM delivery_verifications").fetchone()
        self.assertEqual(audit["administrator"], "admin")
        self.assertIsNotNone(self.store.get(self.identities["a"], "old")["delivery"]["verification"])
        self.assertIsNone(self.store.next_job())
        self.assert_code("verification_conflict", lambda: self.verify("old"))

    def test_concurrent_verifications_commit_exactly_one_immutable_result(self):
        self.ready("old")
        self.claim("old")
        self.unknown("old")
        barrier, results = threading.Barrier(3), []
        def run(outcome):
            barrier.wait()
            try:
                results.append(self.verify("old", outcome)["delivery"]["verification"])
            except ApiError as exc:
                results.append(exc.code)
        workers = [threading.Thread(target=run, args=(outcome,)) for outcome in ("sent", "not_sent")]
        for worker in workers:
            worker.start()
        barrier.wait()
        for worker in workers:
            worker.join(3)
            self.assertFalse(worker.is_alive())
        self.assertEqual(results.count("verification_conflict"), 1)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM delivery_verifications").fetchone()[0], 1)

