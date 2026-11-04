"""Real loopback HTTP, temporary stores and fake model; no platform or user data."""
import unittest
from unittest.mock import patch

import test_api_contract as api
from backend.engine import ProviderFailure
from test_productcatalog import DOC


class ProductLearningHttpTests(unittest.TestCase):
    def setUp(self):
        self.fx = api.ApiContractTestCase()
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        self.path = "/api/v1/admin/shops/shop-a/product-learning"

    def call(self, method, path, body=None, status=200, token=None):
        return self.fx.assert_status(self.fx.request(method, path, body,
            token=self.fx.admin_token if token is None else token), status)

    def request(self):
        task = self.call("POST", self.path, {"source_url": ""}, 202)
        lease = self.call("POST", "/api/v1/heartbeat", {"instance_id": "i", "session_id": "s",
            "capabilities": ["product_knowledge"]}, token=api.CLIENT_A_TOKEN)
        self.assertEqual(lease["product_learning"]["request_id"], task["request_id"])
        payload = {k: lease[k] for k in ("instance_id", "session_id", "generation")}
        return "/api/v1/product-learning/" + task["request_id"], {**payload, "seq": 0,
            "products": [DOC], "total": 1, "finished": True, "catalog_complete": True, "error": None}

    def test_admin_queues_client_uploads_once_and_other_shop_cannot_use_request(self):
        self.call("POST", self.path, {"source_url": ""}, 403, api.CLIENT_A_TOKEN)
        path, body = self.request()
        learned = [{**DOC, "category": "汽车用品", "selected_indices": [0, 1]}]
        with patch("backend.app.productmodel.learn", return_value=learned) as model:
            self.call("POST", path, body, 409, api.CLIENT_B_TOKEN)
            self.assertEqual(self.call("POST", path, body, token=api.CLIENT_A_TOKEN)["status"], "completed")
            self.call("POST", path, body, token=api.CLIENT_A_TOKEN)
        self.assertEqual(model.call_count, 1)
        status = self.call("GET", self.path)
        self.assertEqual(status["catalog_count"], 1)
        self.assertIn("不含棉", status["products"][0]["facts"])
        self.assertEqual(self.call("GET", "/api/v1/admin/shops/shop-b/product-learning")["catalog_count"], 0)

    def test_model_failure_keeps_old_knowledge_and_reports_failure(self):
        path, body = self.request()
        with patch("backend.app.productmodel.learn", side_effect=ProviderFailure("invalid_output")):
            result = self.call("POST", path, body, token=api.CLIENT_A_TOKEN)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"], "product_learning_failed")
        self.assertEqual(result["catalog_count"], 0)

    def test_old_client_never_gets_command_and_arbitrary_fetch_is_rejected(self):
        self.call("POST", self.path, {"source_url": "http://127.0.0.1/private"}, 400)
        self.call("POST", self.path, {"source_url": ""}, 202)
        lease = self.call("POST", "/api/v1/heartbeat", {"instance_id": "i", "session_id": "s"}, token=api.CLIENT_A_TOKEN)
        self.assertNotIn("product_learning", lease)
        self.assertFalse(self.call("GET", self.path)["client_ready"])
