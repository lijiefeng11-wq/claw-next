"""Validated, event-scoped candidates for frontend-owned platform sends."""
import math

CAPABILITY = "send_item"
KINDS = {"instruction": "instructions", "goods_card": "goods", "video": "videos"}
LIMITS = {"instructions": 10, "goods": 20, "videos": 50}


def validate_options(context, require):
    if "send_options" not in context:
        return
    options = context["send_options"]
    require(isinstance(options, dict) and set(options) <= set(LIMITS), "invalid_send_options")
    seen = set()
    for kind, values in options.items():
        require(isinstance(values, list) and len(values) <= LIMITS[kind], "invalid_send_options")
        required = {"option_id", "observed_at"}
        required |= {"name"} if kind == "videos" else {"goods_title"}
        if kind == "instructions":
            required.add("name")
        allowed = required | ({"duration"} if kind == "videos" else set())
        for item in values:
            require(isinstance(item, dict) and required <= set(item) <= allowed, "invalid_send_option")
            for key in required - {"observed_at"}:
                value = item[key]
                require(isinstance(value, str) and bool(value.strip()) and len(value) <= (64 if key == "option_id" else 200), "invalid_send_option")
            require(item["option_id"] not in seen, "duplicate_option_id")
            seen.add(item["option_id"])
            observed = item["observed_at"]
            require(type(observed) in (int, float) and (type(observed) is int or math.isfinite(observed)), "invalid_send_option")
            if "duration" in item:
                require(type(item["duration"]) is int and item["duration"] > 0, "invalid_send_option")


def validate_target(value, require):
    require(isinstance(value, dict) and set(value) <= {"type", "match"}, "invalid_rule_send")
    require(isinstance(value.get("type"), str) and value["type"] in KINDS, "invalid_rule_send")
    if "match" in value:
        require(isinstance(value["match"], str) and 1 <= len(value["match"].strip()) <= 50, "invalid_rule_send")
    return {"type": value["type"], **({"match": value["match"].strip()} if "match" in value else {})}


def valid_item(item, context):
    if not isinstance(item, dict) or set(item) != {"type", "option_id"}:
        return False
    kind = item.get("type")
    if not isinstance(kind, str) or kind not in KINDS or not isinstance(item.get("option_id"), str):
        return False
    return any(option["option_id"] == item["option_id"] for option in context.get("send_options", {}).get(KINDS[kind], []))


def rule_item(rule, context):
    target = rule.get("send")
    if not target:
        return None
    candidates = context.get("send_options", {}).get(KINDS[target["type"]], [])
    match = target.get("match", "").casefold()
    candidates = [item for item in candidates if not match or any(match in item.get(key, "").casefold() for key in ("name", "goods_title"))]
    if len(candidates) == 1:
        return {"type": target["type"], "option_id": candidates[0]["option_id"]}
    return None
