"""Issue #56: bounded claim-expiry read and count-exact compatible summary."""
import json
import sqlite3
import tempfile
import time
import unittest
from unittest import mock

import backend.store as store_module
from backend.store import Store

INDEX_SQL = ("CREATE INDEX IF NOT EXISTS events_claimed ON events(json_extract(delivery,'$.status')) "
             "WHERE state='ready'")
HOT_SQL = ("SELECT shop_id,event_id,delivery FROM events WHERE state='ready' "
           "AND json_extract(delivery,'$.status')='claimed'")
STATES = ("pending", "processing", "ready", "sent", "unknown")


def row(shop, event, state, delivery, client="fictitious-client", created_at=1600000000.0):
    """One fully fictitious 14-column events row; payload holds no claim bookkeeping."""
    payload = {"event_id": event, "generation": 1, "instance_id": "fictitious-instance",
               "session_id": "fictitious-session", "note": "fictitious payload text"}
    return (shop, event, client, "buyer-" + event, "message-" + event, "fictitious-session",
            1, 1, created_at, "0" * 64, json.dumps(payload), state,
            json.dumps({"action": "reply", "text": "fictitious"}),
            delivery if isinstance(delivery, str) else json.dumps(delivery))


def unclaimed():
    return {"status": "unclaimed", "attempt_id": None, "platform_message_id": None}


def claimed_at(expires_at):
    return {"status": "claimed", "attempt_id": "fictitious-attempt", "platform_message_id": None,
            "claim_expires_at": expires_at}


def frozen(value):
    """Patch only backend.store's wall-clock reading with a fixed value."""
    return mock.patch.object(store_module.time, "time", lambda: value)


class ClaimExpiryQueryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.shops = [{"shop_id": "shop-a", "name": "虚构店铺甲"},
                      {"shop_id": "shop-b", "name": "虚构店铺乙"}]
        self.store = Store(self.tmp.name, self.shops)
        self.addCleanup(lambda: self.store.close() if self.store else None)

    def insert(self, rows):
        self.store.db.executemany("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        self.store.db.commit()

    def delivery(self, shop, event):
        raw = self.store.db.execute("SELECT delivery FROM events WHERE shop_id=? AND event_id=?",
                                    (shop, event)).fetchone()[0]
        return json.loads(raw)

    def status(self, shop, event):
        return self.delivery(shop, event)["status"]

    def plan(self, sql=HOT_SQL):
        return " ".join(" ".join(str(part) for part in item) for item in
                        self.store.db.execute("EXPLAIN QUERY PLAN " + sql))

    def test_index_is_idempotent_partial_expression_and_selected(self):
        existing = self.store.db.execute("SELECT name FROM sqlite_master WHERE name='events_claimed'").fetchone()
        self.assertIsNotNone(existing)
        self.store.db.execute(INDEX_SQL)
        names = [r[0] for r in self.store.db.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'")]
        self.assertEqual(names.count("events_claimed"), 1)
        sql = self.store.db.execute("SELECT sql FROM sqlite_master WHERE name='events_claimed'").fetchone()[0]
        self.assertIn("json_extract(delivery,'$.status')", sql)
        self.assertIn("WHERE state='ready'", sql)
        self.assertIn("events_claimed", self.plan())

    def test_hot_read_denies_payload_and_expires_only_past_claims(self):
        now = time.time()
        self.insert([row("shop-a", "old", "ready", claimed_at(now - 60)),
                     row("shop-a", "live", "ready", claimed_at(now + 60)),
                     row("shop-b", "plain", "ready", unclaimed())])
        reads = []

        def authorizer(action, arg1, arg2, dbname, source):
            if action == sqlite3.SQLITE_READ and arg1 == "events":
                reads.append(arg2)
                if arg2 == "payload":
                    return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK

        before = self.delivery("shop-a", "old")
        self.store.db.set_authorizer(authorizer)
        try:
            self.store._expire_claims()
        finally:
            self.store.db.set_authorizer(None)
        self.assertNotIn("payload", reads)
        self.assertTrue({"shop_id", "event_id", "delivery"}.issubset(reads))
        self.assertEqual(self.delivery("shop-a", "old"), dict(before, status="unknown", reason="claim_expired"))
        self.assertEqual(self.status("shop-a", "live"), "claimed")
        self.assertEqual(self.delivery("shop-b", "plain"), unclaimed())

    def test_exact_boundary_and_future_claims(self):
        fixed = 1700000000.5
        self.insert([row("shop-a", "edge", "ready", claimed_at(fixed)),
                     row("shop-a", "future", "ready", claimed_at(fixed + 0.001)),
                     row("shop-a", "live", "ready", claimed_at(fixed + 30))])
        with frozen(fixed):
            self.store._expire_claims()
            self.assertEqual(self.status("shop-a", "edge"), "unknown")
            self.assertEqual(self.status("shop-a", "future"), "claimed")
            self.store._expire_claims()
            self.assertEqual(self.status("shop-a", "edge"), "unknown")
            self.assertEqual(self.status("shop-a", "future"), "claimed")
        with frozen(fixed + 0.001):
            self.store._expire_claims()
            self.assertEqual(self.status("shop-a", "future"), "unknown")
            self.assertEqual(self.status("shop-a", "live"), "claimed")
        with frozen(fixed + 29.999):
            self.store._expire_claims()
            self.assertEqual(self.status("shop-a", "live"), "claimed")
        with frozen(fixed + 30):
            self.store._expire_claims()
            self.assertEqual(self.status("shop-a", "live"), "unknown")
        self.assertEqual(self.delivery("shop-a", "edge")["reason"], "claim_expired")

    def test_other_statuses_and_attempt_metadata_preserved(self):
        self.insert([
            row("shop-a", "unclaimed", "ready", unclaimed()),
            row("shop-a", "sent", "ready", {"status": "sent", "attempt_id": "a1",
                                           "platform_message_id": "fictitious-1", "reason": "kept"}),
            row("shop-a", "not_sent", "ready", {"status": "not_sent", "reason": "blocked_by_mark",
                                               "attempt_id": "a3"}),
            row("shop-a", "unknown", "ready", {"status": "unknown", "attempt_id": "a2", "reason": "client_reported",
                                              "receipt": {"code": "FIC-1", "nested": [1, {"deep": True}]}}),
            row("shop-b", "pending", "pending", {"status": "claimed", "attempt_id": "p", "claim_expires_at": 1}),
            row("shop-b", "processing", "processing", {"status": "claimed", "attempt_id": "q", "claim_expires_at": 1})])
        names = ("unclaimed", "sent", "not_sent", "unknown")
        before = {name: self.delivery("shop-a", name) for name in names}
        self.store._expire_claims()
        self.assertEqual({name: self.delivery("shop-a", name) for name in names}, before)
        self.assertEqual(before["unknown"]["receipt"], {"code": "FIC-1", "nested": [1, {"deep": True}]})
        self.assertEqual(self.status("shop-b", "pending"), "claimed")
        self.assertEqual(self.status("shop-b", "processing"), "claimed")

    def test_summary_counts_exactly_like_old_for_active_shops_only(self):
        fixed = 1700000000.0
        rows = [row("shop-a", "a1", "pending", unclaimed()),
                row("shop-a", "a2", "processing", unclaimed()),
                row("shop-a", "a3", "ready", unclaimed()),
                row("shop-a", "a4", "ready", {"status": "sent"}),
                row("shop-a", "a5", "ready", {"status": "unknown"}),
                row("shop-a", "a6", "ready", {"status": "not_sent"}),
                row("shop-a", "a7", "ready", claimed_at(fixed)),
                row("shop-a", "a8", "ready", claimed_at(fixed + 600)),
                row("shop-b", "b1", "pending", unclaimed()),
                row("shop-b", "b2", "ready", {"status": "sent"}),
                row("configured-out", "h1", "pending", unclaimed()),
                row("configured-out", "h2", "ready", {"status": "sent"}),
                row("configured-out", "h3", "ready", claimed_at(fixed))]
        self.insert(rows)

        def old_aggregation(active):
            counts = {name: 0 for name in STATES}
            for entry in rows:
                shop, state, delivery = entry[0], entry[11], json.loads(entry[13])
                if shop not in active:
                    continue
                counts[state] += 1
                if delivery["status"] in ("sent", "unknown"):
                    counts[delivery["status"]] += 1
            return counts

        with frozen(fixed):
            expected = old_aggregation({"shop-a", "shop-b"})
            expected["unknown"] += 1  # The visible expired claim is finalized first.
            result = self.store.summary()
        self.assertEqual(result, {"counts": expected, "protocol_version": "1.0"})
        self.assertEqual(self.delivery("shop-a", "a7")["reason"], "claim_expired")
        self.assertEqual(self.status("shop-a", "a8"), "claimed")
        self.assertEqual(self.status("configured-out", "h3"), "unknown")

    def test_summary_empty_configuration_is_all_zeros(self):
        empty_tmp = tempfile.TemporaryDirectory()
        self.addCleanup(empty_tmp.cleanup)
        empty = Store(empty_tmp.name, [])
        self.addCleanup(empty.close)
        self.assertEqual(empty.shop_ids, set())
        self.assertEqual(empty.summary(), {"counts": {name: 0 for name in STATES}, "protocol_version": "1.0"})

    def test_many_historical_rows_stay_bounded_without_payload_reads(self):
        now = time.time()
        rows = [row("shop-a", "hist%04d" % i, "ready", unclaimed()) for i in range(300)]
        rows += [row("shop-a", "term%04d" % i, "ready", {"status": "sent"}) for i in range(150)]
        rows += [row("shop-b", "expires", "ready", claimed_at(now - 1)),
                 row("shop-b", "live", "ready", claimed_at(now + 300))]
        self.insert(rows)
        self.store.db.execute("ANALYZE")
        plan = self.plan()
        self.assertIn("events_claimed", plan)
        self.assertNotIn("SCAN events", plan)
        violations, reads = [], set()

        def authorizer(action, arg1, arg2, dbname, source):
            if action == sqlite3.SQLITE_READ and arg1 == "events":
                reads.add(arg2)
                if arg2 == "payload":
                    violations.append(arg2)
                    return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK

        before = self.store.db.total_changes
        self.store.db.set_authorizer(authorizer)
        try:
            self.store._expire_claims()
            changed = self.store.db.total_changes - before
        finally:
            self.store.db.set_authorizer(None)
        self.assertEqual(violations, [])
        self.assertEqual(changed, 1)
        self.assertTrue({"shop_id", "event_id", "delivery"}.issubset(reads))
        self.assertEqual(self.status("shop-b", "expires"), "unknown")
        self.assertEqual(self.status("shop-b", "live"), "claimed")
        kept = self.store.db.execute(
            "SELECT count(*) FROM events WHERE shop_id='shop-a' AND state='ready'").fetchone()[0]
        self.assertEqual(kept, 450)

    def test_restart_marks_claims_unknown_without_retry(self):
        now = time.time()
        self.insert([row("shop-a", "expired", "ready", claimed_at(now - 5)),
                     row("shop-a", "fresh", "ready", claimed_at(now + 50))])
        self.store.close()
        self.store = Store(self.tmp.name, self.shops)
        for event in ("expired", "fresh"):
            delivery = self.delivery("shop-a", event)
            self.assertEqual((delivery["status"], delivery["reason"]), ("unknown", "backend_restarted"))
        self.assertIsNone(self.store.next_job())
        self.assertEqual(self.store.summary()["counts"]["unknown"], 2)

