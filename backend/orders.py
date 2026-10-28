"""Read-only order/logistics summaries supplied with a context; data only, never actions."""
import math

MAX_ORDERS = 10
MAX_TRACES = 5
MAX_TEXT = 200
MAX_NOTE = 500

ORDER_KEYS = frozenset({"order_ref", "observed_at", "status", "goods_title", "sku", "amount",
                        "after_sale", "note", "quantity", "order_time", "shipping_time",
                        "receive_time", "logistics"})
LOGISTICS_KEYS = frozenset({"company", "tracking_number", "state", "traces", "observed_at"})
ORDER_TEXT_KEYS = ("status", "goods_title", "sku", "amount", "after_sale")
OPTIONAL_TIMES = ("order_time", "shipping_time", "receive_time")


def unix_seconds(value):
    """A JSON number timestamp; booleans and non-finite floats are invalid."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return not isinstance(value, float) or math.isfinite(value)


def bounded_text(value, maximum):
    return isinstance(value, str) and len(value) <= maximum


def validate_order(order, require):
    require(isinstance(order, dict) and set(order) <= ORDER_KEYS, "invalid_order")
    ref = order.get("order_ref")
    require(isinstance(ref, str) and 0 < len(ref) <= MAX_TEXT, "invalid_order_ref")
    require(unix_seconds(order.get("observed_at")), "invalid_order_observed_at")
    for name in ORDER_TEXT_KEYS:
        require(name not in order or bounded_text(order[name], MAX_TEXT), "invalid_order_" + name)
    require("note" not in order or bounded_text(order["note"], MAX_NOTE), "invalid_order_note")
    require("quantity" not in order or (type(order["quantity"]) is int and order["quantity"] > 0),
            "invalid_order_quantity")
    # Unknown order times may be absent or null; a supplied value must be a number.
    for name in OPTIONAL_TIMES:
        require(name not in order or order[name] is None or unix_seconds(order[name]), "invalid_order_" + name)
    if "logistics" in order:
        validate_logistics(order["logistics"], require)


def validate_logistics(logistics, require):
    require(isinstance(logistics, dict) and set(logistics) <= LOGISTICS_KEYS, "invalid_logistics")
    for name in ("company", "tracking_number", "state"):
        require(name not in logistics or bounded_text(logistics[name], MAX_TEXT), "invalid_logistics_" + name)
    # Logistics is read separately, so its own read time is mandatory.
    require(unix_seconds(logistics.get("observed_at")), "invalid_logistics_observed_at")
    traces = logistics.get("traces", [])
    require(isinstance(traces, list) and len(traces) <= MAX_TRACES, "invalid_traces")
    previous = None
    for trace in traces:
        require(isinstance(trace, dict) and set(trace) == {"time", "info"}, "invalid_trace")
        require(unix_seconds(trace["time"]), "invalid_trace_time")
        require(bounded_text(trace["info"], MAX_TEXT), "invalid_trace_info")
        require(previous is None or trace["time"] <= previous, "traces_not_descending")
        previous = trace["time"]


def validate_orders(context, require):
    """Validate optional order summaries without mutating the payload."""
    require(isinstance(context, dict), "invalid_context")
    orders = context.get("orders", [])
    require(isinstance(orders, list), "invalid_orders")
    require(len(orders) <= MAX_ORDERS, "too_many_orders")
    refs, previous_time = set(), None
    for order in orders:
        validate_order(order, require)
        require(order["order_ref"] not in refs, "duplicate_order_ref")
        refs.add(order["order_ref"])
        order_time = order.get("order_time")
        if order_time is not None:
            require(previous_time is None or order_time <= previous_time, "orders_not_descending")
            previous_time = order_time
