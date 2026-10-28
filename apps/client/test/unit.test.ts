import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { BackendClient, BackendError, TransportError } from "../src/core/backend.js";
import { ConfigStore } from "../src/core/configStore.js";
import { IPC_CHANNELS, IpcValidationError, validateIpc, validateToken } from "../src/core/ipc.js";
import { Journal, JournalCorruptError, describeRecord } from "../src/core/journal.js";
import { logRef } from "../src/core/runtime.js";
import { normalizeBackendUrl, parseMe } from "../src/core/protocol.js";
import { APP_CSP, APP_WEB_PREFERENCES, PLATFORM_WEB_PREFERENCES, isAllowedPlatformUrl, isPathSafeShopId, partitionFor } from "../src/core/security.js";
import { bindShopIdentity } from "../src/core/shopIdentity.js";
import { messageStatus } from "../src/core/view.js";
import { FileLogger } from "../src/main/logger.js";
import { tempDir } from "./helpers.js";

const CLIENT_ROOT = path.resolve(__dirname, "..", "..");

describe("后台地址与协议", () => {
  test("远程只允许 HTTPS，回环可用 HTTP", () => {
    assert.equal(normalizeBackendUrl("https://claw.example.com/base/"), "https://claw.example.com/base");
    assert.equal(normalizeBackendUrl("http://127.0.0.1:18880"), "http://127.0.0.1:18880");
    assert.equal(normalizeBackendUrl("http://localhost:18880/"), "http://localhost:18880");
    for (const bad of ["http://example.com", "http://192.168.1.2:18880", "https://u:p@example.com", "https://example.com/?token=x", "https://example.com/#a", "ftp://example.com", "not a url"]) {
      assert.throws(() => normalizeBackendUrl(bad), bad);
    }
  });

  test("不支持的协议主版本、非 client 角色被拒绝", () => {
    assert.throws(() => parseMe({ role: "client", client_id: "c", shop_id: "s", protocol_version: "2.0" }), /protocol_unsupported/);
    assert.throws(() => parseMe({ role: "admin", protocol_version: "1.0" }), /role_not_client/);
    assert.equal(parseMe({ role: "client", client_id: "c", shop_id: "s", protocol_version: "1.0" }).shop_id, "s");
  });

  test("口令只放在 Authorization 头，不进 URL；拒绝跟随重定向", async () => {
    const token = "t".repeat(40);
    const seen: { url: string; init: RequestInit }[] = [];
    const client = new BackendClient("http://127.0.0.1:1", token, (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ role: "client", client_id: "c", shop_id: "s", protocol_version: "1.0" }), { status: 200 });
    }) as unknown as typeof fetch);
    await client.me();
    assert.equal(seen.length, 1);
    assert.ok(!seen[0].url.includes(token));
    assert.equal((seen[0].init.headers as Record<string, string>).Authorization, `Bearer ${token}`);
    assert.equal(seen[0].init.redirect, "error");
  });

  test("区分后台明确错误与传输不确定", async () => {
    const http409 = new BackendClient("http://127.0.0.1:1", "t".repeat(40), (async () => new Response(JSON.stringify({ error: { code: "lease_busy", message: "x" } }), { status: 409 })) as unknown as typeof fetch);
    await assert.rejects(http409.heartbeat("i", "s"), (e: unknown) => e instanceof BackendError && e.code === "lease_busy");
    const down = new BackendClient("http://127.0.0.1:1", "t".repeat(40), (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    await assert.rejects(down.heartbeat("i", "s"), (e: unknown) => e instanceof TransportError);
  });
});

describe("IPC 参数校验", () => {
  test("未知通道与多余字段被拒绝", () => {
    assert.throws(() => validateIpc("fs:read", {}), IpcValidationError);
    assert.throws(() => validateIpc("shop:connect", { shop_id: "a", extra: 1 }), /unexpected_field/);
    assert.throws(() => validateIpc("shop:connect", { shop_id: "../a" }), /invalid_shop_id/);
    assert.throws(() => validateIpc("shop:setMode", { shop_id: "a", mode: "turbo" }), /invalid_mode/);
    assert.throws(() => validateIpc("conv:takeover", { shop_id: "a", conversation_id: "c", on: "yes" }), /invalid_on/);
    assert.throws(() => validateIpc("sim:action", { shop_id: "a", action: "rm_rf", conversation_id: null, value: null }), /invalid_action/);
    assert.throws(() => validateIpc("sim:message", { shop_id: "a", conversation_id: "c", content: "x".repeat(2001), kind: "text", stable_id: true }), /invalid_content/);
  });

  test("店铺配置：远程 HTTP 地址被拒绝", () => {
    const shop = { shop_id: "s", display_name: "店", backend_url: "http://example.com", platform_shop_id: "p", adapter: "mock" };
    assert.throws(() => validateIpc("shop:save", { shop }), /backend_url_requires_https/);
    assert.equal((validateIpc("shop:save", { shop: { ...shop, backend_url: "https://example.com/" } }) as any).shop.backend_url, "https://example.com");
  });

  test("口令格式", () => {
    assert.throws(() => validateToken("short"));
    assert.throws(() => validateToken("a".repeat(31) + " "));
    assert.equal(validateToken("a".repeat(40)), "a".repeat(40));
  });

  test("预加载脚本的通道清单与主进程一致", () => {
    const src = fs.readFileSync(path.join(CLIENT_ROOT, "src", "preload", "preload.ts"), "utf8");
    const listed = [...src.matchAll(/"([a-z]+:[A-Za-z]+)"/g)].map((m) => m[1]).filter((c) => c !== "state:changed");
    assert.deepEqual([...listed].sort(), [...IPC_CHANNELS].sort());
  });
});

