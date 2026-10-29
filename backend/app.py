"""Small standalone HTTP service; bind privately, publish only behind HTTPS."""
import copy
import hmac
import json
import os
import time
import uuid
import threading
from concurrent.futures import Future
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import TCPServer
from urllib.parse import parse_qs, urlsplit

from . import diagnostics, modelconfig, modelworker, vehicle_knowledge
from .auth import AdminAuth
from .content import MAX_EVENT_BYTES
from .engine import decide, decision, immediate_decision, test_slot
from .store import ApiError, Store, identifier, require

PROTOCOL_VERSION = "1.0"
STATIC = Path(__file__).parent / "static"
MODEL_CONCURRENCY = 2
# Routes an administrator may use while the initial default password is pending
# replacement. Every other /api/v1/admin route is refused before touching data.
FIRST_LOGIN_ROUTES = {
    ("/api/v1/admin/password", "POST"),
    ("/api/v1/admin/logout", "POST"),
}


def validate_config(config):
    require(isinstance(config, dict), "invalid_config")
    admin = config.get("admin_token")
    shops, clients = config.get("shops"), config.get("clients")
    require(isinstance(shops, list) and len(shops) > 0 and isinstance(clients, list), "invalid_config_lists")
    # Legacy administrator tokens never authenticate. Reserve the value so it
    # cannot accidentally become a client credential during migration.
    require(admin is None or isinstance(admin, str), "invalid_admin_token")
    shop_ids, client_ids, tokens = set(), set(), {admin} if admin else set()
    for shop in shops:
        require(isinstance(shop, dict) and identifier(shop.get("shop_id")) and shop["shop_id"] not in shop_ids, "invalid_shop_config")
        require(isinstance(shop.get("name"), str) and 0 < len(shop["name"]) <= 128, "invalid_shop_name")
        shop_ids.add(shop["shop_id"])
    for client in clients:
        require(isinstance(client, dict) and identifier(client.get("client_id")) and client["client_id"] not in client_ids, "invalid_client_config")
        require(client.get("shop_id") in shop_ids, "invalid_client_shop")
        token = client.get("token")
        require(isinstance(token, str) and len(token) >= 32 and token.isascii() and token not in tokens, "invalid_client_token")
        client_ids.add(client["client_id"])
        tokens.add(token)
    require(isinstance(config.get("model", {}), dict), "invalid_model_config")
    knowledge = config.get("vehicle_knowledge", {})
    require(isinstance(knowledge, dict) and set(knowledge) <= shop_ids,
            "invalid_vehicle_knowledge_config")
    require(all(isinstance(path, str) and Path(path).is_absolute()
                for path in knowledge.values()), "invalid_vehicle_knowledge_config")


def reject_constant(_):
    raise ValueError("non_finite_json")


def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate_json_key")
        obj[key] = value
    return obj


