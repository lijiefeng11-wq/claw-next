"""Durable local shop enrollment using the existing decision database."""
import hashlib
import hmac
import json
import re

from .store import DEFAULT_SETTINGS, identifier, require

TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")


def token_digest(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class LocalShops:
    def __init__(self, store, configured_clients, reserved_tokens=()):
        self.store = store
        self.configured_ids = {client["client_id"] for client in configured_clients}
        self.configured_hashes = {token_digest(client["token"]) for client in configured_clients} | {token_digest(token) for token in reserved_tokens}
        with store.lock, store.db:
            store.db.execute("CREATE TABLE IF NOT EXISTS local_shop_clients ("
                             "client_id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE)")
            linked = {row["shop_id"] for row in store.db.execute(
                "SELECT c.* FROM local_shop_clients c JOIN shops s ON s.shop_id=c.shop_id")
                if row["client_id"] not in self.configured_ids and row["token_hash"] not in self.configured_hashes}
            store.shop_ids.update(linked)

    def register(self, payload):
        require(isinstance(payload, dict) and set(payload) == {"shop_id", "name", "client_id", "client_token"},
                "invalid_shop_registration")
        shop_id, name, client_id, token = (payload[key] for key in ("shop_id", "name", "client_id", "client_token"))
        require(identifier(shop_id) and identifier(client_id) and isinstance(name, str)
                and 0 < len(name.strip()) <= 128 and isinstance(token, str) and TOKEN.fullmatch(token),
                "invalid_shop_registration")
        name, digest = name.strip(), token_digest(token)
        store = self.store
        with store.lock:
            require(client_id not in self.configured_ids and digest not in self.configured_hashes,
                    "client_registration_conflict", 409)
            client = store.db.execute("SELECT * FROM local_shop_clients WHERE client_id=?", (client_id,)).fetchone()
            known = store.db.execute("SELECT name FROM shops WHERE shop_id=?", (shop_id,)).fetchone()
            if client is not None:
                require(client["shop_id"] == shop_id and hmac.compare_digest(client["token_hash"], digest)
                        and known is not None and shop_id in store.shop_ids, "client_registration_conflict", 409)
                return {"shop_id": shop_id, "name": known["name"], "client_id": client_id, "created": False}
            require(store.db.execute("SELECT 1 FROM local_shop_clients WHERE token_hash=?", (digest,)).fetchone() is None,
                    "client_registration_conflict", 409)
            require(known is None or shop_id in store.shop_ids, "shop_id_reserved", 409)
            with store.db:
                if known is None:
                    store.db.execute("INSERT INTO shops VALUES (?,?,?)", (shop_id, name, json.dumps(DEFAULT_SETTINGS)))
                store.db.execute("INSERT INTO local_shop_clients VALUES (?,?,?)", (client_id, shop_id, digest))
            store.shop_ids.add(shop_id)
            return {"shop_id": shop_id, "name": known["name"] if known else name,
                    "client_id": client_id, "created": known is None}

    def identity(self, token):
        if not isinstance(token, str) or TOKEN.fullmatch(token) is None:
            return None
        digest = token_digest(token)
        with self.store.lock:
            row = self.store.db.execute("SELECT * FROM local_shop_clients WHERE token_hash=?", (digest,)).fetchone()
            if (row is None or row["client_id"] in self.configured_ids or digest in self.configured_hashes
                    or row["shop_id"] not in self.store.shop_ids):
                return None
            return {"role": "client", "client_id": row["client_id"], "shop_id": row["shop_id"]}
