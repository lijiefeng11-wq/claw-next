"""Pure helpers for shop-scoped product knowledge (stdlib only).

No I/O, no store/engine access. Product keys are opaque client-generated
64-char lowercase hex hashes; matching is by exact key only.
"""

import unicodedata

MAX_PRODUCTS = 30
MAX_FACTS = 80
MAX_FACT_LEN = 1000
MAX_TITLE_LEN = 200
MAX_MATCHED = 10
MAX_INDICES = 20
CATEGORIES = (
    "汽车用品", "家居日用", "数码电器", "服饰鞋包", "食品饮品", "美妆个护", "其他",
)
_PRODUCT_KEYS = frozenset({"product_key", "title", "facts", "details_complete"})
_OUTPUT_KEYS = frozenset({"product_key", "category", "indices"})
_HEX = frozenset("0123456789abcdef")


def _is_hex_key(value):
    if not isinstance(value, str) or len(value) != 64:
        return False
    return all(ch in _HEX for ch in value)


def _has_unsafe_controls(text):
    for ch in text:
        if ch in "\t\n\r":
            continue
        if unicodedata.category(ch) == "Cc":
            return True
    return False


def _clean_text(value, limit):
    """Return trimmed text or raise ValueError on bad/oversized input."""
    if not isinstance(value, str):
        raise ValueError("not text")
    text = value.strip()
    if not text or len(text) > limit or _has_unsafe_controls(text):
        raise ValueError("bad text")
    return text


def validate_products(raw):
    """Validate one upload batch; raise ValueError('invalid_products') if bad."""
    try:
        if not isinstance(raw, list) or len(raw) > MAX_PRODUCTS:
            raise ValueError("not a list")
        seen = set()
        out = []
        for rec in raw:
            if not isinstance(rec, dict) or set(rec.keys()) != _PRODUCT_KEYS:
                raise ValueError("bad record")
            key = rec["product_key"]
            if not _is_hex_key(key) or key in seen:
                raise ValueError("bad key")
            seen.add(key)
            title = _clean_text(rec["title"], MAX_TITLE_LEN)
            facts = rec["facts"]
            if not isinstance(facts, list) or len(facts) > MAX_FACTS:
                raise ValueError("bad facts")
            clean_facts = [_clean_text(f, MAX_FACT_LEN) for f in facts]
            if type(rec["details_complete"]) is not bool:
                raise ValueError("bad bool")
            out.append({
                "product_key": key,
                "title": title,
                "facts": clean_facts,
                "details_complete": rec["details_complete"],
            })
        return out
    except (TypeError, ValueError, KeyError):
        raise ValueError("invalid_products")


def choose_knowledge(goods, records):
    """Match shop catalog docs to goods by exact product_key only."""
    if not isinstance(goods, list) or not isinstance(records, (list, tuple)):
        raise ValueError("invalid_products")
    wanted = set()
    for item in goods:
        if isinstance(item, dict):
            key = item.get("product_key")
            if _is_hex_key(key):
                wanted.add(key)
    # Catalog prefilter: only this shop's docs with a wanted key can match.
    by_key = {}
    ambiguous = set()
    for doc in records:
        if not isinstance(doc, dict) or not isinstance(doc.get("facts"), list):
            continue
        key = doc.get("product_key")
        if key not in wanted or not _is_hex_key(key):
            continue
        if key in by_key:
            ambiguous.add(key)
        by_key[key] = doc
    out = []
    budget = 16000
    seen = set()
    for item in goods:
        key = item.get("product_key") if isinstance(item, dict) else None
        if key not in wanted or key in seen:
            continue
        seen.add(key)
        if key in ambiguous:
            continue
        doc = by_key.get(key)
        if doc is None or doc["product_key"] != key:
            continue
        title = doc.get("title")
        category = doc.get("category")
        selected = doc.get("selected_indices")
        facts = [f for f in doc["facts"] if isinstance(f, str)]
        order = [i for i in (selected or []) if type(i) is int and 0 <= i < len(facts)]
        order += [i for i in range(len(facts)) if i not in order]
        kept = []
        partial = False
        for i in order:
            if len(facts[i]) > budget:
                partial = True
                continue
            kept.append(facts[i])
            budget -= len(facts[i])
        out.append({
            "goods_ref": item.get("goods_ref", key),
            "title": title if isinstance(title, str) else "",
            "category": category if isinstance(category, str) else "",
            "facts": kept,
            "details_complete": doc.get("details_complete") is True and not partial,
        })
        if len(out) >= MAX_MATCHED:
            break
    return out


def categorize_output(raw, products):
    """Validate model categorization output against indexed products."""
    facts_by_key = {}
    for prod in products:
        facts_by_key[prod["product_key"]] = prod["facts"]
    if not isinstance(raw, list) or len(raw) != len(facts_by_key):
        raise ValueError("invalid_category_output")
    result = []
    seen = set()
    for entry in raw:
        if not isinstance(entry, dict) or set(entry.keys()) != _OUTPUT_KEYS:
            raise ValueError("invalid_category_output")
        key = entry["product_key"]
        if key not in facts_by_key or key in seen:
            raise ValueError("invalid_category_output")
        seen.add(key)
        category = entry["category"]
        if not isinstance(category, str) or category not in CATEGORIES:
            raise ValueError("invalid_category_output")
        indices = entry["indices"]
        if not isinstance(indices, list) or len(indices) > MAX_INDICES:
            raise ValueError("invalid_category_output")
        check = set()
        for idx in indices:
            if type(idx) is not int or not 0 <= idx < len(facts_by_key[key]):
                raise ValueError("invalid_category_output")
            if idx in check:
                raise ValueError("invalid_category_output")
            check.add(idx)
        result.append({
            "product_key": key,
            "category": category,
            "selected_indices": list(indices),
            "facts": list(facts_by_key[key]),
        })
    if len(seen) != len(facts_by_key):
        raise ValueError("invalid_category_output")
    return result
