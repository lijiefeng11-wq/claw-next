"""模型吞吐脚本的纯标准库、与平台无关的计量工具。

本模块只做本地计量，不发起任何网络请求，也不调用真实模型。
调用方负责超时/截止与重试策略；本模块不自动重试。

公开 API::

    run_level(call, sample_count, concurrency) -> dict

其中 ``call(index)`` 由调用方提供，返回一个字典型结果::

    {
        "ok": bool,
        "kind": "text" | "image" | "card",
        "error_class": 可选，固定类别之一,
        "prompt_tokens": 可选，非负整数,
        "completion_tokens": 可选，非负整数,
        "cache_hit_tokens": 可选，非负整数,
    }

返回的 aggregate 字典只包含白名单字段；call 原始结果里的其他字段、
异常对象与异常文本都不会被复制或回显。
"""

from __future__ import annotations

import math
import time
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, NamedTuple

__all__ = [
    "run_level",
    "ERROR_CLASSES",
    "KINDS",
    "MIN_CONCURRENCY",
    "MAX_CONCURRENCY",
    "MIN_SAMPLE_COUNT",
    "MAX_SAMPLE_COUNT",
]

MIN_CONCURRENCY = 1
MAX_CONCURRENCY = 12
MIN_SAMPLE_COUNT = 1
MAX_SAMPLE_COUNT = 120

#: 固定错误类别，顺序稳定，便于逐项计数。
ERROR_CLASSES = (
    "timeout",
    "http_429",
    "http_4xx",
    "http_5xx",
    "connection_error",
    "invalid_response",
    "internal_error",
)
ERROR_CLASS_SET = frozenset(ERROR_CLASSES)

#: 固定结果类型。
KINDS = ("text", "image", "card")
KIND_SET = frozenset(KINDS)

_TOKEN_FIELDS = ("prompt_tokens", "completion_tokens", "cache_hit_tokens")


class _Observation(NamedTuple):
    """一个样本的测量结果；只保留值，不保留原始对象。"""

    elapsed_ms: float
    kind: str | None
    success: bool
    error_class: str | None
    tokens: tuple[int, int, int]


def _is_int(value: Any) -> bool:
    """严格整数判断：布尔值不算整数。"""
    return isinstance(value, int) and not isinstance(value, bool)


def _require_bounded_int(name: str, value: Any, minimum: int, maximum: int) -> int:
    if not _is_int(value):
        raise TypeError(f"{name} 必须是整数（不含布尔），收到 {type(value).__name__}")
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} 必须在 {minimum}..{maximum} 之间，收到 {value}")
    return int(value)


def _percentile(values: list[float], percent: float) -> float | None:
    """最近秩（nearest-rank）百分位；空序列返回 None。"""
    if not values:
        return None
    ordered = sorted(values)
    rank = math.ceil(percent / 100.0 * len(ordered))
    index = min(max(rank - 1, 0), len(ordered) - 1)
    return ordered[index]


def _classify(result: Any) -> tuple[str | None, bool, str | None, tuple[int, int, int]]:
    """把 call 的返回值规范化为白名单内的字段。

    返回 ``(kind, success, error_class, tokens)``。
    结构非法时按 ``internal_error`` 计；成功但 kind 非法或 token 字段非法时
    按 ``invalid_response`` 计。任何情况下都不读取/保留额外字段。
    """
    if not isinstance(result, Mapping):
        return None, False, "internal_error", (0, 0, 0)

    ok = result.get("ok")
    if not isinstance(ok, bool):
        return None, False, "internal_error", (0, 0, 0)

    raw_kind = result.get("kind")
    kind = raw_kind if isinstance(raw_kind, str) and raw_kind in KIND_SET else None

    if not ok:
        raw_error = result.get("error_class")
        if isinstance(raw_error, str) and raw_error in ERROR_CLASS_SET:
            error_class = raw_error
        else:
            error_class = "internal_error"
        return kind, False, error_class, (0, 0, 0)

    if kind is None:
        return None, False, "invalid_response", (0, 0, 0)

    tokens: list[int] = []
    for field in _TOKEN_FIELDS:
        value = result.get(field, 0)
        if not _is_int(value) or value < 0:
            return kind, False, "invalid_response", (0, 0, 0)
        tokens.append(int(value))
    return kind, True, None, (tokens[0], tokens[1], tokens[2])


