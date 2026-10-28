"""Independent black-box API contract tests for Claw-Next v1.

These tests only use the public HTTP surface described in
``contracts/protocol.md`` and the documented ``create_server`` factory.
No live platform, credentials, legacy Claw code, or real model endpoint is
touched.  All identifiers and messages are synthetic.
"""

from __future__ import annotations

import copy
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

# Make ``python -m unittest discover -s tests`` work regardless of the
# directory from which discovery is invoked.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from backend.app import create_server  # noqa: E402  (documented server factory)


# Legacy configured administrator token: retained only to prove it is
# reserved and ignored; administrator requests use a real login session.
LEGACY_ADMIN_TOKEN = "a" * 40
CLIENT_A_TOKEN = "b" * 40
CLIENT_B_TOKEN = "c" * 40

CONFIG = {
    "admin_token": LEGACY_ADMIN_TOKEN,
    "shops": [
        {"shop_id": "shop-a", "name": "A"},
        {"shop_id": "shop-b", "name": "B"},
    ],
    "clients": [
        {"client_id": "client-a", "shop_id": "shop-a", "token": CLIENT_A_TOKEN},
        {"client_id": "client-b", "shop_id": "shop-b", "token": CLIENT_B_TOKEN},
    ],
}

RULE_REPLY = "演示：营业时间请咨询人工客服。"
DEFAULT_RULES = [{"id": "hours", "contains": "营业时间", "reply": RULE_REPLY}]


