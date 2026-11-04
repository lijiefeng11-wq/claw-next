"""Shop-scoped product learning; staging never replaces usable knowledge early."""
import hashlib
import json
import re
import time
import uuid
from urllib.parse import parse_qs, urlsplit

from .productknowledge import choose_knowledge, validate_products
from .store import require

CAPABILITY = "product_knowledge"
FAILURES = {"product_page_unavailable", "product_source_changed", "product_list_invalid",
            "product_details_failed", "product_upload_failed", "product_collection_timeout"}


def selection(raw):
    require(isinstance(raw, str) and len(raw) <= 1000, "invalid_product_url")
    if not raw.strip():
        return {}
    try:
        url = urlsplit(raw.strip())
        require(url.scheme == "https" and url.hostname in
                {"mobile.yangkeduo.com", "mobile.pinduoduo.com", "mms.pinduoduo.com"}
                and not url.username and not url.password and url.port in (None, 443), "invalid_product_url")
        require(url.path in {"/mall_page.html", "/goods.html", "/goods/goods_detail", "/goods/goods_list"}, "invalid_product_url")
        query = parse_qs(url.query)
        result = {}
        for key in ("goods_id", "mall_id"):
            if key in query:
                require(len(query[key]) == 1 and re.fullmatch(r"[0-9]{1,32}", query[key][0]), "invalid_product_url")
                result[key] = query[key][0]
        require(url.path not in {"/goods.html", "/goods/goods_detail"} or "goods_id" in result, "invalid_product_url")
        return result
    except ValueError:
        require(False, "invalid_product_url")