def _measure(call: Callable[[int], Any], index: int) -> _Observation:
    """执行单个样本，只把 call 自身的运行时长计入延迟。

    计时起止都在 worker 内完成，排队等待时间不会被算作模型时长。
    call 抛出的任何常规异常都折叠为 internal_error，且不保留异常文本。
    """
    started = time.monotonic()
    try:
        result = call(index)
    except Exception:  # noqa: BLE001 - 异常一律折叠为固定类别，不输出文本
        elapsed_ms = (time.monotonic() - started) * 1000.0
        return _Observation(elapsed_ms, None, False, "internal_error", (0, 0, 0))
    elapsed_ms = (time.monotonic() - started) * 1000.0
    try:
        kind, success, error_class, tokens = _classify(result)
    except Exception:  # noqa: BLE001 - 畸形 Mapping 不得打断整档测量
        return _Observation(elapsed_ms, None, False, "internal_error", (0, 0, 0))
    return _Observation(elapsed_ms, kind, success, error_class, tokens)


def _token_payload(prompt: int, completion: int, cache_hit: int) -> dict[str, int]:
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "cache_hit_tokens": cache_hit,
        "total_tokens": prompt + completion,
    }


def _latency_payload(values: list[float]) -> dict[str, float | None]:
    return {
        "p50": _percentile(values, 50.0),
        "p95": _percentile(values, 95.0),
    }


def _aggregate(observations: list[_Observation], elapsed_ms: float) -> dict[str, Any]:
    latencies = [obs.elapsed_ms for obs in observations]
    success_latencies = [obs.elapsed_ms for obs in observations if obs.success]

    errors = {name: 0 for name in ERROR_CLASSES}
    kind_latencies: dict[str, list[float]] = {kind: [] for kind in KINDS}
    kind_success_latencies: dict[str, list[float]] = {kind: [] for kind in KINDS}
    kind_counts = {kind: 0 for kind in KINDS}
    kind_success = {kind: 0 for kind in KINDS}
    kind_errors = {kind: 0 for kind in KINDS}
    kind_tokens = {kind: [0, 0, 0] for kind in KINDS}

    success_count = 0
    total_tokens = [0, 0, 0]

    for obs in observations:
        if obs.success:
            success_count += 1
            total_tokens = [a + b for a, b in zip(total_tokens, obs.tokens)]
        elif obs.error_class is not None:
            errors[obs.error_class] += 1

        if obs.kind in KIND_SET:
            kind = obs.kind
            kind_counts[kind] += 1
            kind_latencies[kind].append(obs.elapsed_ms)
            if obs.success:
                kind_success[kind] += 1
                kind_success_latencies[kind].append(obs.elapsed_ms)
                kind_tokens[kind] = [
                    a + b for a, b in zip(kind_tokens[kind], obs.tokens)
                ]
            else:
                kind_errors[kind] += 1

    count = len(observations)
    error_count = count - success_count
    if success_count and elapsed_ms > 0:
        success_per_minute = success_count * 60000.0 / elapsed_ms
    else:
        success_per_minute = 0.0

    by_kind = {}
    for kind in KINDS:
        prompt, completion, cache_hit = kind_tokens[kind]
        by_kind[kind] = {
            "count": kind_counts[kind],
            "success_count": kind_success[kind],
            "error_count": kind_errors[kind],
            "latency_all_ms": _latency_payload(kind_latencies[kind]),
            "latency_success_ms": _latency_payload(kind_success_latencies[kind]),
            "tokens": _token_payload(prompt, completion, cache_hit),
        }

    prompt, completion, cache_hit = total_tokens
    return {
        "count": count,
        "success_count": success_count,
        "error_count": error_count,
        "elapsed_ms": elapsed_ms,
        "success_per_minute": success_per_minute,
        "latency_all_ms": _latency_payload(latencies),
        "latency_success_ms": _latency_payload(success_latencies),
        "errors": errors,
        "by_kind": by_kind,
        "tokens": _token_payload(prompt, completion, cache_hit),
    }


def run_level(
    call: Callable[[int], Any],
    sample_count: Any,
    concurrency: Any,
) -> dict[str, Any]:
    """跑完一档（固定并发）的全部样本并返回聚合指标。

    ``call(index)`` 在 worker 线程中执行，index 取 0..sample_count-1。
    使用有界线程池（并发固定为 concurrency），不自动重试。
    总 elapsed 覆盖本档整轮从开始提交到全部样本收齐的时间。
    """
    if not callable(call):
        raise TypeError("call 必须是可调用对象")
    sample_count = _require_bounded_int(
        "sample_count", sample_count, MIN_SAMPLE_COUNT, MAX_SAMPLE_COUNT
    )
    concurrency = _require_bounded_int(
        "concurrency", concurrency, MIN_CONCURRENCY, MAX_CONCURRENCY
    )

    started = time.monotonic()
    observations: list[_Observation] = []
    executor = ThreadPoolExecutor(
        max_workers=concurrency, thread_name_prefix="benchmark-metrics"
    )
    try:
        futures = [executor.submit(_measure, call, index) for index in range(sample_count)]
        for future in futures:
            observations.append(future.result())
    finally:
        executor.shutdown(wait=True)
    elapsed_ms = round((time.monotonic() - started) * 1000.0, 3)

    return _aggregate(observations, elapsed_ms)
