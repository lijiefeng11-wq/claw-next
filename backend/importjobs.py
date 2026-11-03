"""Short-lived private assist jobs; no uploaded data or drafts are persisted."""
import copy
import hashlib
import threading
import time
import uuid

from .chatrules import ImportCancelled
from .engine import ProviderFailure

TTL_SECONDS = 900
MAX_RESULTS = 8


class JobManager:
    def __init__(self, slot, *, clock=time.monotonic):
        self.slot, self.clock = slot, clock
        self.lock = threading.RLock()
        self.jobs = {}
        self.closed = False

    @staticmethod
    def owner(token):
        return hashlib.sha256(token.encode("ascii")).digest()

    def purge(self):
        with self.lock:
            terminal = sorted((job["finished_at"], key) for key, job in self.jobs.items()
                              if job["finished"].is_set())
            for index, (ended, key) in enumerate(terminal):
                if self.clock() - ended >= TTL_SECONDS or index < len(terminal) - MAX_RESULTS:
                    del self.jobs[key]

    def start(self, kind, owner, shop_id, shop_version, run, *, version=None):
        if not self.slot.acquire(blocking=False):
            raise ValueError("prompt_draft_busy")
        with self.lock:
            if self.closed:
                self.slot.release()
                raise ValueError("assist_cancelled")
            self.purge()
            job_id = uuid.uuid4().hex
            value = {"job_id": job_id, "shop_id": shop_id, "shop_version": shop_version,
                     "status": "running", "phase": "parsing" if kind == "import" else "analyzing",
                     "processed_batches": 0, "total_batches": None}
            if kind == "import":
                value.update(processed_messages=0, total_messages=None)
            else:
                value.update(version=version, processed_pairs=0, total_pairs=None, failed_batches=0)
            job = {"kind": kind, "owner": owner, "value": value, "cancel": threading.Event(),
                   "finished": threading.Event(), "finished_at": None}
            worker = threading.Thread(target=self._run, args=(job, run), name="claw-next-assist", daemon=True)
            job["thread"] = worker
            self.jobs[job_id] = job
            try:
                worker.start()
            except RuntimeError:
                del self.jobs[job_id]
                self.slot.release()
                raise ValueError("assist_failed") from None
            return {key: value[key] for key in ("job_id", "shop_id", "shop_version", "version") if key in value}

    def _run(self, job, run):
        def progress(value):
            with self.lock:
                if job["cancel"].is_set():
                    raise ImportCancelled()
                job["value"].update(value)
        try:
            result = run(progress, job["cancel"].is_set)
            with self.lock:
                if job["cancel"].is_set():
                    raise ImportCancelled()
                job["value"].update(status="completed", phase="completed", result=result)
        except ImportCancelled:
            with self.lock:
                self._cancel(job)
        except (ValueError, ProviderFailure) as exc:
            code = ("assist_unavailable" if isinstance(exc, ProviderFailure) else
                    "invalid_chat_import" if job["kind"] == "import" else "invalid_rule_context")
            with self.lock:
                if not job["cancel"].is_set():
                    job["value"].update(status="failed", error={"code": code})
        except Exception:
            # Fixed classification only: uploaded text/provider errors never enter logs.
            with self.lock:
                if not job["cancel"].is_set():
                    job["value"].update(status="failed", error={"code": "assist_failed"})
        finally:
            with self.lock:
                self.slot.release()
                job["finished_at"] = self.clock()
                job["finished"].set()
                self.purge()

    @staticmethod
    def _cancel(job):
        job["cancel"].set()
        job["value"].pop("result", None)
        job["value"].update(status="cancelled", error={"code": "assist_cancelled"})

    def get(self, job_id, owner, kind):
        with self.lock:
            self.purge()
            job = self.jobs.get(job_id)
            if job is None or job["owner"] != owner or job["kind"] != kind:
                return None
            return copy.deepcopy(job["value"])

    def cancel(self, job_id, owner, kind):
        with self.lock:
            self.purge()
            job = self.jobs.get(job_id)
            if job is None or job["owner"] != owner or job["kind"] != kind:
                return None
            self._cancel(job)
            # Cooperative work retains the semaphore until its finally block exits.
            return copy.deepcopy(job["value"])

    def close(self):
        with self.lock:
            self.closed = True
            jobs = list(self.jobs.values())
            for job in jobs:
                self._cancel(job)
        deadline = time.monotonic() + 2
        for job in jobs:
            job["thread"].join(timeout=max(0, deadline - time.monotonic()))
        with self.lock:
            self.jobs.clear()
