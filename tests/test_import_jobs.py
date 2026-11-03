"""Private asynchronous imports use only fictional records and loopback providers."""
import copy
import json
import pathlib
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from backend import chatrules, importjobs
from backend.app import create_server
from synthetic_provider import completion, http_error
import test_model_settings as fixtures


def record(question="怎样清洁？", answer="请用软布。"):
    return {"messages": [{"role": "buyer", "content": question}, {"role": "agent", "content": answer}]}


class FullImportTests(unittest.TestCase):
    def test_full_import_retains_every_unique_pair_and_duplicate_frequency(self):
        records = [record("问题" + str(i), "回答") for i in range(450)] + [record("问题449", "回答")]
        result = chatrules.parse_import("test.json", json.dumps(records), full=True)
        self.assertEqual(len(result["pairs"]), 450)
        self.assertEqual(result["pairs"][-1]["count"], 2)
        self.assertEqual(result["stats"]["duplicates"], 1)
        self.assertEqual(result["stats"]["sampled_out"], 0)
        self.assertFalse(any("抽样" in note for note in result["warnings"]))

    def test_dedup_retains_different_answers_conditions_and_distinct_session_count(self):
        first = record()
        first["messages"] *= 2
        result = chatrules.parse_import("test.json", json.dumps([first, record(), record(answer="不用溶剂。"), record(question="仅外侧怎样清洁？")]), full=True)
        self.assertEqual(result["stats"]["eligible"], 5)
        self.assertEqual(result["stats"]["unique"], 3)
        self.assertEqual(result["stats"]["duplicates"], 2)
        self.assertEqual(result["pairs"][0]["count"], 2)
        self.assertEqual(result["pairs"][0]["conversations"], ["c1", "c2"])
        self.assertEqual(result["pairs"][1]["answer"], "不用溶剂。")

    def test_real_progress_covers_46846_messages_in_bounded_batches_without_a_cap(self):
        history = []
        value = chatrules.parse_import("test.json", json.dumps([record()] * 23423), full=True, progress=history.append)
        self.assertEqual(history[0]["total_messages"], None)
        counts = [step["processed_messages"] for step in history]
        self.assertEqual(counts, sorted(counts))
        self.assertEqual(counts[-1], 46846)
        self.assertLessEqual(max(b-a for a,b in zip(counts,counts[1:])), 1000)
        self.assertEqual(history[-1]["processed_batches"], 47)
        self.assertEqual(history[-1]["total_batches"], 47)
        self.assertEqual(value["pairs"][0]["count"], 23423)
        self.assertEqual(value["stats"]["messages"], 46846)

    def test_cancel_checkpoint_stops_parser_without_producing_a_partial_result(self):
        cancel = threading.Event()
        def progress(value):
            if value["processed_messages"] >= 1000:
                cancel.set()
        with self.assertRaises(chatrules.ImportCancelled):
            chatrules.parse_import("test.json", json.dumps([record()] * 1500), full=True,
                                   progress=progress, cancelled=cancel.is_set)

    def test_full_qa_frequency_is_sent_but_private_source_lists_are_not(self):
        pairs = chatrules.parse_import("test.json", json.dumps([record(), record()]), full=True)["pairs"]
        cfg = {"primary": {"base_url": "http://127.0.0.1:9/v1", "model": "synthetic"}}
        answer = {"candidates": [{"contains": "清洁", "description": "方法", "reply": "请用软布。", "evidence_ids": ["p1"], "conflicts": [], "warnings": []}], "warnings": []}
        clean = [{k:pairs[0][k] for k in ("id", "question", "answer", "conversation")}]
        with patch.object(chatrules, "_post", return_value={"choices":[{"message":{"content":json.dumps(answer)}}]}) as post:
            result = chatrules.generate(clean, [], cfg, conversations={pairs[0]["id"]: pairs[0]["conversations"]})
        self.assertEqual(result["candidates"][0]["count"], 2)
        sent = json.loads(post.call_args.args[1]["messages"][1]["content"])["pairs"][0]
        self.assertEqual(sent["frequency"], 2)
        self.assertNotIn("conversations", sent)


