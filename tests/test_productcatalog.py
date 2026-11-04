"""Temporary SQLite stores and fake model responses; no real shop or model."""
import copy
import json
import tempfile
import unittest
from unittest.mock import patch

from backend.store import Store, ApiError
from backend.productcatalog import ProductCatalog, selection
from backend import productmodel

K = "a" * 64
DOC = {"product_key": K, "title": "虚构遮阳挡", "facts": ["不含棉", "规格组合：前挡、黑色"], "details_complete": True}


class ProductCatalogTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = Store(tmp.name, [{"shop_id": "a", "name": "甲"}, {"shop_id": "b", "name": "乙"}])
        self.addCleanup(self.store.close)
        self.catalog = ProductCatalog(self.store)
        self.identity = {"role": "client", "shop_id": "a", "client_id": "c"}
        self.body = {"instance_id": "i", "session_id": "s", "capabilities": ["product_knowledge", "goods_snapshot"]}
        self.lease = self.store.heartbeat(self.identity, self.body)

    def start(self):
        task = self.catalog.request("a", "")
        pending = self.catalog.pending(self.identity, self.lease)
        self.assertEqual(task["request_id"], pending["request_id"])
        return pending["request_id"]

    def payload(self, **kw):
        p = {k: self.lease[k] for k in ("instance_id", "session_id", "generation")}
        return {**p, "seq": 0, "products": [copy.deepcopy(DOC)], "total": 1, "finished": True,
                "catalog_complete": True, "error": None, **kw}

    def learned(self, products):
        return [{**p, "category": "汽车用品", "selected_indices": [0]} for p in products]

    def test_atomic_staging_final_publish_and_exact_shop_match(self):
        before = self.store._settings("a")
        req = self.start()
        p = self.payload(finished=False)
        products = self.catalog.begin(self.identity, req, p)
        self.catalog.finish(self.identity, req, p, self.learned(products))
        self.assertEqual(self.catalog.knowledge("a", [{"product_key": K}]), [])
        self.assertEqual(self.store._settings("a"), before)
        final = self.payload(seq=1, products=[])
        self.catalog.begin(self.identity, req, final)
        status = self.catalog.finish(self.identity, req, final, [])
        self.assertEqual(status["status"], "completed")
        knowledge = self.catalog.knowledge("a", [{"product_key": K, "goods_ref": "g-current"}])
        self.assertEqual(knowledge[0]["goods_ref"], "g-current")
        self.assertIn("不含棉", knowledge[0]["facts"])
        self.assertEqual(self.catalog.knowledge("b", [{"product_key": K}]), [])
        after = self.store._settings("a")
        self.assertEqual(after, {**before, "version": before["version"] + 1})

    def test_idempotent_response_loss_no_second_model_work(self):
        req = self.start(); p = self.payload()
        products = self.catalog.begin(self.identity, req, p)
        self.catalog.finish(self.identity, req, p, self.learned(products))
        version = self.store._settings("a")["version"]
        self.assertIsNone(self.catalog.begin(self.identity, req, p))
        self.assertEqual(self.store._settings("a")["version"], version)

    def test_wrong_lease_or_superseded_request_discards_old_work(self):
        req = self.start(); p = self.payload()
        self.catalog.begin(self.identity, req, p)
        self.catalog.request("a", "")
        with self.assertRaises(ApiError):
            self.catalog.finish(self.identity, req, p, self.learned([DOC]))
        self.assertEqual(self.catalog.status("a")["catalog_count"], 0)
        req = self.start()
        with self.assertRaises(ApiError):
            self.catalog.begin(self.identity, req, {**p, "generation": self.lease["generation"] + 1})

    def test_cancel_unknown_upload_stops_pending_result_preserves_old_catalog(self):
        req = self.start(); p = self.payload()
        products = self.catalog.begin(self.identity, req, p)
        self.assertIsNone(self.catalog.begin(self.identity, req, self.payload(products=[], error="product_upload_failed")))
        with self.assertRaises(ApiError):
            self.catalog.finish(self.identity, req, p, self.learned(products))
        self.assertEqual(self.catalog.status("a")["status"], "failed")
        self.assertEqual(self.catalog.status("a")["catalog_count"], 0)

    def test_incomplete_data_is_partial_and_never_deletes_existing_knowledge(self):
        req = self.start(); p = self.payload(products=[{**DOC, "details_complete": False}])
        docs = self.catalog.begin(self.identity, req, p)
        status = self.catalog.finish(self.identity, req, p, self.learned(docs))
        self.assertEqual(status["status"], "partial")
        req = self.start(); p = self.payload(products=[], total=0)
        self.catalog.begin(self.identity, req, p)
        self.catalog.finish(self.identity, req, p, [])
        self.assertEqual(self.catalog.status("a")["catalog_count"], 1)

    def test_capability_revocation_and_malformed_data_before_learning(self):
        req = self.start(); p = self.payload()
        for change in [{"total": True}, {"error": {}}, {"products": [{**DOC, "cookie": "forbidden"}]}]:
            with self.subTest(change=change), self.assertRaises(ApiError):
                self.catalog.begin(self.identity, req, {**p, **change})
        self.store.heartbeat(self.identity, {**self.body, "capabilities": []})
        with self.assertRaises(ApiError): self.catalog.begin(self.identity, req, p)

    def test_source_urls_cannot_select_arbitrary_network_destinations(self):
        self.assertEqual(selection("https://mobile.yangkeduo.com/mall_page.html?ps=fixture"), {})
        self.assertEqual(selection("https://mobile.yangkeduo.com/goods.html?goods_id=123"), {"goods_id": "123"})
        for url in ["http://127.0.0.1/", "https://mms.pinduoduo.com.evil.test/goods.html", "https://u:p@mobile.yangkeduo.com/goods.html", "https://mobile.yangkeduo.com/goods.html?goods_id=1&goods_id=2"]:
            with self.assertRaises(ApiError): selection(url)