class Handler(BaseHTTPRequestHandler):
    server_version = "ClawNext/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_):
        # Request paths, bodies and credentials are not written to general logs.
        pass

    def _send(self, status, value, content_type="application/json; charset=utf-8"):
        self.response_status = status
        if isinstance(value, dict) and "event_id" in value and "shop_id" in value:
            diagnostics.emit("event_snapshot", event_ref=diagnostics.reference(value["shop_id"], value["event_id"]),
                             state=value.get("state"), delivery=value.get("delivery", {}).get("status"))
        body = json.dumps(value, ensure_ascii=False, allow_nan=False).encode() if isinstance(value, (dict, list)) else value
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(body)

    def _json(self):
        require(self.headers.get("Content-Type", "").split(";")[0].strip().lower() == "application/json", "json_required", 415)
        require(not self.headers.get("Transfer-Encoding"), "transfer_encoding_unsupported")
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError(400, "invalid_content_length") from None
        limit = MAX_EVENT_BYTES if self.command == "POST" and urlsplit(self.path).path == "/api/v1/events" else 262144
        require(0 < size <= limit, "body_too_large" if size > limit else "body_required", 413 if size > limit else 400)
        try:
            value = json.loads(self.rfile.read(size), parse_constant=reject_constant, object_pairs_hook=unique_object)
        except (ValueError, UnicodeError):
            raise ApiError(400, "invalid_json") from None
        require(isinstance(value, dict), "object_required")
        return value

    def _identity(self):
        header = self.headers.get("Authorization", "")
        require(header.startswith("Bearer ") and len(header) <= 1024 and header.isascii(), "unauthorized", 401)
        token = header[7:]
        config = self.server.config
        for client in config["clients"]:
            if hmac.compare_digest(token, client["token"]):
                return {"role": "client", "client_id": client["client_id"], "shop_id": client["shop_id"]}
        return self.server.auth.identity(token)

    def _model_test(self, store):
        """Authorize and snapshot under the auth lock, then call the provider outside it."""
        with self.server.auth.lock:
            identity = self._identity()
            require(identity["role"] == "admin", "admin_required", 403)
            require(not identity["must_change_password"], "admin_password_change_required", 403)
            payload = self._json()
            require(isinstance(payload, dict) and set(payload) == {"slot", "version"}, "invalid_model_test")
            slot, version = payload.get("slot"), payload.get("version")
            require(slot in modelconfig.SLOTS, "invalid_model_slot")
            require(type(version) is int and version >= 0, "invalid_model_test")
            config = store.model_config(self.server.config.get("model", {}))
            # A stale page must never test (or display) a configuration that changed.
            require(version == config["version"], "model_config_changed", 409)
            snapshot = copy.deepcopy(config)
        result = test_slot(snapshot, slot)
        current = store.model_config(self.server.config.get("model", {}))
        if current["version"] != snapshot["version"]:
            result = {**result, "ok": False, "reason": "stale_test_result", "version": snapshot["version"]}
        return self._send(200, result)

    def _admin_route(self, path, method, parts, store):
        if path == "/api/v1/admin/model/test" and method == "POST":
            return self._model_test(store)
        # Serialize authorization and administrative mutations with password
        # changes, so a revoked session cannot race a settings update.
        with self.server.auth.lock:
            identity = self._identity()
            require(identity["role"] == "admin", "admin_required", 403)
            # A session still using the initial default password may only read
            # its own identity, log out or set a new password.
            require(not identity["must_change_password"] or (path, method) in FIRST_LOGIN_ROUTES,
                    "admin_password_change_required", 403)
            token = self.headers["Authorization"][7:]
            if path == "/api/v1/admin/model" and method in ("GET", "PUT"):
                fallback = self.server.config.get("model", {})
                if method == "PUT":
                    config = store.update_model_config(self._json(), fallback)
                else:
                    config = store.model_config(fallback)
                return self._send(200, modelconfig.public_config(config, os.environ))
            if path == "/api/v1/admin/logout" and method == "POST":
                self._json()
                self.server.auth.logout(token)
                return self._send(200, {"ok": True})
            if path == "/api/v1/admin/password" and method == "POST":
                self.server.auth.change_password(token, self._json(), self.client_address[0])
                return self._send(200, {"ok": True, "reauthenticate": True})
            if path == "/api/v1/admin/summary" and method == "GET":
                return self._send(200, store.summary())
            if path == "/api/v1/admin/shops" and method == "GET":
                return self._send(200, {"shops": store.shops()})
            if path == "/api/v1/admin/events" and method == "GET":
                query = parse_qs(urlsplit(self.path).query)
                try:
                    limit = int(query.get("limit", ["50"])[0])
                except ValueError:
                    raise ApiError(400, "invalid_limit") from None
                require(1 <= limit <= 200, "invalid_limit")
                return self._send(200, {"events": store.events(query.get("shop_id", [None])[0], limit)})
            if len(parts) == 6 and parts[3] == "events" and identifier(parts[4]) and parts[5] == "verify" and method == "POST":
                query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                shops = query.get("shop_id", [None])
                require(len(shops) == 1 and (shops[0] is None or identifier(shops[0])), "invalid_shop_id")
                return self._send(200, store.verify(identity, parts[4], self._json(), shops[0]))
            if len(parts) == 6 and parts[3] == "shops" and parts[5] == "settings" and method == "PUT":
                return self._send(200, store.update_settings(parts[4], self._json()))
            raise ApiError(404, "not_found")

    def _route(self):
        parsed = urlsplit(self.path)
        path, method = parsed.path, self.command
        if path == "/health" and method == "GET":
            return self._send(200, {"service": "claw-next", "protocol_version": PROTOCOL_VERSION, "status": "ok"})
        static = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"), "/style.css": ("style.css", "text/css; charset=utf-8")}
        if path in static and method == "GET":
            name, mime = static[path]
            require((STATIC / name).is_file(), "ui_not_installed", 503)
            return self._send(200, (STATIC / name).read_bytes(), mime)
        require(path.startswith("/api/v1/"), "not_found", 404)
        if path == "/api/v1/admin/login" and method == "POST":
            result = self.server.auth.login(self._json(), self.client_address[0])
            return self._send(200, {**result, "protocol_version": PROTOCOL_VERSION})
        identity, store = self._identity(), self.server.store
        if path == "/api/v1/me" and method == "GET":
            return self._send(200, {**identity, "protocol_version": PROTOCOL_VERSION})
        parts = path.strip("/").split("/")
        if len(parts) >= 3 and parts[2] == "admin":
            return self._admin_route(path, method, parts, store)
        require(identity["role"] == "client", "client_required", 403)
        if path == "/api/v1/heartbeat" and method == "POST":
            return self._send(200, store.heartbeat(identity, self._json()))
        if path == "/api/v1/events" and method == "POST":
            value = store.enqueue(identity, self._json())
            self.server.wake.set()
            return self._send(202, value)
        if len(parts) in (4, 5) and parts[2] == "events" and identifier(parts[3]):
            if len(parts) == 4 and method == "GET":
                return self._send(200, store.get(identity, parts[3]))
            if len(parts) == 5 and method == "POST" and parts[4] in ("claim", "receipt", "cancel"):
                action = getattr(store, parts[4])
                value = action(identity, parts[3], self._json())
                if parts[4] == "cancel":
                    self.server.wake.set()
                return self._send(200, value)
        raise ApiError(404, "not_found")

    def _handle(self):
        started = time.monotonic()
        self.response_status = None
        words = {"api", "v1", "admin", "events", "shops", "model", "test", "login", "logout",
                 "password", "summary", "settings", "heartbeat", "me", "claim", "receipt", "cancel", "verify", "health"}
        route = "/".join(part if part in words else "*" for part in urlsplit(self.path).path.split("/")[:8])
        with diagnostics.scope(self.server.diagnostics, request_id=uuid.uuid4().hex, route=route, method=self.command):
            try:
                self._handle_request()
            except (BrokenPipeError, ConnectionResetError, TimeoutError) as exc:
                diagnostics.failure("response_disconnected", exc)
            finally:
                diagnostics.emit("request_finished", status=self.response_status,
                                 duration_ms=int((time.monotonic() - started) * 1000))

    def _handle_request(self):
        try:
            self._route()
        except ApiError as exc:
            diagnostics.emit("request_rejected", code=exc.code, status=exc.status)
            self._send(exc.status, {"error": {"code": exc.code, "message": str(exc)}})
        except (BrokenPipeError, ConnectionResetError, TimeoutError) as exc:
            diagnostics.failure("request_disconnected", exc)
        except Exception as exc:
            diagnostics.failure("request_internal_error", exc)
            self._send(500, {"error": {"code": "internal_error", "message": "Request failed; check service health."}})

    do_GET = do_POST = do_PUT = do_DELETE = do_OPTIONS = _handle


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self):
        # HTTPServer reverse-resolves the bound address, which can stall startup
        # on macOS. This service only needs the actual listening address/port.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def __init__(self, config, data_dir, host, port, startup_check=None):
        validate_config(config)
        super().__init__((host, port), Handler)
        self.config = config
        try:
            self.vehicle_catalogs = {shop: vehicle_knowledge.load_directory(path)
                                     for shop, path in config.get("vehicle_knowledge", {}).items()}
            self.store = Store(data_dir, config["shops"])
            if startup_check is not None:
                startup_check()
            self.auth = AdminAuth(data_dir)
            self.diagnostics = diagnostics.Diagnostics(data_dir)
            self.diagnostics.write("service_started")
        except Exception:
            if hasattr(self, "auth"):
                self.auth.close()
            if hasattr(self, "store"):
                self.store.close()
            super().server_close()
            raise
        self.stop, self.wake = threading.Event(), threading.Event()
        self.model_workers = {}
        self.worker = threading.Thread(target=self._work, name="claw-next-decisions", daemon=True)
        self.worker.start()

    def _work(self):
        with diagnostics.scope(self.diagnostics):
            try:
                self._work_loop()
            except Exception as exc:
                diagnostics.failure("worker_stopped_unexpectedly", exc)

    def _work_loop(self):
        last_shop = ""
        while not self.stop.is_set():
            self.wake.clear()
            self.store.expire_deadlines()
            for shop, (worker, future, job, started) in list(self.model_workers.items()):
                if not worker.is_alive():
                    if not future.done():
                        raise RuntimeError("model_worker_stopped")
                    self._finish_job(job, future.result(), started)
                    del self.model_workers[shop]

            immediate, model_config = None, None

            def available(job):
                nonlocal immediate, model_config
                try:
                    immediate = immediate_decision(job)
                except Exception:
                    immediate = decision("handoff", "decision_internal_error")
                if immediate is not None:
                    return True
                if len(self.model_workers) >= MODEL_CONCURRENCY or job["shop_id"] in self.model_workers:
                    return False
                # next_job invokes this while holding the same lock as its job snapshot.
                model_config = self.store.model_config(self.config.get("model", {}))
                catalog = self.vehicle_catalogs.get(job["shop_id"])
                if catalog is not None:
                    # Local catalog selection comes from server configuration and
                    # authenticated shop ownership, never from submitted context.
                    job["vehicle_knowledge"] = catalog.lookup(
                        job["payload"]["context"]["messages"][-1]["content"])
                return True

            job = self.store.next_job(accept=available, after_shop=last_shop)
            if self.stop.is_set():
                break
            if job:
                last_shop = job["shop_id"]
                started = time.monotonic()
                if immediate is not None:
                    with diagnostics.scope(self.diagnostics, event_ref=diagnostics.reference(job["shop_id"], job["event_id"])):
                        diagnostics.emit("decision_started")
                    self._finish_job(job, immediate, started)
                else:
                    # No executor backlog: excess work stays durable and pending in SQLite.
                    future = Future()
                    worker = threading.Thread(target=self._model_work, args=(job, model_config, future),
                                              name="claw-next-model", daemon=True)
                    worker.start()
                    self.model_workers[job["shop_id"]] = (worker, future, job, started)
            else:
                self.wake.wait(0.25)

    def _model_work(self, job, model_config, future):
        with diagnostics.scope(self.diagnostics, event_ref=diagnostics.reference(job["shop_id"], job["event_id"])):
            diagnostics.emit("decision_started")
            try:
                if job.get("deadline_monotonic") is not None:
                    result = modelworker.bounded_decide(
                        job, model_config, lambda: self.store.job_is_active(job), self.stop)
                else:
                    result = decide(job, model_config)
            except Exception as exc:
                diagnostics.failure("decision_internal_error", exc)
                result = decision("handoff", "decision_internal_error")
            future.set_result(result)
        self.wake.set()

    def _finish_job(self, job, result, started):
        with diagnostics.scope(self.diagnostics, event_ref=diagnostics.reference(job["shop_id"], job["event_id"])):
            result = self.store.finish(job, result)
            # Model explanations and rule IDs may contain private text.
            reason = result["reason"].split(":", 1)[0]
            diagnostics.emit("decision_finished", action=result["action"], reason=reason,
                             duration_ms=int((time.monotonic() - started) * 1000))

    def server_close(self):
        super().server_close()
        if hasattr(self, "stop"):
            self.stop.set()
            self.wake.set()
            deadline = time.monotonic() + 25
            self.worker.join(timeout=max(0, deadline - time.monotonic()))
            if not self.worker.is_alive():
                workers = [item[0] for item in self.model_workers.values()]
                for worker in workers:
                    worker.join(timeout=max(0, deadline - time.monotonic()))
                if any(worker.is_alive() for worker in workers):
                    return
                for _, future, job, started in self.model_workers.values():
                    if future.done():
                        self._finish_job(job, future.result(), started)
                self.model_workers.clear()
                self.auth.close()
                self.store.close()
                self.diagnostics.write("service_stopped")
                self.diagnostics.close()


def create_server(config, data_dir, host="127.0.0.1", port=0, startup_check=None):
    return Server(config, data_dir, host, port, startup_check=startup_check)