describe("安全配置", () => {
  test("渲染页面与平台登录窗口都没有 Node 能力", () => {
    for (const prefs of [APP_WEB_PREFERENCES, PLATFORM_WEB_PREFERENCES]) {
      assert.equal(prefs.contextIsolation, true);
      assert.equal(prefs.nodeIntegration, false);
      assert.equal(prefs.sandbox, true);
      assert.equal(prefs.webviewTag, false);
    }
    assert.match(APP_CSP, /connect-src 'none'/);
    const html = fs.readFileSync(path.join(CLIENT_ROOT, "src", "renderer", "index.html"), "utf8");
    assert.ok(html.includes(APP_CSP), "index.html CSP 与常量一致");
  });

  test("平台窗口导航白名单", () => {
    assert.ok(isAllowedPlatformUrl("https://mms.pinduoduo.com/login"));
    assert.ok(!isAllowedPlatformUrl("http://mms.pinduoduo.com/"));
    assert.ok(!isAllowedPlatformUrl("https://pinduoduo.com.evil.example/"));
    assert.ok(!isAllowedPlatformUrl("https://evil-pinduoduo.com/"));
    assert.ok(!isAllowedPlatformUrl("file:///etc/passwd"));
  });

  test("分区键来自稳定 shop_id", () => {
    assert.equal(partitionFor("shop-a"), "persist:claw-next-shop-shop-a");
    assert.throws(() => partitionFor("店铺 1"));
  });

  test("渲染脚本不使用 innerHTML", () => {
    const src = fs.readFileSync(path.join(CLIENT_ROOT, "src", "renderer", "app.ts"), "utf8");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(/.test(src));
  });
});

