"""Registry tests use only temporary stores and fictional credentials."""
import concurrent.futures
import hashlib
import json
import pathlib
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from backend.localshops import LocalShops
from backend.store import ApiError, DEFAULT_SETTINGS, Store

CONFIGURED = [{"client_id": "configured-client", "shop_id": "configured-shop", "token": "c" * 43}]


class LocalShopsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="claw-local-shops-")
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(self.tmp.name, [{"shop_id": "configured-shop", "name": "原虚构店铺"}])
        self.registry = LocalShops(self.store, CONFIGURED)

    def tearDown(self):
        self.store.close()

    def payload(self, **changes):
        return {"shop_id": "new-shop", "name": " 新虚构店铺 ", "client_id": "new-client", "client_token": "n" * 43, **changes}

    def assert_error(self, payload, status, code):
        with self.assertRaises(ApiError) as caught:
            self.registry.register(payload)
        self.assertEqual((caught.exception.status, caught.exception.code), (status, code))

    def test_creation_hash_only_default_off_and_restart(self):
        payload = self.payload()
        self.assertEqual(self.registry.register(payload), {"shop_id": "new-shop", "name": "新虚构店铺", "client_id": "new-client", "created": True})
        self.assertFalse(next(shop for shop in self.store.shops() if shop["shop_id"] == "new-shop")["settings"]["enabled"])
        row = self.store.db.execute("SELECT token_hash FROM local_shop_clients").fetchone()
        self.assertEqual(row[0], hashlib.sha256(payload["client_token"].encode()).hexdigest())
        self.assertNotIn(payload["client_token"], "\n".join(self.store.db.iterdump()))
        self.store.close()
        self.store = Store(self.tmp.name, [{"shop_id": "configured-shop", "name": "原虚构店铺"}])
        self.registry = LocalShops(self.store, CONFIGURED)
        self.assertEqual(self.registry.identity(payload["client_token"]), {"role": "client", "client_id": "new-client", "shop_id": "new-shop"})
        self.assertIn("new-shop", {shop["shop_id"] for shop in self.store.shops()})

    def test_existing_settings_name_and_replay_remain_unchanged(self):
        before = self.store.update_settings("configured-shop", {**DEFAULT_SETTINGS, "enabled": True, "system_prompt": "虚构提示"})
        payload = self.payload(shop_id="configured-shop")
        result = self.registry.register(payload)
        self.assertFalse(result["created"])
        self.assertEqual(result["name"], "原虚构店铺")
        self.assertEqual(self.registry.register({**payload, "name": "另一个名称"}), result)
        self.assertEqual(self.store.shops()[0]["settings"], before)

    def test_conflicts_never_overwrite_existing_registration(self):
        self.registry.register(self.payload())
        for changes in ({"client_token": "z" * 43}, {"shop_id": "other-shop"}, {"client_id": "other-client"}):
            self.assert_error(self.payload(**changes), 409, "client_registration_conflict")
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM local_shop_clients").fetchone()[0], 1)
        self.assertEqual(self.registry.identity("n" * 43)["shop_id"], "new-shop")

    def test_configured_credentials_cannot_be_shadowed(self):
        self.assert_error(self.payload(client_id="configured-client"), 409, "client_registration_conflict")
        self.assert_error(self.payload(client_token="c" * 43), 409, "client_registration_conflict")
        self.registry.register(self.payload())
        replacement = LocalShops(self.store, CONFIGURED + [{"client_id": "new-client", "token": "z" * 43}])
        self.assertIsNone(replacement.identity("n" * 43))

    def test_legacy_reserved_credential_cannot_become_a_client(self):
        self.registry = LocalShops(self.store, CONFIGURED, ["r" * 43, "旧静态口令"])
        self.assert_error(self.payload(client_token="r" * 43), 409, "client_registration_conflict")

    def test_bad_payloads_leave_no_new_rows(self):
        invalid = [None, {}, {**self.payload(), "extra": 1}, self.payload(shop_id="bad space"), self.payload(client_id=""), self.payload(name="   "), self.payload(name="名" * 129), self.payload(client_token="x"), self.payload(client_token="+" * 43), self.payload(client_token=3)]
        for payload in invalid:
            with self.subTest(payload=payload):
                self.assert_error(payload, 400, "invalid_shop_registration")
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM local_shop_clients").fetchone()[0], 0)

    def test_old_inactive_shop_is_not_restored_or_overwritten(self):
        with self.store.db:
            self.store.db.execute("INSERT INTO shops VALUES (?,?,?)", ("old-shop", "历史虚构店铺", json.dumps({**DEFAULT_SETTINGS, "enabled": True})))
        self.assert_error(self.payload(shop_id="old-shop"), 409, "shop_id_reserved")
        self.assertNotIn("old-shop", self.store.shop_ids)
        self.assertNotIn("old-shop", {shop["shop_id"] for shop in self.store.shops()})

    def test_concurrent_exact_registration_is_one_atomic_result(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
            results = list(executor.map(lambda _: self.registry.register(self.payload()), range(6)))
        self.assertEqual(sum(result["created"] for result in results), 1)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM local_shop_clients").fetchone()[0], 1)

    def test_failed_transaction_does_not_publish_shop(self):
        self.store.db.execute("CREATE TRIGGER fictional_block BEFORE INSERT ON local_shop_clients BEGIN SELECT RAISE(ABORT, 'fictional'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.registry.register(self.payload())
        self.assertNotIn("new-shop", self.store.shop_ids)
        self.assertIsNone(self.store.db.execute("SELECT 1 FROM shops WHERE shop_id='new-shop'").fetchone())
