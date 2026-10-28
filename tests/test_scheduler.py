"""Fictional events with gated model calls; no model service or platform sends."""
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from backend.app import create_server
from backend.engine import decision
from backend.lock import DataLock
from backend.store import Store


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.condition = threading.Condition()
        self.calls, self.gates = [], {}
        self.active, self.peak = set(), 0
        self.overlap = False
        self.fail_models = set()
        model = patch("backend.engine.model_decide", side_effect=self.model)
        model.start()
        self.addCleanup(model.stop)
        # Startup DNS behavior is covered separately; it is not this test's clock.
        with patch("socket.getfqdn", return_value="localhost"):
            self.server = create_server({"shops": [{"shop_id": s, "name": "Fictional " + s}
                                                   for s in ("a", "b", "c")], "clients": []}, self.temp.name)
        self.addCleanup(self.close)
        self.store = self.server.store
        self.identities, self.leases = {}, {}
        for shop in ("a", "b", "c"):
            self.identities[shop] = {"shop_id": shop, "client_id": "client-" + shop}
            self.leases[shop] = self.store.heartbeat(self.identities[shop],
                                                   {"instance_id": "instance", "session_id": "session"})
            self.store.update_settings(shop, self.settings())

    def settings(self, enabled=True):
        return {"enabled": enabled, "mode": "hybrid", "system_prompt": "Fictional",
                "rules": [{"id": "hello", "contains": "hello", "reply": "Hello"}]}

    def model(self, context, settings, config, allow_send=False):
        name = context["messages"][-1]["id"]
        shop = name[0]
        with self.condition:
            self.overlap |= shop in self.active
            self.active.add(shop)
            self.peak = max(self.peak, len(self.active))
            self.calls.append(name)
            self.condition.notify_all()
        if not self.gates[name].wait(8):
            raise TimeoutError("test gate was not released")
        with self.condition:
            self.active.remove(shop)
        if name in self.fail_models:
            raise ValueError("fictional-private-model-failure")
        return decision("reply", "model:primary", "Fictional suggestion")

    def enqueue(self, name, text="model question", conversation=None, revision=1):
        shop, now = name[0], time.time()
        self.gates[name] = threading.Event()
        payload = {"event_id": name, "conversation_id": conversation or name, "message_id": name,
                   **{k: self.leases[shop][k] for k in ("instance_id", "session_id", "generation")},
                   "context_revision": revision, "received_at": now,
                   "context": {"history_complete": True, "messages": [
                       {"id": name, "role": "buyer", "kind": "text", "content": text, "created_at": now}]}}
        self.store.enqueue(self.identities[shop], payload)
        self.server.wake.set()
        return payload

    def snapshot(self, name):
        return self.store.get(self.identities[name[0]], name)

    def ready(self, name):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            result = self.snapshot(name)
            if result["state"] == "ready":
                return result
            time.sleep(.01)
        self.fail(name + " did not finish while unrelated model calls were gated")

    def started(self, *names):
        with self.condition:
            self.assertTrue(self.condition.wait_for(lambda: all(n in self.calls for n in names), timeout=2),
                            "model calls did not start: " + str(self.calls))

    def close(self):
        self.server.stop.set()
        self.server.wake.set()
        for gate in self.gates.values():
            gate.set()
        self.server.server_close()

    def test_rules_bypass_a_slow_model(self):
        self.enqueue("a1")
        self.started("a1")
        self.enqueue("b1", "hello")
        result = self.ready("b1")
        self.assertEqual(result["decision"]["reason"], "rule:hello")
        self.assertEqual(self.calls, ["a1"])
        self.assertEqual(result["delivery"]["status"], "unclaimed")

    def test_two_model_slots_are_fair_and_rules_bypass_a_full_pool(self):
        with self.store.lock:
            for name in ("a1", "a2", "a3", "b1", "c1"):
                self.enqueue(name)
        self.started("a1", "b1")
        self.assertEqual(set(self.calls), {"a1", "b1"})
        self.assertEqual(self.snapshot("a2")["state"], "pending")
        self.assertEqual(self.snapshot("c1")["state"], "pending")
        self.enqueue("a4", "hello")
        self.assertEqual(self.ready("a4")["decision"]["reason"], "rule:hello")
        self.gates["b1"].set()
        self.started("c1")
        self.assertNotIn("a2", self.calls)
        self.gates["a1"].set()
        self.started("a2")
        self.assertEqual(self.peak, 2)
        self.assertFalse(self.overlap)

    def test_late_reply_is_discarded_after_settings_change(self):
        self.enqueue("a1")
        self.started("a1")
        self.store.update_settings("a", self.settings(enabled=False))
        self.gates["a1"].set()
        result = self.ready("a1")
        self.assertEqual((result["decision"]["action"], result["decision"]["reason"]),
                         ("none", "settings_changed"))

    def test_late_reply_cannot_replace_a_newer_rule_decision(self):
        self.enqueue("a1", conversation="buyer")
        self.started("a1")
        self.enqueue("a2", "hello", conversation="buyer", revision=2)
        self.assertEqual(self.ready("a2")["decision"]["reason"], "rule:hello")
        self.gates["a1"].set()
        result = self.ready("a1")
        self.assertEqual((result["decision"]["action"], result["decision"]["reason"]),
                         ("none", "superseded"))

    def test_late_reply_is_discarded_after_session_change(self):
        self.enqueue("a1")
        self.started("a1")
        self.store.heartbeat(self.identities["a"], {"instance_id": "instance", "session_id": "new-session"})
        self.gates["a1"].set()
        self.assertEqual(self.ready("a1")["decision"]["reason"], "lease_mismatch")

    def test_model_error_frees_the_slot_and_does_not_stop_other_shops(self):
        self.fail_models.add("a1")
        with self.store.lock:
            for name in ("a1", "b1", "c1"):
                self.enqueue(name)
        self.started("a1", "b1")
        self.gates["a1"].set()
        self.assertEqual(self.ready("a1")["decision"]["reason"], "decision_internal_error")
        self.started("c1")
        self.assertTrue(self.server.worker.is_alive())

    def test_rule_backlog_drains_without_waiting_for_model_completions(self):
        with self.store.lock:
            self.enqueue("a1")
            self.enqueue("b1")
        self.started("a1", "b1")
        with self.store.lock:
            for i in range(100):
                self.enqueue("c" + str(i), "hello")
        for i in range(100):
            self.assertEqual(self.ready("c" + str(i))["decision"]["reason"], "rule:hello")
        self.assertEqual(set(self.calls), {"a1", "b1"})

    def test_dead_model_worker_stops_supervisor_for_service_recovery(self):
        with patch.object(self.server, "_model_work", return_value=None):
            self.enqueue("a1")
            self.server.worker.join(2)
        self.assertFalse(self.server.worker.is_alive())
        self.assertEqual(self.snapshot("a1")["state"], "processing")
        self.assertEqual(self.snapshot("a1")["delivery"]["status"], "unclaimed")

    def test_local_decision_error_becomes_handoff_without_stopping_scheduler(self):
        with patch("backend.app.immediate_decision", side_effect=ValueError("fictional-private-failure")):
            self.enqueue("a1", "hello")
            self.assertEqual(self.ready("a1")["decision"]["reason"], "decision_internal_error")
        self.assertTrue(self.server.worker.is_alive())
        self.assertEqual(self.calls, [])

    def test_config_snapshot_failure_leaves_job_pending_for_service_recovery(self):
        with patch.object(self.store, "model_config", side_effect=ValueError("fictional-private-failure")):
            self.enqueue("a1")
            self.server.worker.join(2)
        self.assertFalse(self.server.worker.is_alive())
        self.assertEqual(self.snapshot("a1")["state"], "pending")
        self.assertEqual(self.calls, [])

    def test_incomplete_shutdown_keeps_data_lock_until_model_workers_exit(self):
        with self.store.lock:
            self.enqueue("a1")
            self.enqueue("b1")
        self.started("a1", "b1")
        self.server.stop.set()
        self.server.wake.set()
        self.server.worker.join(2)
        workers = [entry[0] for entry in self.server.model_workers.values()]
        # Simulate the shared join budget expiring without a 25-second test delay.
        with patch.object(workers[0], "join"), patch.object(workers[1], "join"):
            self.server.server_close()
        with self.assertRaises(RuntimeError):
            DataLock(self.temp.name)
        self.assertTrue(all(worker.is_alive() for worker in workers))

    def test_duplicate_ingress_is_decided_once(self):
        payload = self.enqueue("a1")
        self.started("a1")
        for _ in range(3):
            self.store.enqueue(self.identities["a"], payload)
        self.gates["a1"].set()
        self.ready("a1")
        for _ in range(3):
            self.store.enqueue(self.identities["a"], payload)
        self.enqueue("a2", "hello")
        self.ready("a2")
        self.assertEqual(self.calls, ["a1"])

    def test_unknown_is_preserved_and_does_not_block_the_next_message(self):
        self.enqueue("a1", "hello", conversation="buyer")
        self.ready("a1")
        self.store.claim(self.identities["a"], "a1", {**self.leases["a"], "attempt_id": "attempt"})
        unknown = self.store.receipt(self.identities["a"], "a1", {"attempt_id": "attempt", "status": "unknown"})
        self.store.finish({"shop_id": "a", "event_id": "a1"}, decision("reply", "late", "Must not replace"))
        self.enqueue("a2", "hello", conversation="buyer", revision=2)
        self.ready("a2")
        self.assertEqual(self.snapshot("a1"), unknown)
        self.assertEqual(self.calls, [])

    def test_shutdown_drains_active_models_without_starting_pending_jobs(self):
        with self.store.lock:
            for name in ("a1", "b1", "c1"):
                self.enqueue(name)
        self.started("a1", "b1")
        self.server.stop.set()
        self.server.wake.set()
        closer = threading.Thread(target=self.server.server_close)
        closer.start()
        try:
            self.server.worker.join(2)
            with self.assertRaises(RuntimeError):
                DataLock(self.temp.name)
            self.gates["a1"].set()
            self.gates["b1"].set()
            closer.join(3)
            self.assertFalse(closer.is_alive())
            self.assertNotIn("c1", self.calls)
            lock = DataLock(self.temp.name)
            lock.close()
            restored = Store(self.temp.name, [{"shop_id": s, "name": "Fictional " + s} for s in ("a", "b", "c")])
            try:
                for name in ("a1", "b1"):
                    self.assertEqual(restored.get(self.identities[name[0]], name)["state"], "ready")
                self.assertEqual(restored.get(self.identities["c"], "c1")["state"], "pending")
                self.assertIsNone(restored.next_job(accept=lambda job: True, after_shop=""))
                restored.heartbeat(self.identities["c"], {"instance_id": "instance", "session_id": "session"})
                self.assertEqual(restored.next_job(accept=lambda job: True, after_shop="")["event_id"], "c1")
            finally:
                restored.close()
        finally:
            for gate in self.gates.values():
                gate.set()
            closer.join(3)


if __name__ == "__main__":
    unittest.main()
