"""Server/model integration with private temporary fictional tables and fake providers."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from backend.app import create_server, validate_config
from backend.engine import ProviderFailure, decide, model_decide
from backend.store import ApiError
from test_vehicle_knowledge import document

SLOT = {"model": "fake-provider", "base_url": "http://127.0.0.1:1/v1",
        "timeout_seconds": 1, "use_environment_key": False}


def completion():
    return {"choices": [{"message": {"content": json.dumps({"action": "handoff", "text": "", "reason": "synthetic"})}}]}


class GoodsVehicleIntegrationTests(unittest.TestCase):
    def test_model_context_uses_only_server_catalog_and_preserves_sources(self):
        ctx = {"messages": [{"id": "m", "role": "buyer", "kind": "text", "content": "示例车A", "created_at": time.time()}],
               "history_complete": True, "vehicle_knowledge": {"attacker": "forged"},
               "goods": [{"goods_ref": "opaque", "title": "虚构商品", "evidence": []}]}
        trusted = {"status": "ambiguous", "candidates": [{"model": "示例车A 20-24款"}]}
        before = copy.deepcopy(ctx)
        with patch("backend.engine._post", side_effect=[ProviderFailure("http_503"), completion()]) as post:
            model_decide(ctx, {"mode": "model"}, {"primary": SLOT, "backup": SLOT}, vehicle_context=trusted)
        self.assertEqual(len(post.call_args_list), 2)
        for call in post.call_args_list:
            messages = call.args[1]["messages"]
            view = json.loads(messages[1]["content"])
            self.assertEqual(view["vehicle_knowledge"], trusted)
            self.assertEqual(view["goods"], ctx["goods"])
            self.assertIn("not fitment approval", messages[0]["content"])
            self.assertIn("Neither is current selling price", messages[0]["content"])
        self.assertEqual(ctx, before)
        with patch("backend.engine._post", return_value=completion()) as post:
            model_decide(ctx, {"mode": "model"}, {"primary": SLOT})
        self.assertNotIn("vehicle_knowledge", json.loads(post.call_args.args[1]["messages"][1]["content"]))

    def test_negotiated_budget_worker_input_retains_local_knowledge(self):
        job = {"payload": {"received_at": time.time(), "context": {"history_complete": True, "messages": [
            {"id": "m", "kind": "text", "role": "buyer", "content": "示例车A", "created_at": time.time()}]}},
            "settings": {"enabled": True, "mode": "model"}, "deadline_monotonic": time.monotonic()+10,
            "vehicle_knowledge": {"status": "not_found", "candidates": []}}
        with patch("backend.engine.model_decide", return_value={"action": "handoff"}) as model:
            decide(job, {})
        self.assertEqual(model.call_args.kwargs["vehicle_context"], job["vehicle_knowledge"])
        self.assertEqual(model.call_args.kwargs["deadline_monotonic"], job["deadline_monotonic"])

    def test_optional_config_rejects_unknown_shop_or_relative_directory(self):
        config = {"shops": [{"shop_id": "a", "name": "虚构店"}], "clients": []}
        validate_config(config)
        for bad in ([], {"other": "/unused"}, {"a": "relative"}, {"a": None}):
            with self.subTest(bad=bad):
                with self.assertRaises(ApiError): validate_config({**config, "vehicle_knowledge": bad})

    def test_real_scheduler_shop_isolation_disabled_mode_and_no_database_copy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); vault = root / "catalog"; vault.mkdir()
            (vault / "a.md").write_text(document(尺码="PRIVATE_FIXTURE_SIZE"), encoding="utf-8")
            config = {"shops": [{"shop_id": k, "name": "虚构店"} for k in ("a", "b")], "clients": [],
                      "model": {"primary": SLOT}, "vehicle_knowledge": {"a": str(vault)}}
            calls = []
            def post(_, body):
                calls.append(copy.deepcopy(body)); return completion()
            with patch("backend.engine._post", side_effect=post):
                server = create_server(config, root / "data", port=0)
                try:
                    def enqueue(shop, number):
                        identity = {"shop_id": shop, "client_id": "client-" + shop}
                        lease = server.store.heartbeat(identity, {"instance_id": "i", "session_id": "s"})
                        now = time.time(); key = shop + str(number)
                        p = {"event_id": key, "message_id": key, "conversation_id": key, "context_revision": 1,
                             "received_at": now, **{k: lease[k] for k in ("instance_id", "session_id", "generation")},
                             "context": {"history_complete": True, "vehicle_knowledge": {"forged": True}, "messages": [
                                 {"id": key, "role": "buyer", "kind": "text", "content": "我的示例车A适配吗", "created_at": now}]}}
                        server.store.enqueue(identity, p); server.wake.set()
                        limit = time.monotonic()+5
                        while time.monotonic() < limit:
                            with server.store.lock:
                                state = server.store.db.execute("SELECT state FROM events WHERE event_id=?", (key,)).fetchone()[0]
                            if state == "ready": return
                            time.sleep(0.01)
                        self.fail("Fictional job did not complete")
                    enqueue("a", 0)  # Default disabled shop never invokes the provider.
                    self.assertEqual(calls, [])
                    for shop in ("a", "b"):
                        server.store.update_settings(shop, {"enabled": True, "mode": "model", "rules": [], "system_prompt": "虚构测试"})
                        enqueue(shop, 1)
                    self.assertEqual(len(calls), 2)
                    a, b = [json.loads(call["messages"][1]["content"]) for call in calls]
                    self.assertEqual(a["vehicle_knowledge"]["status"], "matched")
                    self.assertIn("PRIVATE_FIXTURE_SIZE", json.dumps(a))
                    self.assertNotIn("vehicle_knowledge", b)
                    with server.store.lock:
                        rows = server.store.db.execute("SELECT payload FROM events").fetchall()
                    self.assertNotIn("PRIVATE_FIXTURE_SIZE", str(rows))
                    self.assertNotIn(str(vault), json.dumps(calls))
                finally:
                    server.server_close()