describe("本地日志", () => {
  test("崩溃留下的半行被截掉，之前的记录保留", () => {
    const dir = tempDir("claw-next-journal-");
    const j = new Journal(dir);
    j.addMessage("c1", { id: "m1", stable: true, role: "buyer", kind: "text", content: "虚构消息", created_at: 1, received_at: 1, live: true, session_id: "s" });
    j.bumpRevision("c1", "t");
    j.close();
    const original = fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8");
    fs.appendFileSync(path.join(dir, "journal.jsonl"), '{"t":"rev","conversation_id":"c1","rev');
    const k = new Journal(dir);
    assert.equal(fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8"), original);
    assert.equal(k.conversation("c1").revision, 1);
    assert.equal(k.conversation("c1").messages.length, 1);
    assert.equal(k.conversation("c1").messages[0].content, "虚构消息");
    k.bumpRevision("c1", "t");
    k.close();
    const reopened = new Journal(dir);
    assert.equal(reopened.conversation("c1").revision, 2);
    assert.equal(reopened.conversation("c1").messages[0].content, "虚构消息");
    reopened.close();
  });

  test("中间行损坏拒绝启动，避免丢失发送证据", () => {
    const dir = tempDir("claw-next-journal-");
    fs.writeFileSync(path.join(dir, "journal.jsonl"), 'garbage\n{"t":"rev","conversation_id":"c1","revision":1,"reason":"x"}\n');
    assert.throws(() => new Journal(dir), JournalCorruptError);
  });

  test("关闭后拒绝写入", () => {
    const j = new Journal(tempDir("claw-next-journal-"));
    j.close();
    assert.throws(() => j.bumpRevision("c1", "t"), /journal_closed/);
  });
});

describe("配置与显示", () => {
  test("店铺配置文件不含口令字段", () => {
    const dir = tempDir("claw-next-config-");
    const store = new ConfigStore(dir);
    store.upsert({ shop_id: "s", display_name: "店", backend_url: "http://127.0.0.1:18880", platform_shop_id: "p", adapter: "mock", mode: "auto" });
    const raw = fs.readFileSync(path.join(dir, "shops.json"), "utf8");
    assert.ok(!/token/i.test(raw));
    assert.equal(new ConfigStore(dir).get("s")?.mode, "auto");
  });

  test("handoff 显示为建议，并说明平台未执行转接", () => {
    const status = messageStatus(
      { id: "m", stable: true, role: "buyer", kind: "text", content: "x", created_at: 1, received_at: 1, live: true, session_id: "s" },
      {
        event_id: "e", conversation_id: "c", message_id: "m", instance_id: "i", session_id: "s", generation: 1, context_revision: 1, body: "{}", history_complete: true, text_only: true,
        stage: "submitted", error: null, blocked: null, attempt: null,
        snapshot: { event_id: "e", shop_id: "s", client_id: "c", conversation_id: "c", message_id: "m", context_revision: 1, session_id: "s", generation: 1, state: "ready", created_at: 1, decision: { action: "handoff", text: "", reason: "no_matching_rule", expires_at: 1 }, delivery: { status: "unclaimed", attempt_id: null, platform_message_id: null } },
      },
      undefined,
    );
    assert.equal(status?.label, "建议交人工");
    assert.match(status?.reason ?? "", /平台未执行转接/);
  });
});

describe("诊断日志", () => {
  test("日志文件：按天命名、权限 600、密钥类字段被隐去", () => {
    const dir = tempDir("claw-next-log-");
    const logger = new FileLogger(dir);
    logger.write("INFO", 'backend request token=abc123 Authorization: Bearer xyz "password":"p1"');
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^client-\d{4}-\d{2}-\d{2}\.log$/);
    const file = path.join(dir, files[0]);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const text = fs.readFileSync(file, "utf8");
    assert.ok(!text.includes("abc123") && !text.includes("xyz") && !text.includes("p1"));
    assert.match(text, / INFO backend request token=\[已隐去\]/);
  });

  test("流程摘要：记录状态与原因，不含消息正文；重复判断快照不重复记录", () => {
    const dir = tempDir("claw-next-journal-log-");
    const j = new Journal(dir);
    const lines: string[] = [];
    const refs = { event: (id: string) => logRef(["123", id]), conv: (id: string) => logRef(["123", "conversation", id]).slice(0, 12) };
    j.onRecord = (rec, prev) => {
      const l = describeRecord(rec, prev, refs);
      if (l) lines.push(l);
    };
    j.addMessage("2000000000001", { id: "3000000000001", stable: true, role: "buyer", kind: "text", content: "虚构的秘密正文", created_at: 1, received_at: 1, live: true, session_id: "s" });
    j.note("2000000000001", "3000000000001", "history_sync");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^message conv=[0-9a-f]{12} id=…000001 role=buyer kind=text live=true stable=true$/);
    assert.match(lines[1], /reason=history_sync/);
    assert.ok(lines.every((l) => !l.includes("秘密") && !l.includes("2000000000001")));
    j.close();
  });
});

test("日志关联号与后台一致：sha256(紧凑 JSON 数组) 前 24 位，非 ASCII 不转义", () => {
  assert.equal(logRef(["123", "ev-1"]), "be2605612ddd7c52053eee8c");
  assert.equal(logRef(["店铺", "ev-2"]), "213b8143f7e7e59e0ee94f3d");
});

test("店铺编号用作路径前拒绝 . 与 ..", () => {
  for (const bad of [".", "..", "..."]) {
    assert.equal(isPathSafeShopId(bad), false);
    assert.throws(() => partitionFor(bad));
    assert.throws(() => validateIpc("shop:connect", { shop_id: bad }), IpcValidationError);
  }
  assert.equal(isPathSafeShopId("shop.1"), true);
});

test("同一店铺编号的本地数据不能换平台身份复用", () => {
  const dir = path.join(tempDir("claw-identity-"), "shops", "s1");
  bindShopIdentity(dir, { adapter: "pdd", platform_shop_id: "p1" });
  bindShopIdentity(dir, { adapter: "pdd", platform_shop_id: "p1" });
  assert.throws(() => bindShopIdentity(dir, { adapter: "pdd", platform_shop_id: "p2" }), /shop_data_identity_mismatch/);
  assert.throws(() => bindShopIdentity(dir, { adapter: "mock", platform_shop_id: "p1" }), /shop_data_identity_mismatch/);
});

test("确认完整的位置写入本地日志，重启后仍在", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-journal-"));
  const j = new Journal(dir);
  j.markComplete("buyer-1", "m-1");
  j.markComplete("buyer-1", "m-1");
  j.close();
  const again = new Journal(dir);
  assert.equal(again.conversation("buyer-1").complete_through, "m-1");
  assert.equal(fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8").trim().split("\n").length, 1);
  again.close();
});

