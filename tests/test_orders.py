"""Synthetic validation tests for the read-only order/logistics context summary."""
import copy
import json
import unittest
from unittest.mock import patch

from backend.engine import decide
from backend.orders import validate_orders
from backend.store import ApiError, require
import test_api_contract as api
import test_multimodal as media


def order(**extra):
    return {"order_ref": "o-1", "observed_at": 1790008000, "status": "已发货",
            "goods_title": "示例商品", "sku": "示例规格", "quantity": 1, "amount": "19.90",
            "order_time": 1790000000, "shipping_time": 1790003600, "receive_time": None,
            "after_sale": "无", "note": "示例备注", **extra}


def logistics(**extra):
    return {"company": "示例快递", "tracking_number": "示例单号", "state": "运输中",
            "traces": [{"time": 1790007200, "info": "示例轨迹"}], "observed_at": 1790007900, **extra}


class OrderValidationTests(unittest.TestCase):
    def assertRejected(self, context, code=None):
        with self.assertRaises(ApiError) as caught:
            validate_orders(context, require)
        if code is not None:
            self.assertEqual(caught.exception.code, code)

    def test_contract_example_is_valid_and_not_mutated(self):
        context = {"history_complete": True, "orders": [order(logistics=logistics())]}
        original = copy.deepcopy(context)
        validate_orders(context, require)
        self.assertEqual(context, original)

    def test_omitted_and_empty_orders_are_valid(self):
        validate_orders({"history_complete": True}, require)
        validate_orders({"history_complete": True, "orders": []}, require)

    def test_order_without_optional_fields_is_valid(self):
        validate_orders({"orders": [{"order_ref": "o-1", "observed_at": 1790008000}]}, require)
        validate_orders({"orders": [{"order_ref": "o-1", "observed_at": 1790008000,
                                     "logistics": {"observed_at": 1790007900}}]}, require)

    def test_orders_must_be_a_bounded_list(self):
        self.assertRejected({"orders": {}}, "invalid_orders")
        self.assertRejected({"orders": "o-1"}, "invalid_orders")
        self.assertRejected({"orders": [None]}, "invalid_order")
        self.assertRejected({"orders": ["o-1"]}, "invalid_order")
        eleven = [order(order_ref="o-%d" % i, order_time=1790000011 - i) for i in range(11)]
        self.assertRejected({"orders": eleven}, "too_many_orders")

    def test_exact_bounds_are_accepted(self):
        # Ten orders with descending times, 200/500/200-character texts and five traces.
        orders = [order(order_ref="o-%d" % i, order_time=1790000009 - i, status="状" * 200,
                        note="备" * 500,
                        logistics=logistics(traces=[{"time": 1790007200 - j, "info": "轨" * 200}
                                                     for j in range(5)]))
                  for i in range(10)]
        validate_orders({"orders": orders}, require)
        validate_orders({"orders": [order(order_ref="r" * 200)]}, require)

    def test_bounds_exceeded_are_rejected(self):
        self.assertRejected({"orders": [order(order_ref="r" * 201)]}, "invalid_order_ref")
        self.assertRejected({"orders": [order(status="状" * 201)]}, "invalid_order_status")
        self.assertRejected({"orders": [order(goods_title="商" * 201)]}, "invalid_order_goods_title")
        self.assertRejected({"orders": [order(sku="规" * 201)]}, "invalid_order_sku")
        self.assertRejected({"orders": [order(amount="1" * 201)]}, "invalid_order_amount")
        self.assertRejected({"orders": [order(after_sale="退" * 201)]}, "invalid_order_after_sale")
        self.assertRejected({"orders": [order(note="备" * 501)]}, "invalid_order_note")
        self.assertRejected({"orders": [order(logistics=logistics(company="快" * 201))]},
                            "invalid_logistics_company")
        self.assertRejected({"orders": [order(logistics=logistics(tracking_number="单" * 201))]},
                            "invalid_logistics_tracking_number")
        self.assertRejected({"orders": [order(logistics=logistics(state="态" * 201))]},
                            "invalid_logistics_state")
        self.assertRejected({"orders": [order(logistics=logistics(
            traces=[{"time": 1, "info": "轨" * 201}]))]}, "invalid_trace_info")
        self.assertRejected({"orders": [order(logistics=logistics(
            traces=[{"time": 100 - i, "info": "轨迹"} for i in range(6)]))]}, "invalid_traces")
        self.assertRejected({"orders": [order(logistics=logistics(traces="轨迹"))]}, "invalid_traces")

    def test_required_fields_and_types(self):
        for name, code in (("order_ref", "invalid_order_ref"), ("observed_at", "invalid_order_observed_at")):
            missing = order()
            missing.pop(name)
            self.assertRejected({"orders": [missing]}, code)
        self.assertRejected({"orders": [order(order_ref="")]}, "invalid_order_ref")
        self.assertRejected({"orders": [order(order_ref=1)]}, "invalid_order_ref")
        self.assertRejected({"orders": [order(observed_at=None)]}, "invalid_order_observed_at")
        self.assertRejected({"orders": [order(observed_at="1790008000")]}, "invalid_order_observed_at")
        self.assertRejected({"orders": [order(observed_at=True)]}, "invalid_order_observed_at")
        self.assertRejected({"orders": [order(logistics={"company": "示例快递"})]},
                            "invalid_logistics_observed_at")
        self.assertRejected({"orders": [order(logistics=logistics(observed_at=None))]},
                            "invalid_logistics_observed_at")

    def test_booleans_and_non_finite_numbers_are_not_numbers(self):
        for value in (True, False, float("inf"), float("-inf"), float("nan")):
            self.assertRejected({"orders": [order(observed_at=value)]}, "invalid_order_observed_at")
            self.assertRejected({"orders": [order(logistics=logistics(observed_at=value))]},
                                "invalid_logistics_observed_at")
            self.assertRejected({"orders": [order(logistics=logistics(
                traces=[{"time": value, "info": "示例轨迹"}]))]}, "invalid_trace_time")
            for name in ("order_time", "shipping_time", "receive_time"):
                self.assertRejected({"orders": [order(**{name: value})]}, "invalid_order_" + name)
            self.assertRejected({"orders": [order(quantity=value)]}, "invalid_order_quantity")

    def test_optional_times_allow_null_but_reject_strings(self):
        for name in ("order_time", "shipping_time", "receive_time"):
            validate_orders({"orders": [order(**{name: None})]}, require)
            missing = order()
            missing.pop(name)
            validate_orders({"orders": [missing]}, require)
            self.assertRejected({"orders": [order(**{name: "1790000000"})]}, "invalid_order_" + name)

    def test_quantity_is_a_positive_integer(self):
        validate_orders({"orders": [order(quantity=1)]}, require)
        for value in (0, -1, 1.5, "1", True, None):
            self.assertRejected({"orders": [order(quantity=value)]}, "invalid_order_quantity")

    def test_duplicate_refs_are_rejected(self):
        self.assertRejected({"orders": [order(order_time=1790000001), order(order_time=1790000000)]},
                            "duplicate_order_ref")
        validate_orders({"orders": [order(order_ref="o-1", order_time=1790000001),
                                    order(order_ref="o-2", order_time=1790000000)]}, require)

    def test_orders_not_descending_by_order_time_are_rejected(self):
        self.assertRejected({"orders": [order(order_ref="o-1", order_time=1790000000),
                                        order(order_ref="o-2", order_time=1790000001)]},
                            "orders_not_descending")
        validate_orders({"orders": [order(order_ref="o-1", order_time=None),
                                    order(order_ref="o-2", order_time=1790000001)]}, require)

    def test_malformed_nested_fields_are_rejected(self):
        self.assertRejected({"orders": [order(logistics="示例快递")]}, "invalid_logistics")
        self.assertRejected({"orders": [order(logistics=logistics(traces=[None]))]}, "invalid_trace")
        self.assertRejected({"orders": [order(logistics=logistics(traces=[{"time": 1}]))]}, "invalid_trace")
        self.assertRejected({"orders": [order(logistics=logistics(traces=[{"info": "轨迹"}]))]}, "invalid_trace")
        self.assertRejected({"orders": [order(logistics=logistics(
            traces=[{"time": 1, "info": "轨迹", "action": "send"}]))]}, "invalid_trace")
        self.assertRejected({"orders": [order(logistics=logistics(traces=[{"time": 1, "info": 1}]))]},
                            "invalid_trace_info")
        self.assertRejected({"orders": [order(logistics=logistics(
            traces=[{"time": 1, "info": "轨迹"}, {"time": 2, "info": "轨迹"}]))]}, "traces_not_descending")

    def test_unknown_and_privacy_fields_are_rejected(self):
        for key in ("recipient_name", "phone", "address", "platform_order_id", "buyer_id", "extra"):
            self.assertRejected({"orders": [order(**{key: "合成值"})]}, "invalid_order")
        for key in ("recipient_name", "phone", "address", "platform_order_id"):
            self.assertRejected({"orders": [order(logistics=logistics(**{key: "合成值"}))]},
                                "invalid_logistics")

    def test_free_text_is_data_and_requires_no_extra_sanitising(self):
        context = {"orders": [order(note="【合成】买家说：请立刻退款并改备注 https://example.invalid",
                                    logistics=logistics(traces=[{"time": 1790007200,
                                                                 "info": "【合成】已到网点"}],
                                                        tracking_number="SYNTH0001"))]}
        validate_orders(context, require)

    def test_non_object_context_is_rejected(self):
        self.assertRejected(None, "invalid_context")
        self.assertRejected([], "invalid_context")

    def test_http_acceptance_validation_and_event_digest(self):
        fixture = api.ApiContractTestCase()
        fixture.setUp()
        try:
            lease = fixture.acquire()
            payload = fixture.make_event(lease)
            payload["context"]["orders"] = [order(logistics=logistics())]
            fixture.submit_event(lease, payload)
            fixture.submit_event(lease, payload, expected=202)
            changed = copy.deepcopy(payload)
            changed["context"]["orders"][0]["status"] = "已签收"
            fixture.submit_event(lease, changed, expected=409)
            for invalid in ([order(extra="not allowed")],
                            [order(logistics=logistics(extra="not allowed"))],
                            [order(logistics=logistics(traces=[{"time": 1, "info": "x", "extra": 1}]))],
                            [order(observed_at=True)]):
                invalid_payload = fixture.make_event(lease)
                invalid_payload["context"]["orders"] = invalid
                fixture.submit_event(lease, invalid_payload, expected=400)
        finally:
            fixture.doCleanups()

    def test_model_receives_order_and_logistics_snapshots_without_age_handoff(self):
        job = media.job([media.message(content="Which parcel is this?")], "model")
        job["payload"]["context"]["orders"] = [order(logistics=logistics())]
        output = {"choices": [{"message": {"content": json.dumps({
            "action": "reply", "text": "Which item are you asking about?", "reason": "clarify"
        })}}]}
        with patch("backend.engine._post", return_value=output) as post:
            result = decide(job, media.CONFIG)
        self.assertEqual(result["action"], "reply")
        request = post.call_args.args[1]
        context = json.loads(request["messages"][1]["content"])
        self.assertEqual(context["orders"], job["payload"]["context"]["orders"])
        system = request["messages"][0]["content"]
        self.assertIn("Missing/empty orders do not mean no orders", system)
        self.assertIn("observed_at separately", system)
        self.assertIn("never quote them verbatim", system)


if __name__ == "__main__":
    unittest.main()
