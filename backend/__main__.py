import argparse
import json
import os
import secrets
from pathlib import Path

from .app import create_server


def main():
    parser = argparse.ArgumentParser(description="Claw-Next independent decision backend")
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init", help="Create private demo configuration, without enabling replies")
    init.add_argument("--config", default="var/config.json")
    serve = sub.add_parser("serve", help="Start backend and management UI")
    serve.add_argument("--config", default="var/config.json")
    serve.add_argument("--data-dir", default="var/data")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=18880)
    serve.add_argument("--allow-remote", action="store_true", help="Explicitly allow non-loopback binding behind a private HTTPS proxy")
    args = parser.parse_args()
    path = Path(args.config).resolve()
    if args.command == "init":
        path.parent.mkdir(parents=True, exist_ok=True)
        config = {"shops": [{"shop_id": "demo-shop", "name": "演示店铺"}], "clients": [{"client_id": "demo-client", "shop_id": "demo-shop", "token": secrets.token_urlsafe(32)}], "model": {"base_url": "", "model": "", "api_key_env": "CLAW_NEXT_MODEL_API_KEY"}}
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(config, file, ensure_ascii=False, indent=2)
        print(f"Private demo configuration created: {path}\nReplies remain disabled. Tokens are not printed.")
        return
    if args.host not in ("127.0.0.1", "localhost", "::1") and not args.allow_remote:
        parser.error("Non-loopback binding requires --allow-remote and a private HTTPS reverse proxy.")
    with path.open(encoding="utf-8-sig") as file:
        config = json.load(file)
    server = create_server(config, Path(args.data_dir).resolve(), args.host, args.port)
    print(f"Claw-Next management UI: http://{args.host}:{server.server_address[1]}\nProtocol: 1.0; data: {Path(args.data_dir).resolve()}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