class ProductCatalog:
    def __init__(self, store):
        self.store = store
        with store.lock, store.db:
            store.db.executescript("""
            CREATE TABLE IF NOT EXISTS product_learning_tasks(shop_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS product_learning_stage(request_id TEXT,product_key TEXT,payload TEXT NOT NULL,
              PRIMARY KEY(request_id,product_key));
            CREATE TABLE IF NOT EXISTS product_catalog(shop_id TEXT,product_key TEXT,payload TEXT NOT NULL,
              observed_at REAL NOT NULL,PRIMARY KEY(shop_id,product_key));
            """)

    def _task(self, shop):
        row = self.store.db.execute("SELECT payload FROM product_learning_tasks WHERE shop_id=?", (shop,)).fetchone()
        return json.loads(row[0]) if row else None

    def _save(self, shop, task):
        self.store.db.execute("INSERT OR REPLACE INTO product_learning_tasks VALUES (?,?)", (shop, json.dumps(task)))

    def status(self, shop):
        with self.store.lock, self.store.db:
            self.store._settings(shop)
            task = self._task(shop)
            if task and task["status"] in ("queued", "collecting", "learning") and task["expires_at"] <= time.time():
                task.update(status="failed", error="product_collection_timeout", updated_at=time.time())
                self._save(shop, task)
            keys = ("request_id", "status", "processed", "total", "details_incomplete", "error", "updated_at", "catalog_complete")
            value = {k: task[k] for k in keys if k in task} if task else {"status": "idle", "processed": 0}
            value["catalog_count"] = self.store.db.execute("SELECT count(*) FROM product_catalog WHERE shop_id=?", (shop,)).fetchone()[0]
            lease = self.store._lease(shop)
            value["client_ready"] = bool(lease and lease["expires_at"] > time.time() and CAPABILITY in lease.get("capabilities", []))
            docs = [json.loads(r[0]) for r in self.store.db.execute("SELECT payload FROM product_catalog WHERE shop_id=? ORDER BY observed_at DESC,product_key LIMIT 20", (shop,))]
            value["products"] = [{"title": d["title"], "category": d["category"], "details_complete": d["details_complete"],
                                  "facts": d["facts"]} for d in docs]
            return value

    def request(self, shop, raw_url):
        selected = selection(raw_url)
        with self.store.lock, self.store.db:
            self.store._settings(shop)
            old = self._task(shop)
            if old:
                self.store.db.execute("DELETE FROM product_learning_stage WHERE request_id=?", (old["request_id"],))
            now = time.time()
            self._save(shop, {"request_id": uuid.uuid4().hex, "status": "queued", "processed": 0,
                              "total": None, "details_incomplete": 0, "updated_at": now,
                              "expires_at": now + 1800, "next_seq": 0, "selection": selected})
            return self.status(shop)

    def pending(self, identity, lease):
        with self.store.lock, self.store.db:
            task = self._task(identity["shop_id"])
            if not task or task["status"] not in ("queued", "collecting") or CAPABILITY not in lease["capabilities"]:
                return None
            owner = {k: lease[k] for k in ("client_id", "instance_id", "session_id", "generation")}
            if task["expires_at"] <= time.time() or (task.get("owner") and task["owner"] != owner):
                task.update(status="failed", error="product_source_changed", updated_at=time.time())
                self._save(identity["shop_id"], task)
                return None
            task.update(status="collecting", owner=owner)
            self._save(identity["shop_id"], task)
            return {k: task[k] for k in ("request_id", "selection", "expires_at")}

    def _owned(self, identity, request_id, payload):
        lease = self.store._check_lease(identity, payload)
        task = self._task(identity["shop_id"])
        require(task is not None and task["request_id"] == request_id, "product_request_changed", 409)
        require(CAPABILITY in lease.get("capabilities", []), "capability_not_confirmed", 409)
        require(task.get("owner") == {k: lease[k] for k in ("client_id", "instance_id", "session_id", "generation")}, "product_source_changed", 409)
        require(task["expires_at"] > time.time(), "product_request_expired", 409)
        return task

    def begin(self, identity, request_id, payload):
        require(set(payload) == {"instance_id", "session_id", "generation", "seq", "products", "total", "finished", "catalog_complete", "error"}, "invalid_product_batch")
        require(type(payload["seq"]) is int and payload["seq"] >= 0 and type(payload["finished"]) is bool
                and type(payload["catalog_complete"]) is bool, "invalid_product_batch")
        require(payload["total"] is None or type(payload["total"]) is int and 0 <= payload["total"] <= 1000000, "invalid_product_batch")
        require(payload["error"] is None or isinstance(payload["error"], str) and payload["error"] in FAILURES, "invalid_product_batch")
        try:
            products = validate_products(payload["products"])
        except ValueError:
            require(False, "invalid_products")
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with self.store.lock, self.store.db:
            task = self._owned(identity, request_id, payload)
            if payload["error"]:
                if task["status"] in ("collecting", "learning"):
                    task.update(status="failed", error=payload["error"], updated_at=time.time())
                    self._save(identity["shop_id"], task)
                return None
            if payload["seq"] == task["next_seq"] - 1 and task.get("last_digest") == digest:
                return None
            require(task["status"] == "collecting" and payload["seq"] == task["next_seq"], "product_batch_changed", 409)
            existing = {r[0] for r in self.store.db.execute("SELECT product_key FROM product_learning_stage WHERE request_id=?", (request_id,))}
            require(not existing.intersection(p["product_key"] for p in products), "duplicate_product", 409)
            task.update(status="learning", pending_digest=digest, updated_at=time.time())
            self._save(identity["shop_id"], task)
            return products

    def finish(self, identity, request_id, payload, learned, error=None):
        with self.store.lock, self.store.db:
            task = self._owned(identity, request_id, payload)
            require(task["status"] == "learning" and task["next_seq"] == payload["seq"], "product_batch_changed", 409)
            if error or payload["error"]:
                task.update(status="failed", error=error or payload["error"], updated_at=time.time())
                self._save(identity["shop_id"], task)
                return self.status(identity["shop_id"])
            for item in learned:
                self.store.db.execute("INSERT INTO product_learning_stage VALUES (?,?,?)",
                                      (request_id, item["product_key"], json.dumps(item, ensure_ascii=False)))
            task.update(processed=task["processed"] + len(learned), total=payload["total"],
                        details_incomplete=task["details_incomplete"] + sum(not p["details_complete"] for p in learned),
                        status="collecting", next_seq=payload["seq"] + 1,
                        last_digest=task.pop("pending_digest"), updated_at=time.time())
            if payload["finished"]:
                require(payload["total"] is None or task["processed"] <= payload["total"], "invalid_product_total")
                complete = payload["catalog_complete"] and payload["total"] == task["processed"]
                rows = self.store.db.execute("SELECT product_key,payload FROM product_learning_stage WHERE request_id=?", (request_id,)).fetchall()
                now = time.time()
                for row in rows:
                    self.store.db.execute("INSERT OR REPLACE INTO product_catalog VALUES (?,?,?,?)", (identity["shop_id"], row[0], row[1], now))
                if rows:
                    settings = self.store._settings(identity["shop_id"])
                    settings["version"] += 1
                    self.store.db.execute("UPDATE shops SET settings=? WHERE shop_id=?", (json.dumps(settings), identity["shop_id"]))
                task.update(status="completed" if complete and not task["details_incomplete"] else "partial", catalog_complete=complete)
                self.store.db.execute("DELETE FROM product_learning_stage WHERE request_id=?", (request_id,))
            self._save(identity["shop_id"], task)
            return self.status(identity["shop_id"])

    def knowledge(self, shop, goods):
        keys = list({g.get("product_key") for g in goods if isinstance(g.get("product_key"), str)})
        if not keys:
            return []
        with self.store.lock:
            rows = self.store.db.execute("SELECT payload FROM product_catalog WHERE shop_id=? AND product_key IN (" + ",".join("?" for _ in keys) + ")", [shop, *keys]).fetchall()
            return choose_knowledge(goods, [json.loads(r[0]) for r in rows])
