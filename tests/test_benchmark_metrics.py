"""benchmark_metrics 的单元测试：全部使用虚构 call，无网络、无真实模型。

运行： python -m unittest discover -s tests -p "test_benchmark_metrics.py" -v
"""

from __future__ import annotations

import importlib.util
import json
import sys
import threading
import time
import unittest
from pathlib import Path

_MODULE_PATH = Path(__file__).resolve().parents[1] / "backend" / "benchmark_metrics.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("benchmark_metrics", _MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("benchmark_metrics", module)
    spec.loader.exec_module(module)
    return module


metrics = _load_module()

TOP_LEVEL_KEYS = {
    "count",
    "success_count",
    "error_count",
    "elapsed_ms",
    "success_per_minute",
    "latency_all_ms",
    "latency_success_ms",
    "errors",
    "by_kind",
    "tokens",
}


class ConcurrencyTests(unittest.TestCase):
    def test_peak_concurrency_is_bounded(self):
        lock = threading.Lock()
        state = {"active": 0, "peak": 0}

        def call(index):
            with lock:
                state["active"] += 1
                state["peak"] = max(state["peak"], state["active"])
            time.sleep(0.01)
            with lock:
                state["active"] -= 1
            return {"ok": True, "kind": "text", "prompt_tokens": 1, "completion_tokens": 1}

        result = metrics.run_level(call, sample_count=24, concurrency=4)
        self.assertEqual(result["count"], 24)
        self.assertEqual(result["success_count"], 24)
        self.assertLessEqual(state["peak"], 4)
        self.assertGreaterEqual(state["peak"], 2)

    def test_concurrency_one_is_serial(self):
        lock = threading.Lock()
        state = {"active": 0, "peak": 0}

        def call(index):
            with lock:
                state["active"] += 1
                state["peak"] = max(state["peak"], state["active"])
            time.sleep(0.002)
            with lock:
                state["active"] -= 1
            return {"ok": True, "kind": "image"}

        result = metrics.run_level(call, sample_count=5, concurrency=1)
        self.assertEqual(result["count"], 5)
        self.assertEqual(state["peak"], 1)


class OutcomeCountingTests(unittest.TestCase):
    def test_failures_are_fully_counted(self):
        def call(index):
            if index % 3 == 0:
                return {"ok": False, "kind": "text", "error_class": "timeout"}
            if index % 3 == 1:
                return {"ok": False, "kind": "image", "error_class": "http_500"}
            return {"ok": True, "kind": "text"}

        result = metrics.run_level(call, sample_count=30, concurrency=3)
        self.assertEqual(result["count"], 30)
        self.assertEqual(result["success_count"], 10)
        self.assertEqual(result["error_count"], 20)
        self.assertEqual(result["success_count"] + result["error_count"], result["count"])
        # http_500 不是固定类别 -> internal_error
        self.assertEqual(result["errors"]["timeout"], 10)
        self.assertEqual(result["errors"]["internal_error"], 10)
        self.assertEqual(set(result["errors"]), set(metrics.ERROR_CLASSES))
        self.assertEqual(sum(result["errors"].values()), 20)

    def test_exception_is_internal_error_and_text_not_leaked(self):
        secret = "sk-LEAK-CANARY-123"

        def call(index):
            raise ValueError(f"boom with credential {secret}")

        result = metrics.run_level(call, sample_count=3, concurrency=2)
        self.assertEqual(result["count"], 3)
        self.assertEqual(result["success_count"], 0)
        self.assertEqual(result["errors"]["internal_error"], 3)
        self.assertIsNone(result["latency_success_ms"]["p50"])
        self.assertIsNone(result["latency_success_ms"]["p95"])
        self.assertEqual(result["success_per_minute"], 0.0)
        self.assertNotIn(secret, json.dumps(result))

    def test_non_mapping_and_bad_ok_are_internal_error(self):
        def call(index):
            if index == 0:
                return None
            if index == 1:
                return {"ok": 1, "kind": "text"}
            return {"ok": "yes", "kind": "text"}

        result = metrics.run_level(call, sample_count=3, concurrency=1)
        self.assertEqual(result["error_count"], 3)
        self.assertEqual(result["errors"]["internal_error"], 3)
        # 缺少合法 kind 的失败不计入任何 kind 桶，但计入总数
        for kind in metrics.KINDS:
            self.assertEqual(result["by_kind"][kind]["count"], 0)

    def test_invalid_kind_on_success_is_invalid_response(self):
        def call(index):
            return {"ok": True, "kind": "audio", "prompt_tokens": 100}

        result = metrics.run_level(call, sample_count=2, concurrency=1)
        self.assertEqual(result["error_count"], 2)
        self.assertEqual(result["errors"]["invalid_response"], 2)
        self.assertEqual(result["tokens"]["prompt_tokens"], 0)

    def test_invalid_token_metadata_is_invalid_response(self):
        def call(index):
            return {"ok": True, "kind": "card", "prompt_tokens": -1}

        result = metrics.run_level(call, sample_count=2, concurrency=1)
        self.assertEqual(result["errors"]["invalid_response"], 2)
        self.assertEqual(result["tokens"]["total_tokens"], 0)

    def test_unhashable_fields_are_contained(self):
        def call(index):
            if index == 0:
                return {"ok": True, "kind": ["text"], "prompt_tokens": 1}
            return {"ok": False, "kind": {"k": "text"}, "error_class": ["timeout"]}

        result = metrics.run_level(call, sample_count=2, concurrency=1)
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["errors"]["invalid_response"], 1)
        self.assertEqual(result["errors"]["internal_error"], 1)