class JobManagerTests(unittest.TestCase):
    def test_invalid_rule_context_does_not_blame_the_import_or_echo_exceptions(self):
        manager = importjobs.JobManager(threading.BoundedSemaphore(1))
        self.addCleanup(manager.close)
        def run(progress, cancelled):
            raise ValueError("PRIVATE-CONTEXT-SENTINEL")
        job=manager.start("rules",b"owner","demo",0,run,version=0)
        self.assertTrue(manager.jobs[job["job_id"]]["finished"].wait(5))
        value=manager.get(job["job_id"],b"owner","rules")
        self.assertEqual(value["error"]["code"],"invalid_rule_context")
        self.assertNotIn("PRIVATE-CONTEXT-SENTINEL",json.dumps(value))

    def test_cancellation_keeps_shared_slot_until_actual_worker_exit(self):
        slot, entered, leave = threading.BoundedSemaphore(1), threading.Event(), threading.Event()
        manager = importjobs.JobManager(slot)
        self.addCleanup(manager.close)
        def run(progress, cancelled):
            entered.set()
            leave.wait(5)
            if cancelled():
                raise chatrules.ImportCancelled()
            return {"pairs": []}
        job = manager.start("import", b"owner", "demo", 0, run)
        self.assertTrue(entered.wait(5))
        self.assertEqual(manager.cancel(job["job_id"], b"other", "import"), None)
        self.assertEqual(manager.cancel(job["job_id"], b"owner", "import")["status"], "cancelled")
        self.assertFalse(slot.acquire(blocking=False))
        leave.set()
        self.assertTrue(manager.jobs[job["job_id"]]["finished"].wait(5))
        self.assertTrue(slot.acquire(blocking=False))
        slot.release()

    def test_terminal_results_have_a_ttl_and_count_bound(self):
        now = [0]
        manager = importjobs.JobManager(threading.BoundedSemaphore(1), clock=lambda: now[0])
        self.addCleanup(manager.close)
        for i in range(importjobs.MAX_RESULTS + 3):
            now[0] += 1
            job = manager.start("import", b"owner", "demo", 0, lambda p,c: {"private": "synthetic"})
            self.assertTrue(manager.jobs[job["job_id"]]["finished"].wait(5))
        self.assertEqual(len(manager.jobs), importjobs.MAX_RESULTS)
        self.assertIsNone(manager.get(job["job_id"], b"other", "import"))
        self.assertIsNone(manager.get(job["job_id"], b"owner", "rules"))
        now[0] += importjobs.TTL_SECONDS
        manager.purge()
        self.assertEqual(manager.jobs, {})


