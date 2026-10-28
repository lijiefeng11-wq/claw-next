"""Persistence and failure regressions using fictional keys and a fake vault."""
from contextlib import closing
import json
import os
import sys
import uuid
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import engine, modelconfig, modelsecrets
from backend.store import ApiError, Store
from secret_fixture import install_secret_fixture


class ModelSecretsTests(unittest.TestCase):
    def setUp(self):
        self.vault = install_secret_fixture(self)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.store = Store(self.directory, [{"shop_id": "demo", "name": "Fictional"}])
        self.addCleanup(lambda: self.store.close())

    def save(self, primary=None, backup=None):
        current = self.store.model_config({})
        return self.store.update_model_config({"version": current["version"],
                                               "primary": primary or {}, "backup": backup or {}}, {})

    def raw(self):
        return json.loads(self.store.db.execute("SELECT payload FROM model_settings WHERE id=1").fetchone()[0])

    def test_save_preserve_replace_clear_never_writes_plaintext(self):
        first = self.save({"api_key": "fictional-first-key"})
        ref = first["primary"]["api_key_ref"]
        self.assertEqual(modelconfig.key_for(first, "primary", {}), "fictional-first-key")
        self.assertNotIn("api_key", self.raw()["primary"])
        again = self.save({"api_key": ""})
        self.assertEqual(again["primary"]["api_key_ref"], ref)
        self.assertEqual(len(self.vault), 1)
        self.save({"api_key": "fictional-next-key"})
        self.assertNotIn(ref, self.vault)
        self.assertEqual(len(self.vault), 1)
        cleared = self.save({"clear_key": True})
        self.assertFalse(self.vault)
        self.assertEqual(modelconfig.key_for(cleared, "primary", {"CLAW_NEXT_MODEL_API_KEY": "do-not-use"}), "")
        for file in self.directory.glob("*.sqlite3*"):
            data = file.read_bytes()
            self.assertNotIn(b"fictional-first-key", data)
            self.assertNotIn(b"fictional-next-key", data)

    def test_second_slot_failure_cleans_new_item_and_keeps_database(self):
        initial = self.save({"api_key": "fictional-original"})
        original = self.raw()
        create = modelsecrets.create.side_effect
        calls = 0

        def fail_second(value):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise modelsecrets.SecretError("secret_storage_unavailable")
            return create(value)

        with patch.object(modelsecrets, "create", side_effect=fail_second):
            with self.assertRaises(ApiError) as error:
                self.save({"api_key": "fictional-new-primary"}, {"api_key": "fictional-new-backup"})
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(self.raw(), original)
        self.assertEqual(set(self.vault), {initial["primary"]["api_key_ref"]})

    def test_database_failure_cleans_new_item_without_deleting_old(self):
        self.save({"api_key": "fictional-original"})
        original = self.raw()
        self.store.db.execute("CREATE TRIGGER deny_model BEFORE INSERT ON model_settings BEGIN SELECT RAISE(FAIL,'blocked'); END")
        self.store.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            self.save({"api_key": "fictional-new"})
        self.assertEqual(self.raw(), original)
        self.assertEqual(list(self.vault.values()), ["fictional-original"])

    def test_locked_or_missing_item_does_not_block_read_preserve_or_clear(self):
        self.save({"api_key": "fictional-original"})
        with patch.object(modelsecrets, "read", side_effect=modelsecrets.SecretError("secret_storage_unavailable")):
            current = self.store.model_config({})
            self.assertTrue(modelconfig.public_config(current, {})["primary"]["key_configured"])
            self.save({"api_key": ""})
            cleared = self.save({"clear_key": True})
            self.assertFalse(modelconfig.public_config(cleared, {})["primary"]["key_configured"])

    def test_legacy_plaintext_migration_preserves_version_and_scrubs_db_and_wal(self):
        secret = "fictional-legacy-key-uniquely-detectable"
        with self.store.db:
            self.store.db.execute("INSERT INTO model_settings VALUES(1,?)", (json.dumps({"version": 7, "base_url": "https://example.invalid", "model": "demo", "api_key": secret}),))
        self.store.close()
        self.store = Store(self.directory, [{"shop_id": "demo", "name": "Fictional"}])
        config = self.store.model_config({})
        self.assertEqual(config["version"], 7)
        self.assertEqual(modelconfig.key_for(config, "primary", {}), secret)
        for file in self.directory.glob("*.sqlite3*"):
            self.assertNotIn(secret.encode(), file.read_bytes())

    def test_failed_migration_preserves_record_and_releases_data_lock(self):
        payload = {"version": 4, "api_key": "fictional-legacy"}
        with self.store.db:
            self.store.db.execute("INSERT INTO model_settings VALUES(1,?)", (json.dumps(payload),))
        self.store.close()
        with patch.object(modelsecrets, "create", side_effect=modelsecrets.SecretError("secret_storage_unavailable")):
            with self.assertRaises(modelsecrets.SecretError):
                Store(self.directory, [{"shop_id": "demo", "name": "Fictional"}])
        with closing(sqlite3.connect(self.directory / "claw-next.sqlite3")) as db:
            self.assertEqual(json.loads(db.execute("SELECT payload FROM model_settings").fetchone()[0]), payload)
        self.store = Store(self.directory, [{"shop_id": "demo", "name": "Fictional"}])

    def test_interrupted_migration_scrub_is_retried_before_startup(self):
        with self.store.db:
            self.store.db.execute("INSERT INTO model_settings VALUES(1,?)", (json.dumps({"api_key": "fictional-old"}),))
        self.store.close()
        with patch.object(Store, "_scrub_legacy_secrets", side_effect=modelsecrets.SecretError("secret_migration_cleanup_failed")):
            with self.assertRaises(modelsecrets.SecretError):
                Store(self.directory, [{"shop_id": "demo", "name": "Fictional"}])
        with closing(sqlite3.connect(self.directory / "claw-next.sqlite3")) as db:
            self.assertTrue(json.loads(db.execute("SELECT payload FROM model_settings").fetchone()[0])["_secret_cleanup_pending"])
        with patch.object(Store, "_scrub_legacy_secrets", autospec=True) as scrub:
            self.store = Store(self.directory, [{"shop_id": "demo", "name": "Fictional"}])
        scrub.assert_called_once()
        self.assertNotIn("_secret_cleanup_pending", self.raw())
        self.assertEqual(len(self.vault), 1)

    def test_failed_key_lookup_never_calls_provider_or_environment_fallback(self):
        config = self.save({"base_url": "https://example.invalid", "model": "demo", "api_key": "fictional"})
        with patch.object(modelsecrets, "read", side_effect=modelsecrets.SecretError("secret_storage_unavailable")), patch.object(engine, "_post") as post:
            result = engine.test_slot(config, "primary")
        self.assertEqual(result["reason"], "secret_storage_unavailable")
        post.assert_not_called()

    def test_locked_primary_can_use_backup_without_killing_worker(self):
        config = self.save({"base_url": "https://primary.invalid", "model": "demo", "api_key": "fictional"},
                           {"base_url": "https://backup.invalid", "model": "demo"})
        context = {"history_complete": True, "messages": [{"id": "m", "role": "buyer", "kind": "text", "content": "fictional", "created_at": 1}]}
        with patch.object(modelsecrets, "read", side_effect=modelsecrets.SecretError("secret_storage_unavailable")), patch.object(engine, "_post", return_value={"choices": [{"message": {"content": json.dumps({"action": "reply", "text": "fictional", "reason": "test"})}}]}) as post:
            result = engine.model_decide(context, {"mode": "model"}, config)
        self.assertEqual(result["action"], "reply")
        self.assertEqual(post.call_count, 1)
        self.assertIn("backup.invalid", post.call_args.args[0]["base_url"])