class PercentileTests(unittest.TestCase):
    def test_nearest_rank_helper(self):
        values = [10.0, 20.0, 30.0, 40.0]
        self.assertEqual(metrics._percentile(values, 50.0), 20.0)
        self.assertEqual(metrics._percentile(values, 95.0), 40.0)
        self.assertEqual(metrics._percentile(values, 1.0), 10.0)
        self.assertEqual(metrics._percentile([7.0], 95.0), 7.0)
        self.assertIsNone(metrics._percentile([], 50.0))

    def test_nearest_rank_matches_rank_formula(self):
        values = [float(v) for v in range(1, 11)]  # 1..10
        # p95 -> rank 10 -> 10.0；p50 -> rank 5 -> 5.0
        self.assertEqual(metrics._percentile(values, 95.0), 10.0)
        self.assertEqual(metrics._percentile(values, 50.0), 5.0)

    def test_latency_payload_ordering_and_absence(self):
        def call(index):
            return {"ok": index != 0, "kind": "text", "error_class": "timeout"}

        some = metrics.run_level(call, sample_count=10, concurrency=2)
        self.assertIsNotNone(some["latency_all_ms"]["p50"])
        self.assertIsNotNone(some["latency_all_ms"]["p95"])
        self.assertLessEqual(some["latency_all_ms"]["p50"], some["latency_all_ms"]["p95"])
        self.assertGreaterEqual(some["latency_all_ms"]["p50"], 0.0)
        self.assertIsNotNone(some["latency_success_ms"]["p50"])

        def always_fail(index):
            return {"ok": False, "kind": "card", "error_class": "timeout"}

        none = metrics.run_level(always_fail, sample_count=4, concurrency=2)
        self.assertIsNone(none["latency_success_ms"]["p50"])
        self.assertIsNone(none["latency_success_ms"]["p95"])
        self.assertIsNotNone(none["latency_all_ms"]["p50"])


class NoLeakTests(unittest.TestCase):
    def test_extra_fields_and_secrets_are_not_echoed(self):
        canaries = ["api_key=sk-CANARY", "buyer said: 你好", "trace-42"]

        def call(index):
            if index == 0:
                return {
                    "ok": True,
                    "kind": "text",
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "cache_hit_tokens": 2,
                    "api_key": canaries[0],
                    "raw_prompt": canaries[1],
                    "trace_id": canaries[2],
                    "exception": "Traceback (most recent call last)",
                }
            return {"ok": False, "kind": "image", "error_class": "connection_error"}

        result = metrics.run_level(call, sample_count=2, concurrency=1)
        self.assertEqual(set(result), TOP_LEVEL_KEYS)
        self.assertEqual(set(result["latency_all_ms"]), {"p50", "p95"})
        self.assertEqual(set(result["latency_success_ms"]), {"p50", "p95"})
        self.assertEqual(set(result["errors"]), set(metrics.ERROR_CLASSES))
        self.assertEqual(set(result["by_kind"]), set(metrics.KINDS))
        self.assertEqual(set(result["tokens"]), {
            "prompt_tokens",
            "completion_tokens",
            "cache_hit_tokens",
            "total_tokens",
        })
        blob = json.dumps(result, ensure_ascii=False)
        for canary in canaries:
            self.assertNotIn(canary, blob)
        self.assertNotIn("Traceback", blob)
        self.assertNotIn("sk-CANARY", blob)
        for kind in metrics.KINDS:
            self.assertEqual(
                set(result["by_kind"][kind]),
                {
                    "count",
                    "success_count",
                    "error_count",
                    "latency_all_ms",
                    "latency_success_ms",
                    "tokens",
                },
            )