class AssistJobApiTests(unittest.TestCase):
    setUp = fixtures.ModelSettingsTests.setUp
    start = fixtures.ModelSettingsTests.start
    stop = fixtures.ModelSettingsTests.stop
    stop_all = fixtures.ModelSettingsTests.stop_all
    request = fixtures.ModelSettingsTests.request
    get_config = fixtures.ModelSettingsTests.get_config
    save = fixtures.ModelSettingsTests.save
    slot_payload = staticmethod(fixtures.ModelSettingsTests.slot_payload)
    save_providers = fixtures.ModelSettingsTests.save_providers

    def import_job(self, text=None):
        status, result = self.request("POST", "/api/v1/admin/chat-import/jobs",
                                      {"shop_id": "demo", "filename": "test.json", "text": text or json.dumps([record(),record()])}, token=self.token)
        self.assertEqual(status, 202, result)
        return result

    def wait_job(self, job, endpoint="chat-import"):
        until = time.monotonic() + 5
        while time.monotonic() < until:
            status, result = self.request("GET", "/api/v1/admin/"+endpoint+"/jobs/"+job["job_id"], token=self.token)
            self.assertEqual(status, 200, result)
            if result["status"] != "running":
                return result
            time.sleep(.005)
        self.fail("synthetic job did not finish")

    def rules_job(self, imported):
        payload = {"shop_id": "demo", "shop_version": imported["shop_version"], "version": self.get_config()["version"],
                   "import_job_id": imported["job_id"], "existing_rules": []}
        status, value = self.request("POST", "/api/v1/admin/rule-draft/jobs", payload, token=self.token)
        self.assertEqual(status, 202, value)
        return value

    def test_full_import_is_private_temporary_and_does_not_call_models(self):
        before = copy.deepcopy(self.server.store.shops())
        job = self.import_job(json.dumps([{**record(), "buyer_id": "PRIVATE-IMPORT-SENTINEL"}] * 11000))
        result = self.wait_job(job)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["result"]["stats"]["messages"], 22000)
        self.assertEqual(result["result"]["pairs"][0]["count"], 11000)
        self.assertEqual(result["processed_messages"], 22000)
        self.assertEqual(self.primary.count()+self.backup.count(), 0)
        self.assertEqual(self.server.store.shops(), before)
        self.assertEqual(self.server.store.events(), [])
        # The service already has a metadata-only diagnostic JSONL; its existence
        # must not be mistaken for persistence of this uploaded file.
        for path in pathlib.Path(self.data_dir).rglob("*.jsonl"):
            self.assertNotIn("PRIVATE-IMPORT-SENTINEL", path.read_text())

    def test_every_job_route_checks_admin_password_and_exact_session_owner(self):
        job = self.import_job()
        self.wait_job(job)
        url = "/api/v1/admin/chat-import/jobs/"+job["job_id"]
        status, login = self.request("POST", "/api/v1/admin/login", {"username": "admin", "password": fixtures.ADMIN_PASSWORD})
        self.assertEqual(status, 200)
        for method in ("GET", "DELETE"):
            self.assertEqual(self.request(method, url)[0], 401)
            self.assertEqual(self.request(method, url, token=fixtures.CLIENT_TOKEN)[0], 403)
            self.assertEqual(self.request(method, url, token=login["session_token"])[0], 404)
            with patch.object(self.server.auth, "identity", return_value={"role":"admin","must_change_password":True}):
                self.assertEqual(self.request(method, url, token=self.token)[0], 403)
        self.request("POST", "/api/v1/admin/logout", {}, token=self.token)
        self.assertEqual(self.request("GET", url, token=self.token)[0], 401)

    def test_shop_change_discards_result_and_source_job_cannot_cross_shops(self):
        job = self.import_job()
        self.wait_job(job)
        settings = self.server.store.shops()[0]["settings"]
        self.assertEqual(self.request("PUT", "/api/v1/admin/shops/demo/settings", settings, token=self.token)[0], 200)
        status, value = self.request("GET", "/api/v1/admin/chat-import/jobs/"+job["job_id"], token=self.token)
        self.assertEqual(status, 409, value)
        self.assertEqual(value["error"]["code"], "shop_settings_changed")
        self.assertEqual(self.server.assist_jobs.get(job["job_id"],self.server.assist_jobs.owner(self.token),"import")["status"], "cancelled")

    def test_invalid_import_is_a_fixed_error_and_slot_releases(self):
        job = self.import_job("PRIVATE-SENTINEL malformed JSON")
        value = self.wait_job(job)
        self.assertEqual(value["status"], "failed")
        self.assertEqual(value["error"]["code"], "invalid_chat_import")
        self.assertNotIn("PRIVATE-SENTINEL", json.dumps(value))
        self.assertTrue(self.server.assist_jobs.jobs[job["job_id"]]["finished"].wait(5))
        self.assertEqual(self.wait_job(self.import_job())["status"], "completed")

    def test_new_route_10_mib_boundary_and_json_escape_envelope(self):
        base = json.dumps(record())
        text = "\t"*(10*1024*1024-len(base.encode()))+base
        self.assertEqual(self.wait_job(self.import_job(text))["status"], "completed")
        status, value = self.request("POST", "/api/v1/admin/chat-import/jobs", {"shop_id":"demo","filename":"test.json","text":text+" "}, token=self.token)
        self.assertEqual(status, 400, value)
        self.assertEqual(value["error"]["code"], "invalid_chat_import")

    def test_generation_uses_saved_backup_once_and_server_owned_frequency(self):
        self.save_providers()
        imported = self.import_job()
        self.wait_job(imported)
        answer = {"candidates":[{"contains":"清洁","description":"清洁方法","reply":"请用软布。","evidence_ids":["p1"],"conflicts":[],"warnings":[]}],"warnings":[]}
        self.primary.queue(http_error(503))
        self.backup.queue(completion(json.dumps(answer)))
        job = self.rules_job(imported)
        result = self.wait_job(job,"rule-draft")
        self.assertEqual(result["status"], "completed", result)
        self.assertEqual(result["processed_pairs"], 1)
        self.assertEqual(result["result"]["candidates"][0]["count"], 2)
        self.assertEqual((self.primary.count(),self.backup.count()), (1,1))
        self.assertTrue(any("备用" in note for note in result["result"]["warnings"]))
        self.assertEqual(self.server.store.events(), [])

    def test_model_version_change_during_primary_prevents_backup_and_hides_result(self):
        self.save_providers()
        imported = self.import_job()
        self.wait_job(imported)
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def provider(spec, body):
            entered.set()
            release.wait(5)
            raise chatrules.ProviderFailure("timeout")
        with patch.object(chatrules, "_post", side_effect=provider) as post:
            job = self.rules_job(imported)
            self.assertTrue(entered.wait(5))
            self.save_providers()
            status, value = self.request("GET", "/api/v1/admin/rule-draft/jobs/"+job["job_id"], token=self.token)
            self.assertEqual(status, 409, value)
            # Saving a model also advances shop versions to invalidate permits.
            self.assertEqual(value["error"]["code"], "shop_settings_changed")
            release.set()
            self.assertTrue(self.server.assist_jobs.jobs[job["job_id"]]["finished"].wait(5))
            self.assertEqual(post.call_count, 1)

    def test_logout_during_a_batch_prevents_starting_the_next_batch(self):
        self.save_providers()
        imported = self.import_job(json.dumps([record("问题"+str(i)) for i in range(201)]))
        self.wait_job(imported)
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def provider(spec, body):
            entered.set()
            release.wait(5)
            return {"choices":[{"message":{"content":json.dumps({"candidates":[],"warnings":[]})}}]}
        with patch.object(chatrules, "_post", side_effect=provider) as post:
            job = self.rules_job(imported)
            self.assertTrue(entered.wait(5))
            self.assertEqual(self.request("POST", "/api/v1/admin/logout", {}, token=self.token)[0], 200)
            release.set()
            self.assertTrue(self.server.assist_jobs.jobs[job["job_id"]]["finished"].wait(5))
            self.assertEqual(post.call_count, 1)
        self.assertEqual(self.request("GET", "/api/v1/admin/rule-draft/jobs/"+job["job_id"], token=self.token)[0], 401)

    def test_import_job_cannot_be_used_for_another_valid_shop(self):
        self.stop()
        self.config["shops"].append({"shop_id":"other","name":"另一家虚构店"})
        self.start()
        imported = self.import_job()
        self.wait_job(imported)
        other = next(s for s in self.server.store.shops() if s["shop_id"] == "other")
        status, value = self.request("POST", "/api/v1/admin/rule-draft/jobs", {
            "shop_id":"other", "shop_version":other["settings"]["version"], "version":self.get_config()["version"],
            "import_job_id":imported["job_id"], "existing_rules":[]}, token=self.token)
        self.assertEqual(status, 409, value)
        self.assertEqual(self.primary.count()+self.backup.count(), 0)


if __name__ == "__main__":
    unittest.main()
