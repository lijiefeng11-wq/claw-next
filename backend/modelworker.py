"""A killable worker for negotiated budgets, including stalled DNS/socket reads."""
import multiprocessing
import time

from .engine import decide, decision


def _run(connection, job, config):
    try:
        try:
            result = decide(job, config)
        except Exception:
            job["timing"] = {"failure_class": "internal_error"}
            result = decision("handoff", "decision_internal_error")
        connection.send((result, job.get("timing", {})))
    finally:
        connection.close()


def bounded_decide(job, config, active, stopped):
    """At most one child per occupied scheduler slot; always reap before reuse."""
    deadline = job["deadline_monotonic"]
    if time.monotonic() >= deadline or not active():
        return decision("handoff", "reply_deadline_exceeded")
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=_run, args=(sender, job, config), daemon=True)
    started = False
    try:
        process.start()
        started = True
        sender.close()
        while not stopped.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not active():
                return decision("handoff", "reply_deadline_exceeded")
            if receiver.poll(min(0.05, remaining)):
                result, timing = receiver.recv()
                if time.monotonic() >= deadline or not active():
                    return decision("handoff", "reply_deadline_exceeded")
                job["timing"] = timing
                return result
            if not process.is_alive():
                # The child can send and exit between poll() and is_alive().
                if receiver.poll(0):
                    continue
                job["timing"] = {"failure_class": "internal_error"}
                return decision("handoff", "decision_internal_error")
        return decision("handoff", "backend_stopping")
    except (EOFError, OSError):
        job["timing"] = {"failure_class": "internal_error"}
        return decision("handoff", "decision_internal_error")
    finally:
        sender.close()
        receiver.close()
        if started:
            if process.is_alive():
                process.terminate()
            process.join(timeout=0.5)
            if process.is_alive():
                process.kill()
                process.join()
            process.close()
