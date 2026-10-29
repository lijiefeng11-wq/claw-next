"""Synthetic goods evidence, negotiation and replay checks; no platform calls."""
import copy
import json
import tempfile
import unittest

from backend import goods_snapshot
from backend.orders import validate_orders
from backend.store import ApiError, Store, require, validate_event


def context():
    return {"history_complete": True, "messages": [
        {"id": "card", "role": "buyer", "kind": "card", "content": "",
         "created_at": 100, "card": {"type": "goods", "title": "虚构遮阳挡"}},
        {"id": "question", "role": "buyer", "kind": "text", "content": "适合哪款？", "created_at": 101}],
        "orders": [{"order_ref": "o1", "observed_at": 102, "goods_title": "旧摘要独立",
                    "quantity": 9, "items": [{"goods_title": "虚构遮阳挡", "sku": "虚构规格甲",
                                             "quantity": 1, "goods_ref": "g1"},
                                            {"goods_title": "虚构遮阳挡", "sku": "虚构规格乙",
                                             "quantity": 2, "goods_ref": "g1"}]}],
        "goods": [{"goods_ref": "g1", "title": "虚构遮阳挡", "evidence": [
            {"source": "order", "order_ref": "o1", "observed_at": 102},
            {"source": "goods_card", "message_id": "card", "observed_at": 100, "card_price": "历史展示价"}]}]}


def validate(ctx):
    validate_orders(ctx, require)
    goods_snapshot.validate_goods(ctx, require)
    goods_snapshot.validate_references(ctx, require)


class GoodsValidationTests(unittest.TestCase):
    def reject(self, ctx):
        with self.assertRaises(ApiError):
            validate(ctx)

    def test_sources_specs_and_legacy_summary_are_preserved(self):
        ctx = context()
        before = copy.deepcopy(ctx)
        validate(ctx)
        self.assertEqual(ctx, before)
        validate({})
        validate({"goods": []})
        validate({"orders": [{"order_ref": "o", "observed_at": 1,
                              "items": [{"goods_title": ""}]}]})

    def test_required_types_unknown_fields_and_limits(self):
        for value in (None, {}, "bad", [None], [True]):
            with self.subTest(value=value):
                ctx = context(); ctx["goods"] = value; self.reject(ctx)
        for key in ("goods_ref", "title", "evidence"):
            ctx = context(); del ctx["goods"][0][key]; self.reject(ctx)
        for key, values in {"goods_ref": ["", "g" * 65, None, False],
                            "title": ["", "t" * 201, "https://example.invalid", 1],
                            "evidence": [[], None, {}, [None], [True]]}.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    ctx = context(); ctx["goods"][0][key] = value; self.reject(ctx)
        for path in ("goods", "evidence", "items"):
            ctx = context()
            target = {"goods": ctx["goods"][0], "evidence": ctx["goods"][0]["evidence"][0],
                      "items": ctx["orders"][0]["items"][0]}[path]
            target["unexpected"] = "forbidden"; self.reject(ctx)
        ctx = context(); ctx["goods"] *= 11; self.reject(ctx)
        ctx = context(); ctx["goods"][0]["evidence"] *= 3; self.reject(ctx)
        for items in ([], None, {}, [{"goods_title": "x"}] * 6):
            ctx = context(); ctx["orders"][0]["items"] = items; self.reject(ctx)

    def test_evidence_source_specific_fields_and_times(self):
        for index, field in ((0, "order_ref"), (1, "message_id"), (0, "source"), (0, "observed_at")):
            ctx = context(); del ctx["goods"][0]["evidence"][index][field]; self.reject(ctx)
        for field, value in (("message_id", "card"), ("card_price", "old"), ("sku", "x")):
            ctx = context(); ctx["goods"][0]["evidence"][0][field] = value; self.reject(ctx)
        ctx = context(); ctx["goods"][0]["evidence"][1]["order_ref"] = "o1"; self.reject(ctx)
        for value in (None, True, "100", float("nan"), float("inf"), 99):
            ctx = context(); ctx["goods"][0]["evidence"][0]["observed_at"] = value; self.reject(ctx)
        for value in (1, None, " " * 201):
            ctx = context(); ctx["goods"][0]["evidence"][1]["card_price"] = value; self.reject(ctx)
        ctx = context(); ctx["goods"][0]["evidence"][1]["card_price"] = ""; validate(ctx)

    def test_evidence_must_point_into_same_context(self):
        for index, field in ((0, "order_ref"), (1, "message_id")):
            ctx = context(); ctx["goods"][0]["evidence"][index][field] = "another-conversation"; self.reject(ctx)
        for items in (None, [{"goods_title": "无引用"}]):
            ctx = context()
            if items is None: del ctx["orders"][0]["items"]
            else: ctx["orders"][0]["items"] = items
            self.reject(ctx)
        for field, value in (("kind", "text"), ("created_at", 99)):
            ctx = context(); ctx["messages"][0][field] = value; self.reject(ctx)
        for field, value in (("type", "order"), ("title", "另一件商品")):
            ctx = context(); ctx["messages"][0]["card"][field] = value; self.reject(ctx)
        ctx = context(); ctx["orders"][0]["items"][0]["goods_ref"] = "other"; self.reject(ctx)

    def test_duplicates_and_ordering(self):
        ctx = context(); ctx["goods"].append(copy.deepcopy(ctx["goods"][0])); self.reject(ctx)
        ctx = context(); ctx["goods"][0]["evidence"].reverse(); self.reject(ctx)
        ctx = context(); ctx["goods"][0]["evidence"].insert(0, copy.deepcopy(ctx["goods"][0]["evidence"][0])); self.reject(ctx)
        ctx = context()
        card = copy.deepcopy(ctx["goods"][0]); card["goods_ref"] = "g2"; card["evidence"] = card["evidence"][1:]
        ctx["goods"].insert(0, card); self.reject(ctx)
        ctx["goods"].reverse(); validate(ctx)  # Same title does not collapse distinct references.

    def test_items_types_and_partial_evidence_are_independent(self):
        for key, value in (("quantity", True), ("quantity", 0), ("quantity", 1.5),
                           ("sku", "x" * 201), ("goods_title", 7), ("goods_ref", "")):
            ctx = context(); ctx["orders"][0]["items"][0][key] = value; self.reject(ctx)
        ctx = context()
        # Evidence is capped at five sources; an item can still refer to an
        # included goods entry when its sixth source is omitted.
        for i in range(2, 8):
            ctx["orders"].append({"order_ref": "o" + str(i), "observed_at": 101,
                                  "items": [{"goods_title": "同件", "goods_ref": "g1"}]})
        validate(ctx)


class GoodsStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.store = Store(self.temp.name, [{"shop_id": "fake", "name": "虚构店"}])
        self.addCleanup(lambda: self.store.close())
        self.identity = {"shop_id": "fake", "client_id": "fake-client"}
        self.heartbeat([])

    def heartbeat(self, caps):
        self.lease = self.store.heartbeat(self.identity, {"instance_id": "i", "session_id": "s", "capabilities": caps})
        return self.lease

    def payload(self, ctx=None, event="e", revision=1):
        return {"event_id": event, "conversation_id": "c", "message_id": "question",
                "context_revision": revision, "received_at": 103,
                **{k: self.lease[k] for k in ("instance_id", "session_id", "generation")},
                "context": ctx if ctx is not None else context()}

    def test_independent_negotiation_and_unconfirmed_fields(self):
        ctxs = [context(), {"history_complete": True, "messages": context()["messages"], "goods": []},
                {"history_complete": True, "messages": context()["messages"],
                 "orders": [{"order_ref": "o", "observed_at": 1, "items": [{"goods_title": "x"}]}]}]
        for ctx in ctxs:
            with self.assertRaises(ApiError) as caught: self.store.enqueue(self.identity, self.payload(ctx))
            self.assertEqual((caught.exception.status, caught.exception.code), (400, "capability_not_confirmed"))
        self.assertEqual(self.heartbeat(["goods_snapshot", "unknown"])["capabilities"], ["goods_snapshot"])
        self.store.enqueue(self.identity, self.payload())

    def test_old_client_and_retry_after_withdrawal_and_restart(self):
        old = context(); old.pop("goods"); old["orders"][0].pop("items")
        self.store.enqueue(self.identity, self.payload(old, "old"))
        self.heartbeat(["goods_snapshot"])
        p = self.payload(event="new", revision=2); p["message_id"] = "new-question"; p["context"]["messages"][-1]["id"] = "new-question"
        self.store.enqueue(self.identity, p)
        self.heartbeat([])
        self.store.enqueue(self.identity, p)
        changed = copy.deepcopy(p); changed["context"]["goods"][0]["title"] = "changed"
        changed["context"]["messages"][0]["card"]["title"] = "changed"
        with self.assertRaises(ApiError) as caught: self.store.enqueue(self.identity, changed)
        self.assertEqual(caught.exception.code, "event_conflict")
        self.store.close(); self.store = Store(self.temp.name, [{"shop_id": "fake", "name": "虚构店"}])
        self.store.enqueue(self.identity, p)
        with self.assertRaises(ApiError): self.store.enqueue({**self.identity, "client_id": "intruder"}, p)
        row = self.store.db.execute("SELECT payload FROM events WHERE event_id='new'").fetchone()
        self.assertEqual(json.loads(row[0]), p)

    def test_malformed_sources_reject_without_event_or_internal_error(self):
        self.heartbeat(["goods_snapshot"])
        p = self.payload(); del p["context"]["goods"][0]["evidence"][0]["order_ref"]
        with self.assertRaises(ApiError): validate_event(p)
        with self.assertRaises(ApiError): self.store.enqueue(self.identity, p)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM events").fetchone()[0], 0)
