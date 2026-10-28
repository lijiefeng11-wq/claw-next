import copy
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from backend.engine import decide, model_decide
from backend.store import ApiError, Store


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.shops = [{"shop_id": "synthetic", "name": "虚构测试店"}]
        self.identity = {"shop_id": "synthetic", "client_id": "client"}
        self.store = Store(self.tmp.name, self.shops)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(lambda: self.store.close())
        self.lease = self.store.heartbeat(self.identity, {"instance_id": "instance", "session_id": "session"})
        self.settings = {"enabled": True, "mode": "rules", "system_prompt": "测试", "rules": [{"id": "test", "contains": "你好", "reply": "您好"}]}
        self.store.update_settings("synthetic", self.settings)

    def event(self, name="evt"):
        now = time.time()
        return {"event_id": name, "instance_id": "instance", "session_id": "session", "generation": self.lease["generation"], "conversation_id": "conversation", "message_id": name, "context_revision": 1, "received_at": now, "context": {"history_complete": True, "messages": [{"id": name, "role": "buyer", "kind": "text", "content": "你好", "created_at": now}]}}

    def ready(self):
        self.store.enqueue(self.identity, self.event())
        job = self.store.next_job()
        self.store.finish(job, decide(job))

    def claim(self, attempt="attempt"):
        return self.store.claim(self.identity, "evt", {**self.lease, "attempt_id": attempt})

    def restart(self):
        self.store.close()
        self.store = Store(self.tmp.name, self.shops)

    def test_data_directory_rejects_second_server(self):
        with self.assertRaises(RuntimeError):
            Store(self.tmp.name, self.shops)

    def test_restart_keeps_uncertain_send_and_does_not_replay(self):
        self.ready()
        self.claim()
        self.restart()
        result = self.store.get(self.identity, "evt")
        self.assertEqual(result["delivery"]["status"], "unknown")
        with self.assertRaises(ApiError):
            self.store.receipt(self.identity, "evt", {"attempt_id": "attempt", "status": "sent", "platform_message_id": "late-receipt"})
        self.assertIsNone(self.store.next_job())

    def test_restart_leaves_interrupted_decision_pending_until_heartbeat(self):
        self.store.enqueue(self.identity, self.event())
        self.assertEqual(self.store.next_job()["event_id"], "evt")
        self.restart()
        result = self.store.get(self.identity, "evt")
        self.assertEqual(result["state"], "pending")
        self.assertIsNone(result["decision"])
        self.assertEqual(result["delivery"]["status"], "unclaimed")
        self.assertIsNone(self.store.next_job())

    def test_expired_claim_becomes_unknown_and_rejects_late_sent(self):
        self.ready()
        self.claim()
        with patch("backend.store.time.time", return_value=time.time() + 11):
            self.assertEqual(self.store.get(self.identity, "evt")["delivery"]["status"], "unknown")
            with self.assertRaises(ApiError):
                self.store.receipt(self.identity, "evt", {"attempt_id": "attempt", "status": "sent", "platform_message_id": "platform"})

    def test_expired_lease_renewal_invalidates_old_generation(self):
        self.ready()
        with patch("backend.store.time.time", return_value=time.time() + 61):
            newer = self.store.heartbeat(self.identity, {"instance_id": "instance", "session_id": "session"})
            self.assertGreater(newer["generation"], self.lease["generation"])
            with self.assertRaises(ApiError):
                self.claim()

    def test_two_claims_race_only_one_attempt_wins(self):
        self.ready()
        barrier, results = threading.Barrier(3), []
        def request(name):
            barrier.wait()
            try:
                self.claim(name)
                results.append("granted")
            except ApiError:
                results.append("denied")
        workers = [threading.Thread(target=request, args=(name,)) for name in ("first", "second")]
        for worker in workers:
            worker.start()
        barrier.wait()
        for worker in workers:
            worker.join(2)
            self.assertFalse(worker.is_alive())
        self.assertCountEqual(results, ["granted", "denied"])

    def test_nontext_context_is_not_silently_ignored(self):
        payload = self.event()
        payload["context"]["messages"][0]["kind"] = "card"
        result = decide({"payload": payload, "settings": self.settings})
        self.assertEqual(result["action"], "handoff")

    def test_missing_model_configuration_hands_off(self):
        self.assertEqual(model_decide({}, {}, {})["reason"], "model_not_configured")

    def test_provider_failure_has_no_automatic_retry(self):
        config = {"version": 1,
                  "primary": {"base_url": "https://example.invalid/v1", "model": "dummy", "timeout_seconds": 5, "api_key": ""},
                  "backup": {"base_url": "", "model": "", "timeout_seconds": 20, "api_key": ""},
                  "api_key_env": "CLAW_NEXT_TEST_UNSET_KEY"}
        with patch.dict("os.environ", {"CLAW_NEXT_TEST_UNSET_KEY": ""}), \
                patch("backend.engine.urllib.request.build_opener") as opener:
            opener.return_value.open.side_effect = TimeoutError()
            result = model_decide({}, {"system_prompt": "测试"}, config)
            self.assertEqual(result["action"], "handoff")
            self.assertEqual(result["reason"], "model_unavailable:primary=timeout,backup=not_configured")
            self.assertEqual(opener.return_value.open.call_count, 1)

    def test_malformed_model_output_never_grants_reply(self):
        invalid = [{"action": "send", "text": "bad", "reason": "bad"}, {"action": "reply", "text": "", "reason": "empty"}, {"action": "reply", "text": "x" * 2001, "reason": "long"}]
        config = {"version": 1,
                  "primary": {"base_url": "https://example.invalid/v1", "model": "dummy", "timeout_seconds": 5, "api_key": ""},
                  "backup": {"base_url": "", "model": "", "timeout_seconds": 20, "api_key": ""},
                  "api_key_env": "CLAW_NEXT_TEST_UNSET_KEY"}
        with patch.dict("os.environ", {"CLAW_NEXT_TEST_UNSET_KEY": ""}), \
                patch("backend.engine.urllib.request.build_opener") as opener:
            response = opener.return_value.open.return_value.__enter__.return_value
            for output in invalid:
                with self.subTest(output=output["reason"]):
                    response.read.return_value = json.dumps({"choices": [{"message": {"content": json.dumps(output)}}]}).encode()
                    result = model_decide({}, {"system_prompt": "测试"}, config)
                    self.assertEqual(result["action"], "handoff")
                    self.assertIn("primary=invalid_output", result["reason"])


if __name__ == "__main__":
    unittest.main()