class ProductModelTests(unittest.TestCase):
    config = {"primary": {"base_url": "http://127.0.0.1:1234/v1", "model": "qwen3.6-35b-a3b", "timeout_seconds": 10},
              "backup": {"base_url": "http://127.0.0.1:1235/v1", "model": "fictional", "timeout_seconds": 10}}

    def test_anonymous_model_ids_restore_only_original_facts(self):
        response = {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({"products": [{"product": 0, "category": "汽车用品", "indices": [1]}]})}}]}
        with patch.object(productmodel, "_post", return_value=response) as call:
            result = productmodel.learn([DOC], self.config)
        self.assertEqual(call.call_count, 1)
        self.assertEqual(result[0]["facts"], DOC["facts"])
        self.assertEqual(result[0]["selected_indices"], [1])
        self.assertNotIn(K, json.dumps(call.call_args.args[1]))

    def test_bad_primary_one_configured_backup_and_empty_indices_are_legitimate(self):
        good = {"choices": [{"message": {"content": json.dumps({"products": [{"product": 0, "category": "其他", "indices": []}]})}}]}
        with patch.object(productmodel, "_post", side_effect=[{}, good]) as call:
            result = productmodel.learn([DOC], self.config)
        self.assertEqual(call.call_count, 2)
        self.assertEqual(result[0]["selected_indices"], [])
        with patch.object(productmodel, "_post", return_value=good) as call:
            productmodel.learn([DOC], self.config)
        self.assertEqual(call.call_count, 1)


if __name__ == "__main__":
    unittest.main()

class ProductReplyIntegrationTests(unittest.TestCase):
    def test_original_facts_reach_reply_model_with_event_ref_without_changing_context(self):
        from backend.engine import model_decide
        context = {"history_complete": True, "messages": [{"id": "m", "role": "buyer", "kind": "text", "content": "含棉吗？", "created_at": 1790000000}],
                   "product_knowledge": {"forged": "不能采信客户端伪造知识"},
                   "goods": [{"goods_ref": "g-current", "title": DOC["title"], "product_key": K, "evidence": []}]}
        before = copy.deepcopy(context)
        knowledge = [{"goods_ref": "g-current", "title": DOC["title"], "facts": DOC["facts"], "details_complete": False, "category": "汽车用品"}]
        response = {"choices": [{"message": {"content": json.dumps({"action": "reply", "text": "资料标注不含棉。", "reason": "资料原文"})}}]}
        with patch('backend.engine._post', return_value=response) as model:
            model_decide(context, {"mode": "model"}, ProductModelTests.config, product_context=knowledge)
        body = model.call_args.args[1]
        view = json.loads(body['messages'][1]['content'])
        self.assertEqual(view['product_knowledge'], knowledge)
        self.assertNotIn(K, json.dumps(view))
        self.assertIn('no', body['messages'][0]['content'])
        self.assertEqual(context, before)
        with patch('backend.engine._post', return_value=response) as model:
            model_decide(context, {"mode": "model"}, ProductModelTests.config)
        self.assertNotIn('product_knowledge', json.loads(model.call_args.args[1]['messages'][1]['content']))
