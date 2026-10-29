"""Read-only goods snapshot: which goods were read, from where and when; data only.

``goods_ref`` is a frontend-local opaque reference (platform goods IDs never
upload) and is never rederived here. Titles, SKUs and card prices are data,
never instructions.
"""
import re

from .orders import bounded_text, unix_seconds

CAPABILITY = "goods_snapshot"
MAX_GOODS = 10
MAX_EVIDENCE = 5
MAX_REF = 64
GOODS_KEYS = frozenset({"goods_ref", "title", "evidence"})
# Every evidence field and the only source allowed to carry it.
EVIDENCE_FIELDS = {"source": None, "observed_at": None, "order_ref": "order",
                   "message_id": "goods_card", "card_price": "goods_card"}
URL = re.compile(r"https?://|www\.", re.IGNORECASE)


def validate_items(order, require):
    """Validate an order's optional ``items`` lines (references checked later)."""
    if "items" not in order:
        return
    items = order["items"]
    require(isinstance(items, list) and 1 <= len(items) <= MAX_EVIDENCE, "invalid_order_items")
    for item in items:
        require(isinstance(item, dict) and "goods_title" in item
                and set(item) <= {"goods_ref", "goods_title", "sku", "quantity"}, "invalid_order_item")
        title = item["goods_title"]
        require(bounded_text(title, 200), "invalid_order_item")
        require("goods_ref" not in item or (isinstance(item["goods_ref"], str)
                                            and 0 < len(item["goods_ref"]) <= MAX_REF), "invalid_order_item")
        require("sku" not in item or bounded_text(item["sku"], 200), "invalid_order_item")
        require("quantity" not in item or (type(item["quantity"]) is int and item["quantity"] > 0),
                "invalid_order_item")


def _validate_evidence(evidence, require):
    """Per-source field whitelist and types; cross-references come later."""
    require(isinstance(evidence, dict) and {"source", "observed_at"} <= set(evidence),
            "invalid_goods_evidence")
    source = evidence["source"]
    allowed = {k for k, owner in EVIDENCE_FIELDS.items() if owner in (None, source)}
    require(source in ("order", "goods_card") and set(evidence) <= allowed, "invalid_goods_evidence")
    require(unix_seconds(evidence["observed_at"]), "invalid_goods_evidence")
    if source == "order":
        require(isinstance(evidence.get("order_ref"), str) and 0 < len(evidence["order_ref"]) <= 200,
                "invalid_goods_evidence")
        return
    require(isinstance(evidence.get("message_id"), str) and 0 < len(evidence["message_id"]) <= 128,
            "invalid_goods_evidence")
    if "card_price" in evidence:
        price = evidence["card_price"]
        require(bounded_text(price, 200), "invalid_goods_evidence")


def validate_goods(context, require):
    """Validate optional ``context.goods`` without mutating it; references later."""
    if "goods" not in context:
        return
    goods = context["goods"]
    require(isinstance(goods, list) and len(goods) <= MAX_GOODS, "invalid_goods")
    refs, newest = set(), None
    for entry in goods:
        require(isinstance(entry, dict) and set(entry) == GOODS_KEYS, "invalid_goods")
        ref, title = entry["goods_ref"], entry["title"]
        require(isinstance(ref, str) and 0 < len(ref) <= MAX_REF and ref not in refs, "invalid_goods_ref")
        require(isinstance(title, str) and 0 < len(title.strip()) and len(title) <= 200
                and not URL.search(title), "invalid_goods_title")
        evidence = entry["evidence"]
        require(isinstance(evidence, list) and 1 <= len(evidence) <= MAX_EVIDENCE, "invalid_goods_evidence")
        for item in evidence:
            _validate_evidence(item, require)
        refs.add(ref)
        # Entries are ordered by their newest evidence reading.
        latest = evidence[0]["observed_at"]
        require(newest is None or latest <= newest, "goods_not_descending")
        newest = latest


def _good_card(messages, evidence, title):
    message = next((m for m in messages if m["id"] == evidence["message_id"]), None)
    if message is None or message["created_at"] != evidence["observed_at"]:
        return False
    card = message.get("card") or {}
    return message["kind"] == "card" and card.get("type") == "goods" and card.get("title") == title


def validate_references(context, require):
    """Cross-check the snapshot against orders and messages of the same context.

    The legacy order summary fields (``goods_title``/``sku``/``quantity``) are
    deliberately never compared with ``items``: both are independent.
    """
    orders, messages = context.get("orders", []), context.get("messages", [])
    by_ref = {order["order_ref"]: order for order in orders}
    lines = {ref: order.get("items", []) for ref, order in by_ref.items()}
    entries = {entry["goods_ref"]: entry for entry in context.get("goods", [])}
    for order in orders:
        for item in order.get("items", []):
            require("goods_ref" not in item or item["goods_ref"] in entries, "invalid_order_item_ref")
    for entry in entries.values():
        evidence = entry["evidence"]
        # Descending reads, and each order or message cited at most once.
        times = [item["observed_at"] for item in evidence]
        require(times == sorted(times, reverse=True), "goods_evidence_not_descending")
        keys = set()
        for item in evidence:
            if item["source"] == "order":
                order = by_ref.get(item["order_ref"])
                require(order is not None and item["observed_at"] == order.get("observed_at"),
                        "invalid_goods_evidence")
                require(any(
                    line.get("goods_ref") == entry["goods_ref"] for line in lines[item["order_ref"]]),
                    "invalid_goods_evidence")
            else:
                require(_good_card(messages, item, entry["title"]), "invalid_goods_evidence")
            key = (item["source"], item.get("order_ref") or item.get("message_id"))
            require(key not in keys, "duplicate_goods_evidence")
            keys.add(key)
