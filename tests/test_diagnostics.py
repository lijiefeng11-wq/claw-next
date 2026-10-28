import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from backend import diagnostics, engine
from backend.app import Handler
import test_api_contract as api
import test_model_failover as models


class DiagnosticsTests(unittest.TestCase):
    def test_rotation_context_isolation_and_exception_redaction(self):
        with tempfile.TemporaryDirectory() as directory:
            log = diagnostics.Diagnostics(directory, max_bytes=800, backups=2)
            for _ in range(25):
                log.write("rotation", count=1)
            def write(ref):
                with diagnostics.scope(log, event_ref=ref):
                    diagnostics.emit("isolated")
            threads = [threading.Thread(target=write, args=(str(i),)) for i in range(3)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            with diagnostics.scope(log):
                try:
                    raise ValueError("secret-password-private-buyer")
                except ValueError as exc:
                    diagnostics.failure("failure", exc)
            log.close()
            files = list((Path(directory) / "logs").glob("backend.jsonl*"))
            self.assertLessEqual(len(files), 3)
            raw = "\n".join(p.read_text(encoding="utf-8") for p in files)
            self.assertNotIn("secret-password-private-buyer", raw)
            records = [json.loads(line) for line in raw.splitlines() if line]
            self.assertEqual({r["event_ref"] for r in records if r["event"] == "isolated"}, {"0", "1", "2"})
            error = next(r for r in records if r["event"] == "failure")
            self.assertEqual(error["error_type"], "ValueError")
            self.assertGreater(error["frames"][-1]["line"], 0)

    def test_fallback_logs_metadata_not_model_or_buyer_content(self):
        with tempfile.TemporaryDirectory() as directory:
            log = diagnostics.Diagnostics(directory)
            responses = [engine.ProviderFailure("timeout"),
                         {"choices": [{"message": {"content": json.dumps({"action": "reply", "text": "private-answer", "reason": "private-reason"})}}]}]
            with diagnostics.scope(log, event_ref="synthetic"), patch.object(engine, "_post", side_effect=responses):
                result = engine.model_decide(models.context("private-buyer"), models.SETTINGS,
                                             models.config(models.slot("https://example.com/v1", key="secret-key"), models.slot("https://example.org/v1")))
            self.assertEqual(result["action"], "reply")
            log.close()
            raw = (Path(directory) / "logs/backend.jsonl").read_text(encoding="utf-8")
            for secret in ("secret-key", "private-buyer", "private-answer", "private-reason", "example.com"):
                self.assertNotIn(secret, raw)
            records = [json.loads(line) for line in raw.splitlines()]
            self.assertEqual([r["event"] for r in records], ["model_attempt", "model_failed", "model_attempt", "model_succeeded"])
            self.assertTrue(records[-1]["fallback"])

    def test_logging_failure_does_not_raise(self):
        with tempfile.TemporaryDirectory() as directory:
            log = diagnostics.Diagnostics(directory)
            with patch.object(log.logger, "info", side_effect=OSError("disk full")):
                log.write("example")
            log.close()

    def test_http_errors_and_task_delivery_are_correlated_without_payloads(self):
        fixture = api.ApiContractTestCase()
        fixture.setUp()
        try:
            lease, event, ready = fixture.ready_reply_event()
            fixture.claim(lease, event["event_id"], "synthetic-attempt")
            fixture.receipt(lease, event["event_id"], "synthetic-attempt", "unknown")
            with patch.object(Handler, "_route", side_effect=RuntimeError("secret-exception")):
                fixture.assert_status(fixture.request("GET", "/secret-path?token=secret-query"), 500)
            fixture.assert_status(fixture.request("GET", "/api/v1/me"), 401)
            raw = (Path(fixture._tmpdir.name) / "logs/backend.jsonl").read_text(encoding="utf-8")
            for value in ("secret-exception", "secret-path", "secret-query", api.CLIENT_A_TOKEN, api.RULE_REPLY, event["event_id"]):
                self.assertNotIn(value, raw)
            records = [json.loads(line) for line in raw.splitlines()]
            ref = diagnostics.reference("shop-a", event["event_id"])
            related = [r for r in records if r.get("event_ref") == ref]
            self.assertTrue(any(r["event"] == "decision_finished" for r in related))
            self.assertTrue(any(r.get("delivery") == "unknown" for r in related))
            self.assertTrue(any(r["event"] == "request_internal_error" and r["frames"] for r in records))
            self.assertTrue(any(r.get("code") == "unauthorized" for r in records))
        finally:
            fixture.doCleanups()
