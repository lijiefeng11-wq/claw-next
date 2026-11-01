"""Metadata-only, process-local model health; never controls delivery or retries."""
import threading


class Operations:
    def __init__(self):
        self.lock = threading.Lock()
        self.failures = {}

    def model_finished(self, shop, result):
        reason = result.get("reason", "")
        with self.lock:
            if reason.startswith("model_unavailable:") or reason in ("decision_internal_error", "model_not_configured", "model_rule_unusable"):
                self.failures[shop] = min(self.failures.get(shop, 0) + 1, 1000000)
            elif reason.startswith(("model:", "rule_semantic:")):
                self.failures.pop(shop, None)
            # Cancelled/expired work and non-model decisions prove neither
            # model success nor model failure and leave the streak unchanged.

    def snapshot(self):
        with self.lock:
            return {"model_failures": dict(self.failures)}