class ByKindAndTokenTests(unittest.TestCase):
    def test_kind_aggregation_and_tokens(self):
        def call(index):
            if index < 2:
                return {
                    "ok": True,
                    "kind": "text",
                    "prompt_tokens": 10,
                    "completion_tokens": 4,
                    "cache_hit_tokens": 3,
                }
            if index == 2:
                return {
                    "ok": True,
                    "kind": "image",
                    "prompt_tokens": 100,
                    "completion_tokens": 20,
                    "cache_hit_tokens": 0,
                }
            if index == 3:
                return {"ok": False, "kind": "card", "error_class": "http_429"}
            return {"ok": False, "kind": "text", "error_class": "timeout"}

        result = metrics.run_level(call, sample_count=5, concurrency=2)

        text = result["by_kind"]["text"]
        self.assertEqual(text["count"], 3)
        self.assertEqual(text["success_count"], 2)
        self.assertEqual(text["error_count"], 1)
        self.assertEqual(text["tokens"]["prompt_tokens"], 20)
        self.assertEqual(text["tokens"]["completion_tokens"], 8)
        self.assertEqual(text["tokens"]["cache_hit_tokens"], 6)

        image = result["by_kind"]["image"]
        self.assertEqual(image["count"], 1)
        self.assertEqual(image["success_count"], 1)
        self.assertEqual(image["tokens"]["total_tokens"], 120)

        card = result["by_kind"]["card"]
        self.assertEqual(card["count"], 1)
        self.assertEqual(card["success_count"], 0)
        self.assertEqual(card["tokens"]["total_tokens"], 0)
        self.assertIsNone(card["latency_success_ms"]["p50"])

        self.assertEqual(result["tokens"]["prompt_tokens"], 120)
        self.assertEqual(result["tokens"]["completion_tokens"], 28)
        self.assertEqual(result["tokens"]["cache_hit_tokens"], 6)
        self.assertEqual(result["tokens"]["total_tokens"], 148)
        self.assertEqual(result["errors"]["http_429"], 1)
        self.assertEqual(result["errors"]["timeout"], 1)

    def test_missing_tokens_default_to_zero(self):
        def call(index):
            return {"ok": True, "kind": "card"}

        result = metrics.run_level(call, sample_count=3, concurrency=3)
        self.assertEqual(result["success_count"], 3)
        self.assertEqual(result["tokens"]["prompt_tokens"], 0)
        self.assertEqual(result["tokens"]["total_tokens"], 0)


class InputValidationTests(unittest.TestCase):
    @staticmethod
    def _call(index):
        return {"ok": True, "kind": "text"}

    def test_concurrency_bounds(self):
        self.assertEqual(metrics.run_level(self._call, 1, 1)["count"], 1)
        self.assertEqual(metrics.run_level(self._call, 2, 12)["count"], 2)
        for bad in (0, 13, -1, 100):
            with self.assertRaises(ValueError):
                metrics.run_level(self._call, 1, bad)

    def test_sample_count_bounds(self):
        self.assertEqual(metrics.run_level(self._call, 1, 1)["count"], 1)
        self.assertEqual(metrics.run_level(self._call, 120, 12)["count"], 120)
        for bad in (0, 121, -5):
            with self.assertRaises(ValueError):
                metrics.run_level(self._call, bad, 1)

    def test_bool_is_rejected(self):
        for bad in (True, False):
            with self.assertRaises(TypeError):
                metrics.run_level(self._call, bad, 1)
            with self.assertRaises(TypeError):
                metrics.run_level(self._call, 1, bad)

    def test_non_integer_is_rejected(self):
        for bad in (1.0, "1", None, [1]):
            with self.assertRaises(TypeError):
                metrics.run_level(self._call, bad, 1)
            with self.assertRaises(TypeError):
                metrics.run_level(self._call, 1, bad)

    def test_call_must_be_callable(self):
        with self.assertRaises(TypeError):
            metrics.run_level(None, 1, 1)

    def test_call_receives_zero_based_indices(self):
        seen = []
        lock = threading.Lock()

        def call(index):
            with lock:
                seen.append(index)
            return {"ok": True, "kind": "text"}

        metrics.run_level(call, sample_count=7, concurrency=3)
        self.assertEqual(sorted(seen), list(range(7)))


class TimingTests(unittest.TestCase):
    def test_latency_excludes_queue_wait(self):
        # 每个 call 固定睡 30ms；并发 1 时排队时间不计入单次延迟。
        def call(index):
            time.sleep(0.03)
            return {"ok": True, "kind": "text"}

        result = metrics.run_level(call, sample_count=3, concurrency=1)
        p50 = result["latency_all_ms"]["p50"]
        self.assertGreaterEqual(p50, 25.0)
        self.assertLess(p50, 200.0)
        # 总 elapsed 涵盖整轮，必然不小于单次延迟
        self.assertGreaterEqual(result["elapsed_ms"], p50)

    def test_success_per_minute_consistent(self):
        def call(index):
            time.sleep(0.01)
            return {"ok": True, "kind": "text"}

        result = metrics.run_level(call, sample_count=4, concurrency=2)
        self.assertEqual(result["success_count"], 4)
        self.assertGreater(result["success_per_minute"], 0.0)
        expected = result["success_count"] * 60000.0 / result["elapsed_ms"]
        self.assertAlmostEqual(result["success_per_minute"], expected, places=6)


if __name__ == "__main__":
    unittest.main()
