"""Focused restart-recovery tests for bounded, identity-fenced event recovery.

All shops, clients and messages are synthetic. No service, credential or
platform API is used.
"""
import hashlib
import json
import tempfile
import threading
import time
import tracemalloc
import unittest
from unittest.mock import patch

from backend.engine import decide
from backend.store import ApiError, Store


class RestartRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.shops = [{"shop_id": shop, "name": "虚构店铺" + shop} for shop in ("a", "b")]
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(self.tmp.name, self.shops)
        self.addCleanup(lambda: self.store.close())
        self.identities = {shop: {"shop_id": shop, "client_id": "client-" + shop} for shop in ("a", "b")}
        self.leases = {shop: self.store.heartbeat(identity, {"instance_id": "instance-" + shop, "session_id": "session-" + shop}) for shop, identity in self.identities.items()}
        for shop in ("a", "b"):
            self.store.update_settings(shop, {"enabled": True, "mode": "rules", "system_prompt": "测试", "rules": [{"id": "r", "contains": "你好", "reply": "您好"}]})

    def payload(self, shop="a", name="evt", revision=1, conversation=None, instance=None, session=None, content="你好"):
        now, lease = time.time(), self.leases[shop]
        return {"event_id": name, "instance_id": instance or lease["instance_id"], "session_id": session or lease["session_id"],
                "generation": lease["generation"], "conversation_id": conversation or "conversation-" + name,
                "message_id": name, "context_revision": revision, "received_at": now,
                "context": {"history_complete": True, "messages": [{"id": name, "role": "buyer", "kind": "text", "content": content, "created_at": now}]}}

    def enqueue(self, name, shop="a", **kwargs):
        return self.store.enqueue(self.identities[shop], self.payload(shop, name, **kwargs))

    def restart(self):
        self.store.close()
        self.store = Store(self.tmp.name, self.shops)

    def decide(self, job):
        self.store.finish(job, decide(job))
        return self.store.get(self.identities[job["shop_id"]], job["event_id"])

    def assert_code(self, code, call):
        with self.assertRaises(ApiError) as error:
            call()
        self.assertEqual(error.exception.code, code)

    def row(self, name, shop="a"):
        return self.store.db.execute("SELECT * FROM events WHERE shop_id=? AND event_id=?", (shop, name)).fetchone()

    def claim(self, name, lease, shop="a", attempt="attempt"):
        return self.store.claim(self.identities[shop], name, {**lease, "attempt_id": attempt})

    def test_blocked_image_queue_does_not_load_every_payload(self):
        for i in range(80):
            self.enqueue("image-" + str(i))
        self.restart()
        # The pending payloads stand in for large image events; none is eligible.
        self.store.db.execute("UPDATE events SET payload=?", ("x" * 220000,))
        self.store.db.commit()
        tracemalloc.start()
        try:
            self.assertIsNone(self.store.next_job())
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertLess(peak, 2 * 1024 * 1024)

    def test_pending_and_interrupted_processing_wait_for_original_heartbeat(self):
        original = self.enqueue("pending")
        self.enqueue("interrupted", conversation="conversation-interrupted")
        self.assertEqual(self.store.next_job()["event_id"], "pending")
        before = {name: (self.row(name)["payload"], self.row(name)["digest"]) for name in ("pending", "interrupted")}

        self.restart()

        for name in ("pending", "interrupted"):
            snapshot = self.store.get(self.identities["a"], name)
            self.assertEqual(snapshot["state"], "pending")
            self.assertIsNone(snapshot["decision"])
            self.assertEqual(snapshot["delivery"]["status"], "unclaimed")
            self.assertNotIn("recovered", snapshot["delivery"])
        # The admin-visible lease keeps the documented shape (no internal marker)
        # and is fenced as expired until a heartbeat resumes it.
        listed = {shop["shop_id"]: shop for shop in self.store.shops()}
        self.assertEqual(listed["a"]["lease"]["expires_at"], 0)
        self.assertNotIn("restart_pending", listed["a"]["lease"])
        # No evaluation (not even a rule/model pass) before the authenticated heartbeat.
        self.assertIsNone(self.store.next_job())

        renewed = self.store.heartbeat(self.identities["a"], {"instance_id": "instance-a", "session_id": "session-a"})
        self.assertEqual(renewed["generation"], original["generation"])
        for name, (stored_payload, stored_digest) in before.items():
            row = self.row(name)
            self.assertEqual(row["payload"], stored_payload)
            self.assertEqual(row["digest"], stored_digest)
            self.assertEqual(stored_digest, hashlib.sha256(json.dumps(json.loads(stored_payload), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest())

        processed = set()
        for _ in range(2):
            job = self.store.next_job()
            self.assertIsNotNone(job)
            self.assertIsNone(job["block_reason"])
            processed.add(job["event_id"])
            snapshot = self.decide(job)
            self.assertEqual(snapshot["decision"]["action"], "reply")
        self.assertEqual(processed, {"pending", "interrupted"})
        self.assertIsNone(self.store.next_job())

    def test_recovered_reply_claim_uses_preserved_generation(self):
        original = self.enqueue("evt")
        self.store.next_job()
        self.restart()
        renewed = self.store.heartbeat(self.identities["a"], {"instance_id": "instance-a", "session_id": "session-a"})
        self.assertEqual(renewed["generation"], original["generation"])
        snapshot = self.decide(self.store.next_job())
        self.assertEqual(snapshot["decision"]["action"], "reply")
        claimed = self.claim("evt", renewed)
        self.assertEqual(claimed["delivery"]["status"], "claimed")

    def test_different_owner_session_never_executes_and_is_superseded(self):
        original = self.enqueue("evt")
        self.restart()
        renewed = self.store.heartbeat(self.identities["a"], {"instance_id": "instance-other", "session_id": "session-other"})
        self.assertGreater(renewed["generation"], original["generation"])
        # The old event is not evaluated (no rule/model pass) and cannot be claimed.
        self.assertIsNone(self.store.next_job())
        snapshot = self.store.get(self.identities["a"], "evt")
        self.assertEqual(snapshot["state"], "ready")
        self.assertEqual(snapshot["decision"]["action"], "none")
        self.assertEqual(snapshot["decision"]["reason"], "superseded")
        self.assertEqual(snapshot["delivery"]["status"], "unclaimed")
        # The new owner is fenced before any decision is consulted.
        self.assert_code("event_session_mismatch", lambda: self.claim("evt", renewed))
        # The pre-restart session/generation cannot claim under the new lease either.
        self.assert_code("lease_mismatch", lambda: self.claim("evt", self.leases["a"]))

        # A genuinely new message from the new session is not permanently blocked.
        fresh = self.payload("a", "new")
        fresh.update({key: renewed[key] for key in ("instance_id", "session_id", "generation")})
        self.store.enqueue(self.identities["a"], fresh)
        job = self.store.next_job()
        self.assertEqual(job["event_id"], "new")
        self.assertIsNone(job["block_reason"])
        self.assertEqual(self.decide(job)["decision"]["action"], "reply")
        self.assertEqual(self.claim("new", renewed)["delivery"]["status"], "claimed")

    def test_same_owner_new_session_also_supersedes(self):
        self.enqueue("evt")
        self.restart()
        self.store.heartbeat(self.identities["a"], {"instance_id": "instance-a", "session_id": "session-new"})
        self.assertIsNone(self.store.next_job())
        snapshot = self.store.get(self.identities["a"], "evt")
        self.assertEqual((snapshot["state"], snapshot["decision"]["action"], snapshot["decision"]["reason"]), ("ready", "none", "superseded"))

    def test_claimed_send_and_unknown_are_not_replayed_after_restart(self):
        self.enqueue("evt")
        self.decide(self.store.next_job())
        self.claim("evt", self.leases["a"], attempt="first")
        self.restart()
        renewed = self.store.heartbeat(self.identities["a"], {"instance_id": "instance-a", "session_id": "session-a"})
        snapshot = self.store.get(self.identities["a"], "evt")
        self.assertEqual(snapshot["delivery"]["status"], "unknown")
        self.assertEqual(snapshot["delivery"]["attempt_id"], "first")
        self.assertIsNone(self.store.next_job())
        self.assert_code("delivery_terminal", lambda: self.claim("evt", renewed, attempt="second"))
        self.assert_code("receipt_conflict", lambda: self.store.receipt(self.identities["a"], "evt", {"attempt_id": "first", "status": "sent", "platform_message_id": "late"}))
        self.assertEqual(self.store.get(self.identities["a"], "evt")["delivery"]["status"], "unknown")

    def test_blocked_pending_event_does_not_starve_other_shop(self):
        self.enqueue("a-evt", shop="a")
        self.enqueue("b-evt", shop="b")
        self.restart()
        # Only shop b's session authenticates; shop a's pending event stays blocked.
        renewed_b = self.store.heartbeat(self.identities["b"], {"instance_id": "instance-b", "session_id": "session-b"})
        job = self.store.next_job()
        self.assertEqual((job["event_id"], job["shop_id"]), ("b-evt", "b"))
        self.assertIsNone(job["block_reason"])
        self.assertEqual(self.decide(job)["decision"]["action"], "reply")
        self.assertEqual(self.claim("b-evt", renewed_b, shop="b")["delivery"]["status"], "claimed")

        self.assertEqual(self.store.get(self.identities["a"], "a-evt")["state"], "pending")
        self.assertIsNone(self.store.next_job())
        self.store.heartbeat(self.identities["a"], {"instance_id": "instance-a", "session_id": "session-a"})
        self.assertEqual(self.store.next_job()["event_id"], "a-evt")

    def test_pending_scan_allows_committed_http_writes_between_candidates(self):
        for i in range(20):
            self.enqueue("queued-" + str(i))
        yielded, resume = threading.Event(), threading.Event()
        failures, results = [], []

        def yield_to_http(_):
            yielded.set()
            if not resume.wait(2):
                raise TimeoutError("HTTP writes were blocked by the scan")

        def scan():
            try:
                results.append(self.store.next_job(accept=lambda job: False, after_shop=""))
            except Exception as exc:
                failures.append(exc)

        with patch("backend.store.time.sleep", side_effect=yield_to_http):
            worker = threading.Thread(target=scan)
            worker.start()
            try:
                self.assertTrue(yielded.wait(2))
                self.store.heartbeat(self.identities["a"], {"instance_id": "instance-a", "session_id": "session-a"})
                self.enqueue("new-during-scan")
                self.store.update_settings("a", {"enabled": False, "mode": "rules", "system_prompt": "", "rules": []})
            finally:
                resume.set()
                worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(results, [None])
        job = self.store.next_job(accept=lambda job: True, after_shop="")
        self.assertEqual(job["block_reason"], "settings_changed")

    def test_enqueue_is_idempotent_across_restart(self):
        payload = self.payload("a", "evt")
        first = self.store.enqueue(self.identities["a"], payload)
        stored = self.row("evt")
        self.restart()
        renewed = self.store.heartbeat(self.identities["a"], {"instance_id": "instance-a", "session_id": "session-a"})
        replay = self.store.enqueue(self.identities["a"], payload)
        self.assertEqual(replay["event_id"], "evt")
        self.assertEqual(replay["created_at"], first["created_at"])
        self.assertEqual(replay["state"], "pending")
        self.assertEqual(replay["context_revision"], first["context_revision"])
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM events").fetchone()[0], 1)
        self.assertEqual((self.row("evt")["payload"], self.row("evt")["digest"]), (stored["payload"], stored["digest"]))

        conflicting = json.loads(json.dumps(payload))
        conflicting["context"]["messages"][0]["content"] = "不同内容"
        self.assert_code("event_conflict", lambda: self.store.enqueue(self.identities["a"], conflicting))

        job = self.store.next_job()
        self.assertEqual(job["event_id"], "evt")
        self.assertEqual(self.decide(job)["decision"]["action"], "reply")
        self.assertEqual(self.claim("evt", renewed)["delivery"]["status"], "claimed")


if __name__ == "__main__":
    unittest.main()