class ApiContractTestCase(unittest.TestCase):
    """Starts a real HTTP server on an ephemeral loopback port per test."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory(prefix="claw-next-contract-")
        self.addCleanup(self._tmpdir.cleanup)

        self.server = create_server(
            copy.deepcopy(CONFIG), self._tmpdir.name, host="127.0.0.1", port=0
        )
        self.port = self.server.server_address[1]
        self.base_url = f"http://127.0.0.1:{self.port}"
        self._thread = threading.Thread(
            target=self.server.serve_forever,
            name="claw-next-contract-server",
            daemon=True,
        )
        self._thread.start()
        self.addCleanup(self._stop_server)
        # Administrative calls authenticate with a real session obtained from
        # POST /api/v1/admin/login after first-login password setup, never the legacy token.
        self.admin_token = self.login_admin()
        self._uid_counter = 0

    def _stop_server(self) -> None:
        if getattr(self, "server", None) is None:
            return
        self.server.shutdown()
        self.server.server_close()
        self._thread.join(timeout=5)

    # ------------------------------------------------------------------
    # HTTP / fixture helpers
    # ------------------------------------------------------------------
    def login(self, username="admin", password="admin"):
        """Real ``POST /api/v1/admin/login``; returns ``(status, body)``."""
        return self.request(
            "POST",
            "/api/v1/admin/login",
            {"username": username, "password": password},
        )

    def login_admin(self):
        """Acquire a fresh administrator session token for this fixture."""
        body = self.assert_status(self.login(), 200)
        password = "synthetic-contract-admin-password"
        self.assert_status(self.request("POST", "/api/v1/admin/password", {
            "current_password": "admin", "new_password": password,
            "confirm_password": password,
        }, token=body["session_token"]), 200)
        body = self.assert_status(self.login(password=password), 200)
        self.assertIs(body["must_change_password"], False)
        self.assertEqual(body.get("role"), "admin")
        self.assertEqual(body.get("username"), "admin")
        session_token = body.get("session_token")
        self.assertIsInstance(session_token, str)
        self.assertTrue(session_token)
        return session_token

    def uid(self, prefix: str) -> str:
        self._uid_counter += 1
        return f"{prefix}-{self._uid_counter}"

    def request(self, method, path, body=None, token=None, raw=None):
        """Perform one request and return ``(status, decoded_json_or_None)``."""
        if raw is not None:
            data = raw
        elif body is not None:
            data = json.dumps(body).encode("utf-8")
        else:
            data = None

        request = urllib.request.Request(
            self.base_url + path, data=data, method=method
        )
        if data is not None:
            request.add_header("Content-Type", "application/json")
        if token is not None:
            request.add_header("Authorization", f"Bearer {token}")

        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                status = response.status
                payload = response.read()
        except urllib.error.HTTPError as exc:
            status = exc.code
            payload = exc.read()

        decoded = None
        if payload:
            try:
                decoded = json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                decoded = None
        return status, decoded

    def assert_status(self, result, expected):
        status, body = result
        self.assertEqual(
            status,
            expected,
            msg=f"unexpected HTTP {status}, body={body!r}",
        )
        return body

    def assert_error_envelope(self, body):
        self.assertIsInstance(body, dict)
        self.assertIn("error", body)
        error = body["error"]
        self.assertIsInstance(error, dict)
        self.assertIsInstance(error.get("code"), str)
        self.assertTrue(error["code"])
        self.assertIsInstance(error.get("message"), str)
        return error

    def heartbeat(self, token, instance_id, session_id):
        body = self.assert_status(
            self.request(
                "POST",
                "/api/v1/heartbeat",
                {"instance_id": instance_id, "session_id": session_id},
                token=token,
            ),
            200,
        )
        self.assertIn("generation", body)
        self.assertIsInstance(body["generation"], int)
        self.assertGreater(body["generation"], 0)
        self.assertIn("expires_at", body)
        self.assertGreater(float(body["expires_at"]), time.time())
        return body

    def acquire(self, token=CLIENT_A_TOKEN, instance_id=None, session_id=None):
        instance_id = instance_id or self.uid("instance")
        session_id = session_id or self.uid("session")
        body = self.heartbeat(token, instance_id, session_id)
        return {
            "token": token,
            "instance_id": instance_id,
            "session_id": session_id,
            "generation": body["generation"],
        }

    def enable_shop(
        self,
        shop_id="shop-a",
        enabled=True,
        mode="rules",
        rules=None,
        system_prompt="仅根据所提供的店铺规则回答；无法确认则转人工。",
    ):
        settings = {
            "enabled": enabled,
            "mode": mode,
            "system_prompt": system_prompt,
            "rules": DEFAULT_RULES if rules is None else rules,
        }
        body = self.assert_status(
            self.request(
                "PUT",
                f"/api/v1/admin/shops/{urllib.parse.quote(shop_id)}/settings",
                settings,
                token=self.admin_token,
            ),
            200,
        )
        self.assertEqual(body.get("enabled"), enabled)
        self.assertIn("version", body)
        return body

    def make_event(
        self,
        lease,
        event_id=None,
        conversation_id="conversation-1",
        message_id=None,
        context_revision=1,
        content="请问营业时间是什么时候？",
        received_at=None,
        history_complete=True,
        role="buyer",
        kind="text",
    ):
        now = time.time()
        received_at = now if received_at is None else float(received_at)
        message_id = message_id or self.uid("message")
        message = {
            "id": message_id,
            "role": role,
            "kind": kind,
            "content": content,
            "created_at": received_at,
        }
        return {
            "event_id": event_id or self.uid("event"),
            "instance_id": lease["instance_id"],
            "session_id": lease["session_id"],
            "generation": lease["generation"],
            "conversation_id": conversation_id,
            "message_id": message_id,
            "context_revision": context_revision,
            "received_at": received_at,
            "context": {"history_complete": history_complete, "messages": [message]},
        }

    def submit_event(self, lease, payload, expected=202):
        return self.assert_status(
            self.request("POST", "/api/v1/events", payload, token=lease["token"]),
            expected,
        )

    def get_event(self, lease, event_id):
        return self.request(
            "GET",
            f"/api/v1/events/{urllib.parse.quote(event_id)}",
            token=lease["token"],
        )

    def wait_ready(self, lease, event_id, timeout=3.0):
        """Bounded poll (documented 0.5-1s cadence is too slow for tests)."""
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            status, body = self.get_event(lease, event_id)
            self.assertEqual(
                status, 200, msg=f"event lookup failed: {body!r}"
            )
            last = body
            if body.get("state") == "ready":
                return body
            if body.get("state") not in ("pending", "processing"):
                return body
            time.sleep(0.05)
        self.fail(f"event {event_id!r} not ready within {timeout}s; last={last!r}")

    def wait_settled(self, lease, event_id, timeout=3.0):
        """Bounded poll; return the last snapshot if still pending at deadline."""
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            status, body = self.get_event(lease, event_id)
            self.assertEqual(status, 200, msg=f"event lookup failed: {body!r}")
            last = body
            if body.get("state") == "ready":
                return body
            if body.get("state") not in ("pending", "processing"):
                return body
            time.sleep(0.05)
        self.assertIsNotNone(last)
        return last

    def claim(self, lease, event_id, attempt_id, expected=200):
        return self.assert_status(
            self.request(
                "POST",
                f"/api/v1/events/{urllib.parse.quote(event_id)}/claim",
                {
                    "instance_id": lease["instance_id"],
                    "session_id": lease["session_id"],
                    "generation": lease["generation"],
                    "attempt_id": attempt_id,
                },
                token=lease["token"],
            ),
            expected,
        )

    def receipt(self, lease, event_id, attempt_id, status, platform_message_id=None):
        payload = {"attempt_id": attempt_id, "status": status}
        if platform_message_id is not None:
            payload["platform_message_id"] = platform_message_id
        return self.request(
            "POST",
            f"/api/v1/events/{urllib.parse.quote(event_id)}/receipt",
            payload,
            token=lease["token"],
        )

    def ready_reply_event(self, shop_id="shop-a", token=CLIENT_A_TOKEN):
        """Enable a shop, submit one matching event, return (lease, payload, snapshot)."""
        self.enable_shop(shop_id=shop_id)
        lease = self.acquire(token=token)
        payload = self.make_event(lease)
        self.submit_event(lease, payload)
        snapshot = self.wait_ready(lease, payload["event_id"])
        self.assertEqual(snapshot.get("state"), "ready")
        self.assertEqual((snapshot.get("decision") or {}).get("action"), "reply")
        return lease, payload, snapshot

    # ------------------------------------------------------------------
    # Health and identity / auth boundaries
    # ------------------------------------------------------------------
    def test_health_is_public_and_me_returns_bound_identity(self):
        body = self.assert_status(self.request("GET", "/health"), 200)
        self.assertEqual(body.get("service"), "claw-next")
        self.assertEqual(body.get("protocol_version"), "1.0")
        self.assertEqual(body.get("status"), "ok")

        client_me = self.assert_status(
            self.request("GET", "/api/v1/me", token=CLIENT_A_TOKEN), 200
        )
        self.assertEqual(client_me.get("role"), "client")
        self.assertEqual(client_me.get("client_id"), "client-a")
        self.assertEqual(client_me.get("shop_id"), "shop-a")
        self.assertEqual(client_me.get("protocol_version"), "1.0")

        admin_me = self.assert_status(
            self.request("GET", "/api/v1/me", token=self.admin_token), 200
        )
        self.assertEqual(admin_me.get("role"), "admin")
        self.assertEqual(admin_me.get("protocol_version"), "1.0")

        # The legacy configured admin_token is reserved and never authenticates.
        for path in ("/api/v1/me", "/api/v1/admin/summary"):
            status, response = self.request("GET", path, token=LEGACY_ADMIN_TOKEN)
            self.assertEqual(status, 401, msg=response)
            self.assert_error_envelope(response)

    def test_protected_endpoints_require_bearer_token(self):
        protected = [
            ("GET", "/api/v1/me", None),
            (
                "POST",
                "/api/v1/heartbeat",
                {"instance_id": "instance-x", "session_id": "session-x"},
            ),
            (
                "POST",
                "/api/v1/events",
                {
                    "event_id": "event-x",
                    "instance_id": "instance-x",
                    "session_id": "session-x",
                    "generation": 1,
                    "conversation_id": "conversation-x",
                    "message_id": "message-x",
                    "context_revision": 1,
                    "received_at": time.time(),
                    "context": {"history_complete": True, "messages": []},
                },
            ),
            ("GET", "/api/v1/events/event-x", None),
            ("GET", "/api/v1/admin/summary", None),
        ]
        for method, path, body in protected:
            with self.subTest(method=method, path=path):
                status, response = self.request(method, path, body)
                self.assertEqual(status, 401, msg=response)
                self.assert_error_envelope(response)

        status, response = self.request(
            "GET", "/api/v1/me", token="z" * 40
        )
        self.assertEqual(status, 401, msg=response)
        self.assert_error_envelope(response)

        status, response = self.request(
            "GET", "/api/v1/me", token=LEGACY_ADMIN_TOKEN
        )
        self.assertEqual(status, 401, msg=response)
        self.assert_error_envelope(response)

    def test_client_token_cannot_access_admin_api(self):
        for path in (
            "/api/v1/admin/summary",
            "/api/v1/admin/shops",
            "/api/v1/admin/events",
        ):
            with self.subTest(path=path):
                status, body = self.request("GET", path, token=CLIENT_A_TOKEN)
                self.assertEqual(status, 403, msg=body)
                self.assert_error_envelope(body)

        status, body = self.request(
            "PUT",
            "/api/v1/admin/shops/shop-b/settings",
            {"enabled": True, "mode": "rules", "system_prompt": "", "rules": []},
            token=CLIENT_A_TOKEN,
        )
        self.assertEqual(status, 403, msg=body)

    def test_admin_session_cannot_impersonate_client(self):
        status, body = self.request(
            "POST",
            "/api/v1/heartbeat",
            {"instance_id": "instance-admin", "session_id": "session-admin"},
            token=self.admin_token,
        )
        self.assertEqual(status, 403, msg=body)
        self.assert_error_envelope(body)

        status, body = self.request("GET", "/api/v1/events/event-x", token=self.admin_token)
        self.assertEqual(status, 403, msg=body)

        # The legacy configured token is not an administrator session either.
        status, body = self.request(
            "POST",
            "/api/v1/heartbeat",
            {"instance_id": "instance-legacy", "session_id": "session-legacy"},
            token=LEGACY_ADMIN_TOKEN,
        )
        self.assertEqual(status, 401, msg=body)
        self.assert_error_envelope(body)

    def test_admin_summary_shape_and_shop_listing(self):
        summary = self.assert_status(
            self.request("GET", "/api/v1/admin/summary", token=self.admin_token), 200
        )
        self.assertEqual(summary.get("protocol_version"), "1.0")
        counts = summary.get("counts")
        self.assertIsInstance(counts, dict)
        for key in ("pending", "processing", "ready", "sent", "unknown"):
            self.assertIn(key, counts)
            self.assertIsInstance(counts[key], int)

        shops = self.assert_status(
            self.request("GET", "/api/v1/admin/shops", token=self.admin_token), 200
        )
        listed = {shop["shop_id"]: shop for shop in shops.get("shops", [])}
        self.assertEqual(set(listed), {"shop-a", "shop-b"})

    # ------------------------------------------------------------------
    # Shop / client isolation
    # ------------------------------------------------------------------
    def test_event_visibility_is_shop_and_client_scoped(self):
        self.enable_shop(shop_id="shop-a")
        lease_a = self.acquire(token=CLIENT_A_TOKEN)
        payload = self.make_event(lease_a)
        self.submit_event(lease_a, payload)
        self.wait_ready(lease_a, payload["event_id"])

        status, body = self.get_event(lease_a, payload["event_id"])
        self.assertEqual(status, 200, msg=body)
        self.assertEqual(body.get("shop_id"), "shop-a")
        self.assertEqual(body.get("client_id"), "client-a")

        lease_b = self.acquire(token=CLIENT_B_TOKEN)
        status, body = self.get_event(lease_b, payload["event_id"])
        self.assertEqual(status, 404, msg=body)

        admin_events = self.assert_status(
            self.request(
                "GET", "/api/v1/admin/events?shop_id=shop-a&limit=50", token=self.admin_token
            ),
            200,
        )
        self.assertEqual(
            [event["event_id"] for event in admin_events.get("events", [])],
            [payload["event_id"]],
        )
        # shop-b must not expose shop-a's event.
        other_shop = self.assert_status(
            self.request(
                "GET", "/api/v1/admin/events?shop_id=shop-b&limit=50", token=self.admin_token
            ),
            200,
        )
        self.assertEqual(other_shop.get("events"), [])

    def test_lease_contention_renewal_and_shop_scoping(self):
        instance_1 = self.uid("instance")
        session_1 = self.uid("session")
        first = self.heartbeat(CLIENT_A_TOKEN, instance_1, session_1)

        renewed = self.heartbeat(CLIENT_A_TOKEN, instance_1, session_1)
        self.assertEqual(renewed["generation"], first["generation"])
        self.assertGreaterEqual(
            float(renewed["expires_at"]), float(first["expires_at"])
        )

        status, body = self.request(
            "POST",
            "/api/v1/heartbeat",
            {"instance_id": self.uid("instance"), "session_id": self.uid("session")},
            token=CLIENT_A_TOKEN,
        )
        self.assertEqual(status, 409, msg=body)
        error = self.assert_error_envelope(body)
        self.assertEqual(error["code"], "lease_busy")

        # The other client belongs to another shop and is unaffected.
        self.heartbeat(CLIENT_B_TOKEN, self.uid("instance"), self.uid("session"))

    def test_generation_invalidation_on_session_change(self):
        instance_id = self.uid("instance")
        old_session = self.uid("session")
        new_session = self.uid("session")
        old = self.heartbeat(CLIENT_A_TOKEN, instance_id, old_session)
        new = self.heartbeat(CLIENT_A_TOKEN, instance_id, new_session)
        self.assertGreater(new["generation"], old["generation"])
        self.enable_shop(shop_id="shop-a")

        stale_lease = {
            "token": CLIENT_A_TOKEN,
            "instance_id": instance_id,
            "session_id": old_session,
            "generation": old["generation"],
        }
        status, body = self.request(
            "POST",
            "/api/v1/events",
            self.make_event(stale_lease),
            token=CLIENT_A_TOKEN,
        )
        self.assertEqual(status, 409, msg=body)

        old_generation_lease = {
            "token": CLIENT_A_TOKEN,
            "instance_id": instance_id,
            "session_id": new_session,
            "generation": old["generation"],
        }
        status, body = self.request(
            "POST",
            "/api/v1/events",
            self.make_event(old_generation_lease),
            token=CLIENT_A_TOKEN,
        )
        self.assertEqual(status, 409, msg=body)

        current_lease = {
            "token": CLIENT_A_TOKEN,
            "instance_id": instance_id,
            "session_id": new_session,
            "generation": new["generation"],
        }
        self.submit_event(current_lease, self.make_event(current_lease))

    # ------------------------------------------------------------------
    # Decision behaviour
    # ------------------------------------------------------------------
    def test_shops_are_disabled_by_default(self):
        shops = self.assert_status(
            self.request("GET", "/api/v1/admin/shops", token=self.admin_token), 200
        )
        by_id = {shop["shop_id"]: shop for shop in shops["shops"]}
        self.assertFalse(by_id["shop-a"]["settings"]["enabled"])
        self.assertFalse(by_id["shop-b"]["settings"]["enabled"])

        lease = self.acquire(token=CLIENT_B_TOKEN)
        payload = self.make_event(lease)
        self.submit_event(lease, payload)
        snapshot = self.wait_settled(lease, payload["event_id"])
        decision = snapshot.get("decision")
        self.assertIn(snapshot["state"], ("pending", "processing", "ready"))
        if snapshot["state"] == "ready":
            self.assertNotEqual((decision or {}).get("action"), "reply")
        else:
            self.assertIsNone(decision)

        status, body = self.request(
            "POST",
            f"/api/v1/events/{payload['event_id']}/claim",
            {
                "instance_id": lease["instance_id"],
                "session_id": lease["session_id"],
                "generation": lease["generation"],
                "attempt_id": self.uid("attempt"),
            },
            token=lease["token"],
        )
        self.assertEqual(status, 409, msg=body)

    def test_rule_reply_happy_path_with_claim_and_receipt(self):
        lease, payload, snapshot = self.ready_reply_event()

        decision = snapshot["decision"]
        self.assertEqual(decision["action"], "reply")
        self.assertEqual(decision["text"], RULE_REPLY)
        self.assertLessEqual(float(decision["expires_at"]), time.time() + 60.5)
        self.assertGreater(float(decision["expires_at"]), time.time())
        delivery = snapshot.get("delivery") or {}
        self.assertEqual(delivery.get("status"), "unclaimed")
        self.assertIsNone(delivery.get("attempt_id"))

        attempt_id = self.uid("attempt")
        before_claim = time.time()
        claimed = self.claim(lease, payload["event_id"], attempt_id)
        delivery = claimed.get("delivery") or {}
        self.assertEqual(delivery.get("status"), "claimed")
        self.assertEqual(delivery.get("attempt_id"), attempt_id)
        self.assertIsNotNone(delivery.get("claim_expires_at"))
        self.assertGreater(float(delivery["claim_expires_at"]), before_claim)
        self.assertLessEqual(float(delivery["claim_expires_at"]), time.time() + 10.5)

        platform_message_id = self.uid("platform-message")
        receipt_status, receipt_body = self.receipt(
            lease,
            payload["event_id"],
            attempt_id,
            "sent",
            platform_message_id=platform_message_id,
        )
        self.assertEqual(receipt_status, 200, msg=receipt_body)

        final = self.assert_status(self.get_event(lease, payload["event_id"]), 200)
        self.assertEqual(final["delivery"]["status"], "sent")
        self.assertEqual(final["delivery"]["platform_message_id"], platform_message_id)

        summary = self.assert_status(
            self.request("GET", "/api/v1/admin/summary", token=self.admin_token), 200
        )
        self.assertGreaterEqual(summary["counts"]["sent"], 1)

    def test_duplicate_event_id_is_idempotent(self):
        lease, payload, snapshot = self.ready_reply_event()

        status, body = self.request(
            "POST", "/api/v1/events", payload, token=lease["token"]
        )
        self.assertEqual(status, 202, msg=body)
        self.assertEqual(body.get("event_id"), payload["event_id"])
        self.assertEqual(body.get("created_at"), snapshot.get("created_at"))

        events = self.assert_status(
            self.request(
                "GET", "/api/v1/admin/events?shop_id=shop-a&limit=50", token=self.admin_token
            ),
            200,
        )
        matching = [
            event
            for event in events["events"]
            if event["event_id"] == payload["event_id"]
        ]
        self.assertEqual(len(matching), 1)

    def test_conflicting_event_id_is_rejected(self):
        lease = self.acquire()
        payload = self.make_event(lease)
        self.submit_event(lease, payload)

        conflicting = json.loads(json.dumps(payload))
        conflicting["context"]["messages"][0]["content"] = "不同内容的伪造冲突消息"
        status, body = self.request(
            "POST", "/api/v1/events", conflicting, token=lease["token"]
        )
        self.assertEqual(status, 409, msg=body)
        error = self.assert_error_envelope(body)
        self.assertEqual(error["code"], "event_conflict")

    def test_same_message_with_different_event_id_is_rejected(self):
        lease = self.acquire()
        first = self.make_event(lease, conversation_id="conversation-duplicate")
        self.submit_event(lease, first)

        duplicate = self.make_event(
            lease,
            conversation_id=first["conversation_id"],
            message_id=first["message_id"],
            context_revision=2,
        )
        status, body = self.request(
            "POST", "/api/v1/events", duplicate, token=lease["token"]
        )
        self.assertEqual(status, 409, msg=body)
        error = self.assert_error_envelope(body)
        self.assertEqual(error["code"], "message_duplicate")

    def test_incomplete_history_hands_off_without_send_permission(self):
        self.enable_shop(shop_id="shop-a")
        lease = self.acquire()
        payload = self.make_event(lease, history_complete=False)
        self.submit_event(lease, payload)
        snapshot = self.wait_ready(lease, payload["event_id"])
        self.assertEqual(snapshot["decision"]["action"], "handoff")

        status, body = self.request(
            "POST",
            f"/api/v1/events/{payload['event_id']}/claim",
            {
                "instance_id": lease["instance_id"],
                "session_id": lease["session_id"],
                "generation": lease["generation"],
                "attempt_id": self.uid("attempt"),
            },
            token=lease["token"],
        )
        self.assertEqual(status, 409, msg=body)

    def test_delayed_new_message_can_reply_but_future_clock_is_rejected(self):
        self.enable_shop(shop_id="shop-a")
        lease = self.acquire()

        stale = self.make_event(
            lease,
            conversation_id="conversation-stale",
            received_at=time.time() - 121,
        )
        self.submit_event(lease, stale)
        stale_snapshot = self.wait_ready(lease, stale["event_id"])
        self.assertEqual(stale_snapshot["decision"]["action"], "reply")
        self.claim(lease, stale["event_id"], self.uid("attempt"))

        future = self.make_event(
            lease,
            conversation_id="conversation-future",
            received_at=time.time() + 10,
        )
        self.submit_event(lease, future)
        future_snapshot = self.wait_settled(lease, future["event_id"])
        self.assertNotEqual(
            (future_snapshot.get("decision") or {}).get("action"), "reply"
        )

        for payload in (future,):
            status, body = self.request(
                "POST",
                f"/api/v1/events/{payload['event_id']}/claim",
                {
                    "instance_id": lease["instance_id"],
                    "session_id": lease["session_id"],
                    "generation": lease["generation"],
                    "attempt_id": self.uid("attempt"),
                },
                token=lease["token"],
            )
            self.assertEqual(status, 409, msg=body)

    # ------------------------------------------------------------------
    # Invalidation
    # ------------------------------------------------------------------
    def test_newer_context_revision_invalidates_older_reply(self):
        self.enable_shop(shop_id="shop-a")
        lease = self.acquire()
        conversation_id = "conversation-revision"

        old = self.make_event(
            lease, conversation_id=conversation_id, context_revision=1
        )
        self.submit_event(lease, old)
        old_snapshot = self.wait_ready(lease, old["event_id"])
        self.assertEqual(old_snapshot["decision"]["action"], "reply")

        new = self.make_event(
            lease, conversation_id=conversation_id, context_revision=2
        )
        self.submit_event(lease, new)
        new_snapshot = self.wait_ready(lease, new["event_id"])
        self.assertEqual(new_snapshot["decision"]["action"], "reply")

        status, body = self.request(
            "POST",
            f"/api/v1/events/{old['event_id']}/claim",
            {
                "instance_id": lease["instance_id"],
                "session_id": lease["session_id"],
                "generation": lease["generation"],
                "attempt_id": self.uid("attempt"),
            },
            token=lease["token"],
        )
        self.assertEqual(status, 409, msg=body)

    def test_settings_change_invalidates_older_reply(self):
        lease, payload, snapshot = self.ready_reply_event()
        self.assertEqual(snapshot["decision"]["action"], "reply")

        self.enable_shop(
            shop_id="shop-a",
            rules=[
                {
                    "id": "hours",
                    "contains": "营业时间",
                    "reply": "设置更新后的回复。",
                }
            ],
            system_prompt="更新后的系统提示。",
        )

        status, body = self.request(
            "POST",
            f"/api/v1/events/{payload['event_id']}/claim",
            {
                "instance_id": lease["instance_id"],
                "session_id": lease["session_id"],
                "generation": lease["generation"],
                "attempt_id": self.uid("attempt"),
            },
            token=lease["token"],
        )
        self.assertEqual(status, 409, msg=body)

    # ------------------------------------------------------------------
    # Delivery attempts and receipts
    # ------------------------------------------------------------------
    def test_only_one_send_attempt_per_event(self):
        lease, payload, _ = self.ready_reply_event()
        first_attempt = self.uid("attempt")
        claimed = self.claim(lease, payload["event_id"], first_attempt)
        self.assertEqual(claimed["delivery"]["attempt_id"], first_attempt)

        replayed = self.claim(lease, payload["event_id"], first_attempt)
        self.assertEqual(replayed["delivery"]["attempt_id"], first_attempt)

        status, body = self.request(
            "POST",
            f"/api/v1/events/{payload['event_id']}/claim",
            {
                "instance_id": lease["instance_id"],
                "session_id": lease["session_id"],
                "generation": lease["generation"],
                "attempt_id": self.uid("attempt"),
            },
            token=lease["token"],
        )
        self.assertEqual(status, 409, msg=body)

    def test_sent_receipt_requires_platform_message_id(self):
        lease, payload, _ = self.ready_reply_event()
        attempt_id = self.uid("attempt")
        self.claim(lease, payload["event_id"], attempt_id)

        for missing_value in (None, ""):
            with self.subTest(platform_message_id=missing_value):
                status, body = self.receipt(
                    lease, payload["event_id"], attempt_id, "sent"
                ) if missing_value is None else self.request(
                    "POST",
                    f"/api/v1/events/{payload['event_id']}/receipt",
                    {
                        "attempt_id": attempt_id,
                        "status": "sent",
                        "platform_message_id": missing_value,
                    },
                    token=lease["token"],
                )
                self.assertEqual(status, 400, msg=body)
                self.assert_error_envelope(body)

        valid = self.uid("platform-message")
        status, body = self.receipt(
            lease, payload["event_id"], attempt_id, "sent", platform_message_id=valid
        )
        self.assertEqual(status, 200, msg=body)
        final = self.assert_status(self.get_event(lease, payload["event_id"]), 200)
        self.assertEqual(final["delivery"]["status"], "sent")
        self.assertEqual(final["delivery"]["platform_message_id"], valid)

    def test_unknown_is_terminal_without_freezing_new_messages(self):
        lease, payload, _ = self.ready_reply_event()
        conversation_id = payload["conversation_id"]
        attempt_id = self.uid("attempt")
        self.claim(lease, payload["event_id"], attempt_id)

        status, body = self.receipt(
            lease, payload["event_id"], attempt_id, "unknown"
        )
        self.assertEqual(status, 200, msg=body)

        # Repeating the identical unknown receipt is allowed and idempotent.
        status, body = self.receipt(
            lease, payload["event_id"], attempt_id, "unknown"
        )
        self.assertEqual(status, 200, msg=body)

        # A later success report must not overwrite the unknown outcome.
        status, body = self.receipt(
            lease,
            payload["event_id"],
            attempt_id,
            "sent",
            platform_message_id=self.uid("platform-message"),
        )
        self.assertEqual(status, 409, msg=body)

        final = self.assert_status(self.get_event(lease, payload["event_id"]), 200)
        self.assertEqual(final["delivery"]["status"], "unknown")

        # A genuinely new message may reply without verifying the old unknown.
        new_event = self.make_event(
            lease,
            conversation_id=conversation_id,
            context_revision=2,
            content="请问营业时间是什么时候？",
        )
        self.submit_event(lease, new_event)
        snapshot = self.wait_ready(lease, new_event["event_id"])
        self.assertEqual(snapshot["decision"]["action"], "reply")

        status, body = self.request(
            "POST",
            f"/api/v1/events/{new_event['event_id']}/claim",
            {
                "instance_id": lease["instance_id"],
                "session_id": lease["session_id"],
                "generation": lease["generation"],
                "attempt_id": self.uid("attempt"),
            },
            token=lease["token"],
        )
        self.assertEqual(status, 200, msg=body)

        self.claim(lease, payload["event_id"], attempt_id, expected=409)

    # ------------------------------------------------------------------
    # Malformed input
    # ------------------------------------------------------------------
    def test_malformed_payloads_are_rejected(self):
        lease = self.acquire()
        valid = self.make_event(lease)

        missing_field = json.loads(json.dumps(valid))
        del missing_field["conversation_id"]
        status, body = self.request(
            "POST", "/api/v1/events", missing_field, token=lease["token"]
        )
        self.assertEqual(status, 400, msg=body)
        self.assert_error_envelope(body)

        empty_context = json.loads(json.dumps(valid))
        empty_context["event_id"] = self.uid("event")
        empty_context["context"]["messages"] = []
        status, body = self.request(
            "POST", "/api/v1/events", empty_context, token=lease["token"]
        )
        self.assertEqual(status, 400, msg=body)

        status, body = self.request(
            "POST", "/api/v1/events", raw=b"{not valid json", token=lease["token"]
        )
        self.assertEqual(status, 400, msg=body)
        self.assert_error_envelope(body)



    def test_admin_verification_http_auth_validation_and_snapshot(self):
        lease, payload, snapshot = self.ready_reply_event()
        event = payload["event_id"]
        path = f"/api/v1/admin/events/{event}/verify?shop_id=shop-a"
        body = {"outcome": "not_sent", "note": "已核对虚构平台记录"}
        self.assertIsNone(snapshot["delivery"]["verification"])
        self.claim(lease, event, "attempt")
        original = self.assert_status(self.receipt(lease, event, "attempt", "unknown"), 200)
        for token, status in ((None, 401), (CLIENT_A_TOKEN, 403), (CLIENT_B_TOKEN, 403), (LEGACY_ADMIN_TOKEN, 401)):
            self.assert_status(self.request("POST", path, body, token=token), status)
        self.assert_status(self.request("POST", path, {**body, "note": " "}, token=self.admin_token), 400)
        self.assert_status(self.request("POST", path.replace("shop-a", "shop-b"), body, token=self.admin_token), 404)
        self.assert_status(self.request("POST", path + "&shop_id=shop-b", body, token=self.admin_token), 400)
        result = self.assert_status(self.request("POST", path, body, token=self.admin_token), 200)
        self.assertEqual(result["delivery"]["status"], "unknown")
        self.assertEqual(result["delivery"]["attempt_id"], original["delivery"]["attempt_id"])
        self.assertEqual(result["delivery"]["verification"]["note"], body["note"])
        self.assertEqual(self.assert_status(self.get_event(lease, event), 200)["delivery"], result["delivery"])
        self.assert_status(self.get_event({"token": CLIENT_B_TOKEN}, event), 404)
        self.assert_status(self.request("POST", path, body, token=self.admin_token), 409)
        self.claim(lease, event, "attempt", expected=409)
        new = self.make_event(lease, context_revision=2)
        self.submit_event(lease, new)
        self.assertEqual(self.wait_ready(lease, new["event_id"])["decision"]["action"], "reply")
        self.claim(lease, new["event_id"], "new-attempt")
        self.assert_status(self.request("POST", "/api/v1/admin/logout", {}, token=self.admin_token), 200)
        self.assert_status(self.request("POST", path, body, token=self.admin_token), 401)

    def test_media_event_http_validation_and_large_body(self):
        import base64
        from unittest.mock import patch
        from test_multimodal import completion, CONFIG as MODEL_CONFIG
        self.enable_shop(mode="model")
        lease = self.acquire()
        payload = self.make_event(lease, kind="image", content="")
        data_url = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * 220000).decode()
        payload["context"]["messages"][-1]["attachments"] = [{"type": "image", "mime": "image/png", "data_url": data_url}]
        self.assertGreater(len(json.dumps(payload)), 262144)
        with patch.object(self.server.store, "model_config", return_value=MODEL_CONFIG), patch("backend.engine._post", return_value=completion()) as post:
            self.submit_event(lease, payload)
            self.assertEqual(self.wait_ready(lease, payload["event_id"])["decision"]["action"], "reply")
        self.assertEqual(post.call_args.args[1]["messages"][1]["content"][-1]["image_url"]["url"], data_url)
        malformed = self.make_event(lease, context_revision=2, kind="image")
        malformed["context"]["messages"][-1]["attachments"] = [{"type": "image", "mime": "image/jpeg", "data_url": data_url}]
        self.submit_event(lease, malformed, expected=400)
        import http.client
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.putrequest("POST", "/api/v1/events")
            connection.putheader("Content-Type", "application/json")
            connection.putheader("Content-Length", str(8 * 1024 * 1024 + 1))
            connection.putheader("Authorization", "Bearer " + lease["token"])
            connection.endheaders()
            self.assertEqual(connection.getresponse().status, 413)
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