class PlatformRoutingTests(unittest.TestCase):
    def test_foreign_dpapi_is_not_decrypted_on_mac(self):
        config = modelconfig.stored_config({"primary": {"base_url": "https://example.invalid", "model": "demo", "api_key_dpapi": "dpapi:v1:foreign"}}, {})
        with patch("backend.modelsecrets.sys.platform", "darwin"), patch.object(modelsecrets.dpapi, "decrypt") as decrypt:
            with self.assertRaises(modelsecrets.SecretError) as error:
                modelconfig.key_for(config, "primary", {"CLAW_NEXT_MODEL_API_KEY": "must-not-fallback"})
        self.assertEqual(error.exception.code, "secret_storage_unavailable")
        decrypt.assert_not_called()

    def test_unsupported_platform_refuses_persistence(self):
        with patch("backend.modelsecrets.sys.platform", "linux"):
            with self.assertRaises(modelsecrets.SecretError):
                modelsecrets.create("fictional")

    def test_malformed_reference_cannot_fall_back(self):
        for value in (None, {}, "plaintext", "keychain:v2:bad"):
            with self.subTest(value=value), self.assertRaises(modelsecrets.SecretError):
                modelconfig.key_for({"primary": {"api_key_ref": value, "api_key": "ignored"}}, "primary", {})


@unittest.skipUnless(sys.platform == "darwin" and os.environ.get("CLAW_NEXT_TEST_KEYCHAIN") == "1",
                     "native Keychain integration is opt-in")
class NativeStoreTests(unittest.TestCase):
    def test_native_save_reopen_clear_has_no_database_plaintext(self):
        secret = "fictional-" + uuid.uuid4().hex
        reference = None
        with tempfile.TemporaryDirectory() as directory:
            store = Store(directory, [{"shop_id": "demo", "name": "Fictional"}])
            try:
                config = store.update_model_config({"version": 0, "primary": {"api_key": secret}, "backup": {}}, {})
                reference = config["primary"]["api_key_ref"]
                store.close()
                store = Store(directory, [{"shop_id": "demo", "name": "Fictional"}])
                self.assertEqual(modelconfig.key_for(store.model_config({}), "primary", {}), secret)
                store.update_model_config({"version": 1, "primary": {"clear_key": True}, "backup": {}}, {})
                with self.assertRaises(modelsecrets.SecretError):
                    modelsecrets.read(reference)
                for file in Path(directory).glob("*.sqlite3*"):
                    self.assertNotIn(secret.encode(), file.read_bytes())
            finally:
                store.close()
                if reference:
                    modelsecrets.delete(reference)
