"""Metadata-only alerts using fictional jobs, credentials and temporary data."""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import Future
from unittest.mock import patch

from backend.app import create_server
from backend.operations import Operations


class OperationsTests(unittest.TestCase):
    def test_streaks_are_per_shop_and_only_successful_model_results_reset(self):
        health = Operations()
        for _ in range(3):
            health.model_finished("a", {"reason": "model_unavailable:private-provider-text"})
        health.model_finished("b", {"reason": "model_not_configured"})
        health.model_finished("a", {"reason": "rule:fictional"})
        health.model_finished("a", {"reason": "reply_deadline_exceeded"})
        self.assertEqual(health.snapshot(), {"model_failures": {"a": 3, "b": 1}})
        snapshot = health.snapshot()
        snapshot["model_failures"]["a"] = 100
        self.assertEqual(health.snapshot()["model_failures"]["a"], 3)
        health.model_finished("a", {"reason": "model:primary:ok"})
        self.assertEqual(health.snapshot(), {"model_failures": {"b": 1}})
        health.model_finished("b", {"reason": "rule_semantic:r"})
        self.assertEqual(health.snapshot(), {"model_failures": {}})

    def test_authenticated_summary_and_actual_worker_failure_before_fallback(self):
        config = {"shops": [{"shop_id": "a", "name": "Fictional"}],
                  "clients": [{"shop_id": "a", "client_id": "c", "token": "c" * 40}]}
        with tempfile.TemporaryDirectory() as directory:
            server = create_server(config, directory)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            base = "http://127.0.0.1:" + str(server.server_port)

            def request(path, body=None, token=None):
                headers = {"Content-Type": "application/json"}
                if token:
                    headers["Authorization"] = "Bearer " + token
                data = json.dumps(body).encode() if body is not None else None
                req = urllib.request.Request(base + path, data, headers)
                try:
                    response = opener.open(req, timeout=5)
                except urllib.error.HTTPError as exc:
                    response = exc
                with response:
                    return response.code, json.load(response)

            try:
                self.assertEqual(request("/api/v1/admin/summary")[0], 401)
                self.assertEqual(request("/api/v1/admin/summary", token="c" * 40)[0], 403)
                _, login = request("/api/v1/admin/login", {"username": "admin", "password": "admin"})
                token = login["session_token"]
                self.assertEqual(request("/api/v1/admin/summary", token=token)[0], 403)
                password = "fictional-health-password"
                self.assertEqual(request("/api/v1/admin/password", {"current_password": "admin", "new_password": password,
                                 "confirm_password": password}, token)[0], 200)
                _, login = request("/api/v1/admin/login", {"username": "admin", "password": password})
                job = {"shop_id": "a", "event_id": "fictional"}
                for _ in range(3):
                    future = Future()
                    with patch("backend.app.decide", return_value={"action": "handoff", "reason": "model_unavailable:private-text"}):
                        server._model_work(job, {}, future)
                    self.assertEqual(future.result()["action"], "handoff")
                code, payload = request("/api/v1/admin/summary", token=login["session_token"])
                self.assertEqual(code, 200)
                self.assertEqual(payload["maintenance"]["model_failures"], {"a": 3})
                self.assertIs(payload["maintenance"]["worker_alive"], True)
                self.assertEqual(set(payload["maintenance"]["backup"]), {"status", "last_success"})
                self.assertNotIn("private-text", json.dumps(payload))
                self.assertEqual(payload["counts"]["unknown"], 0)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(5)
