"""A local synthetic OpenAI-compatible provider for tests.

Only loopback sockets are used.  No external model, credential or network
service is contacted.  Behaviour is consumed one item per request from a queue
so a test can script "primary fails, backup succeeds" exactly.
"""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DECISION_REPLY = {"action": "reply", "text": "合成测试回复", "reason": "synthetic"}


def completion(content):
    """A 200 response whose message content is ``content`` (a string)."""
    return {"status": 200, "content": content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)}


def decision(action="reply", text="合成测试回复", reason="synthetic"):
    return completion({"action": action, "text": text if action == "reply" else "", "reason": reason})


def http_error(status, headers=None):
    return {"status": status, "content": json.dumps({"error": {"message": "synthetic provider error"}}),
            "headers": headers or {}}


def redirect(location):
    return {"status": 302, "content": "", "headers": {"Location": location}}


def bad_shape():
    return {"status": 200, "raw": json.dumps({"choices": []})}


def invalid_content():
    return completion("this is not a JSON decision")


def timeout(delay=1.5):
    return {"status": 200, "content": json.dumps(DECISION_REPLY), "delay": delay}


class SyntheticProvider:
    def __init__(self):
        self.requests = []
        self.behaviours = []
        self.default = decision()
        self.lock = threading.Lock()
        self._stopped = False
        provider = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "SyntheticProvider/1.0"

            def log_message(self, *_):
                pass

            def do_POST(self):
                try:
                    size = int(self.headers.get("Content-Length", "0"))
                    raw = self.rfile.read(size)
                except (ValueError, OSError):
                    return
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = None
                with provider.lock:
                    provider.requests.append({"path": self.path, "headers": dict(self.headers), "body": body})
                    behaviour = provider.behaviours.pop(0) if provider.behaviours else provider.default
                if behaviour.get("delay"):
                    time.sleep(behaviour["delay"])
                payload = behaviour.get("raw")
                if payload is None:
                    payload = json.dumps({"choices": [{"message": {"content": behaviour.get("content", "")}}]})
                data = payload.encode()
                try:
                    self.send_response(behaviour.get("status", 200))
                    self.send_header("Content-Type", "application/json")
                    for name, value in (behaviour.get("headers") or {}).items():
                        self.send_header(name, value)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass

            def do_GET(self):
                self.send_response(405)
                self.send_header("Content-Length", "0")
                self.end_headers()

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, name="synthetic-provider", daemon=True)

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        if self._stopped:
            return
        self._stopped = True
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    @property
    def port(self):
        return self.httpd.server_address[1]

    @property
    def base_url(self):
        return "http://127.0.0.1:" + str(self.port) + "/v1"

    def queue(self, *behaviours):
        with self.lock:
            self.behaviours.extend(behaviours)

    def header(self, index, name):
        with self.lock:
            return self.requests[index]["headers"].get(name)

    def body(self, index=-1):
        with self.lock:
            return self.requests[index]["body"]

    def count(self):
        with self.lock:
            return len(self.requests)
