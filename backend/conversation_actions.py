"""Conversation actions negotiated with explicitly enabled compatible clients."""
from .orders import unix_seconds

TRANSFER_CAPABILITY = "transfer_by_account"
ACTION_CAPABILITIES = {"mark": "mark_conversation", "transfer": TRANSFER_CAPABILITY}
CAPABILITIES = tuple(ACTION_CAPABILITIES.values())
# Older clients and missing explicit saved policies remain inert.
READY_CAPABILITIES = CAPABILITIES
COLORS = ("red", "orange", "blue", "green")
REASONS = ("blocked_by_mark", "platform_rejected", "conv_state_unavailable", "conv_state_changed",
           "capability_withdrawn", "deadline_exceeded", "not_started")


def _text(value, limit):
    return isinstance(value, str) and 0 < len(value.strip()) <= limit


def validate_policy(value, require):
    require(isinstance(value, dict), "invalid_policy")
    action = value.get("action")
    require(action in ("none", "handoff", "mark", "transfer"), "invalid_policy")
    if action in ("none", "handoff"):
        require(set(value) == {"action"}, "invalid_policy")
        return {"action": action}
    if action == "mark":
        require(set(value) == {"action", "color"} and value["color"] in COLORS, "invalid_policy")
        return dict(value)
    require({"action", "account"} <= set(value) <= {"action", "account", "allow_unmark"}
            and _text(value.get("account"), 40) and type(value.get("allow_unmark", False)) is bool,
            "invalid_policy")
    return {"action": action, "account": value["account"].strip(), "allow_unmark": value.get("allow_unmark", False)}


def validate_fallback(value, require):
    require(isinstance(value, dict) and set(value) <= {"unhandled", "error", "model_timeout"}, "invalid_fallback")
    return {key: validate_policy(policy, require) for key, policy in value.items()}


def validate_context(context, require):
    if "conv_state" in context:
        state = context["conv_state"]
        require(isinstance(state, dict) and set(state) == {"marked", "color", "observed_at"}, "invalid_conv_state")
        require(state["marked"] is None or type(state["marked"]) is bool, "invalid_conv_state")
        require(state["color"] is None or state["marked"] is True and state["color"] in COLORS, "invalid_conv_state")
        require(unix_seconds(state["observed_at"]), "invalid_conv_state")


def resolve(policy, context, capabilities, version, reason):
    action = policy["action"]
    legacy = {"action": action if action in ("none", "handoff") else "handoff", "text": "", "reason": reason}
    if action in ("none", "handoff"):
        return legacy
    if ACTION_CAPABILITIES[action] not in capabilities:
        return legacy
    if action == "mark":
        state = context.get("conv_state") or {}
        if type(state.get("marked")) is not bool:
            return legacy
        if state["marked"] is True:
            return {**legacy, "action": "none"}
        target = {"mark": {"color": policy["color"]}}
    else:
        target = {"transfer": {"account": policy["account"],
                               "unmark_policy": {"allow": policy.get("allow_unmark", False), "version": version}}}
    return {"action": action, **target, "policy_version": version, "reason": reason}


def valid_decision(result, context, capabilities, version):
    action = result.get("action")
    if action not in ("mark", "transfer") or ACTION_CAPABILITIES[action] not in capabilities:
        return False
    if type(result.get("policy_version")) is not int or result["policy_version"] != version:
        return False
    if (set(result) != {"action", action, "policy_version", "reason", "expires_at"}
            or not _text(result.get("reason"), 600) or not unix_seconds(result.get("expires_at"))):
        return False
    target = result[action]
    if action == "mark":
        return (isinstance(target, dict) and set(target) == {"color"} and target["color"] in COLORS
                and (context.get("conv_state") or {}).get("marked") is False)
    if not isinstance(target, dict) or set(target) != {"account", "unmark_policy"}:
        return False
    policy = target["unmark_policy"]
    return (_text(target["account"], 40) and target["account"] == target["account"].strip()
            and isinstance(policy, dict) and set(policy) == {"allow", "version"}
            and type(policy["allow"]) is bool and type(policy["version"]) is int and policy["version"] == version)


def receipt(action, expected, payload, require):
    require(set(payload) <= {"attempt_id", "status", "steps", "page_observed", "reason", "platform_message_id"}, "invalid_receipt")
    require(payload.get("platform_message_id") is None, "invalid_platform_message_id")
    status = payload.get("status")
    require(status in ("sent", "not_sent", "unknown"), "invalid_receipt_status")
    if "reason" in payload:
        require(payload["reason"] in REASONS, "invalid_receipt_reason")
    if "page_observed" in payload:
        require(payload["page_observed"] in ("marked", "left_list", "unchanged", "unknown"), "invalid_page_observed")
    steps = payload.get("steps", [])
    require(isinstance(steps, list) and len(steps) <= (1 if action == "mark" else 2), "invalid_receipt_steps")
    for step in steps:
        require(isinstance(step, dict) and step.get("status") in ("sent", "not_sent", "unknown"), "invalid_receipt_steps")
        if "reason" in step:
            require(step["reason"] in REASONS, "invalid_receipt_reason")
    if not steps:
        require(status == "not_sent", "invalid_receipt_steps")
        aggregate = "not_sent"
    elif action == "mark":
        step = steps[0]
        require({"step", "status", "color"} <= set(step) <= {"step", "status", "color", "reason"}
                and step["step"] == "mark" and step["color"] == expected["mark"]["color"], "invalid_receipt_steps")
        aggregate = step["status"]
    else:
        first = steps[0]
        require({"step", "status"} <= set(first) <= {"step", "status", "reason"} and first["step"] == "transfer", "invalid_receipt_steps")
        aggregate = first["status"]
        if len(steps) == 2:
            require(first["status"] == "not_sent" and first.get("reason") == "blocked_by_mark"
                    and expected["transfer"]["unmark_policy"]["allow"], "invalid_receipt_steps")
            last = steps[1]
            require({"step", "status", "unmarked"} <= set(last) <= {"step", "status", "unmarked", "reason"}
                    and last["step"] == "unmark_and_transfer" and (last["unmarked"] is None or type(last["unmarked"]) is bool), "invalid_receipt_steps")
            aggregate = last["status"]
            if last["unmarked"] is None or aggregate == "sent" and last["unmarked"] is not True:
                aggregate = "unknown"
    require(status == aggregate, "receipt_status_mismatch")
    clean = {"status": status, "steps": steps}
    for key in ("page_observed", "reason"):
        if key in payload:
            clean[key] = payload[key]
    return clean
