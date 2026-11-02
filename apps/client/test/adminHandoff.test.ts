import assert from "node:assert/strict";
import { test } from "node:test";
import { adminFailureOf, adminOpenText, adminPageUrl, isHandoffTicket, isLoopbackBackend, pickAdminShop } from "../src/core/adminHandoff.js";
import { BackendClient, BackendError, TransportError } from "../src/core/backend.js";
import { validateIpc } from "../src/core/ipc.js";

// #62 客户端一键打开后台管理：全部为虚构地址、口令与票据。
const TICKET = "fixture_ticket_0123456789abcdefABCDEF-_";
const TOKEN = "fixture-client-token-0123456789abcdef0123456789";

test("只有本机后台才换票据；地址不合法按非本机处理", () => {
  assert.equal(isLoopbackBackend("http://127.0.0.1:8765"), true);
  assert.equal(isLoopbackBackend("http://localhost:8765/"), true);
  assert.equal(isLoopbackBackend("http://[::1]:8765"), true);
  assert.equal(isLoopbackBackend("https://admin.example.com"), false);
  assert.equal(isLoopbackBackend("http://192.168.1.5:8765"), false);
  assert.equal(isLoopbackBackend("not a url"), false);
});

test("票据只放在 # 后面；格式不符的票据不拼进地址", () => {
  assert.equal(adminPageUrl("http://127.0.0.1:8765/", TICKET), `http://127.0.0.1:8765/#handoff=${TICKET}`);
  assert.equal(adminPageUrl("http://127.0.0.1:8765", null), "http://127.0.0.1:8765/");
  assert.equal(adminPageUrl("http://127.0.0.1:8765", "bad ticket&x=1"), "http://127.0.0.1:8765/");
  assert.equal(isHandoffTicket("short"), false);
  assert.equal(isHandoffTicket("a".repeat(129)), false);
  assert.equal(isHandoffTicket(TICKET), true);
});

test("选店铺：优先选中的且有口令的，其次第一个有口令的；都没有为 null", () => {
  const configs = [
    { shop_id: "a", backend_url: "http://127.0.0.1:1" },
    { shop_id: "b", backend_url: "http://127.0.0.1:2" },
    { shop_id: "c", backend_url: "http://127.0.0.1:3" },
  ];
  const has = (ids: string[]) => (id: string) => ids.includes(id);
  assert.equal(pickAdminShop(configs, "c", has(["b", "c"]))?.shop_id, "c");
  assert.equal(pickAdminShop(configs, "a", has(["b", "c"]))?.shop_id, "b");
  assert.equal(pickAdminShop(configs, null, has(["c"]))?.shop_id, "c");
  assert.equal(pickAdminShop(configs, "a", has([])), null);
});

test("结果说明：成功只说已打开链接、不声称已登录；失败都提示改用密码登录，不含票据或口令", () => {
  for (const r of ["ok", "not_local", "unsupported", "failed", "no_shop"] as const) {
    const text = adminOpenText(r, "timeout");
    assert.ok(text.length > 0);
    assert.ok(!text.includes(TICKET) && !text.includes(TOKEN));
  }
  assert.equal(adminOpenText("ok"), "已打开后台登录链接，登录结果请在浏览器查看");
  assert.doesNotMatch(adminOpenText("ok"), /已自动登录|已登录/);
  assert.match(adminOpenText("failed", "timeout"), /超时/);
  assert.match(adminOpenText("failed", "http_403"), /HTTP 403/);
  assert.match(adminOpenText("unsupported"), /密码/);
});

test("复审反例：后台返回的任意错误码（哪怕含口令样的字符串）不进日志和提示，只留封闭类别", async () => {
  const evil = `leak-${TOKEN}`;
  const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  const c = new BackendClient("http://127.0.0.1:8765", TOKEN, reply(500, { error: { code: evil, message: evil } }) as never);
  const err = await c.adminHandoff().catch((e: unknown) => e);
  const f = adminFailureOf(err);
  assert.equal(f, "http_500");
  const text = adminOpenText("failed", f);
  assert.ok(!text.includes(evil) && !text.includes(TOKEN));
  assert.equal(adminFailureOf(new TransportError("timeout")), "timeout");
  assert.equal(adminFailureOf(new TransportError("network_error")), "network");
  assert.equal(adminFailureOf(new TransportError("handoff_response_invalid")), "response_invalid");
  assert.equal(adminFailureOf(new Error(evil)), "network");
});

test("IPC：shop_id 可为空；不接受多余字段或不安全的店铺编号", () => {
  assert.deepEqual(validateIpc("app:openAdmin", { shop_id: null }), { channel: "app:openAdmin", shop_id: null });
  assert.deepEqual(validateIpc("app:openAdmin", undefined), { channel: "app:openAdmin", shop_id: null });
  assert.deepEqual(validateIpc("app:openAdmin", { shop_id: "xiaoma" }), { channel: "app:openAdmin", shop_id: "xiaoma" });
  assert.throws(() => validateIpc("app:openAdmin", { shop_id: "../x" }));
  assert.throws(() => validateIpc("app:openAdmin", { shop_id: "a", url: "http://evil" }));
});

test("后台客户端：用客户端口令 POST 换票据；响应不合格按传输错误处理；后台错误带状态码", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = (status: number, body: unknown) => async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(JSON.stringify(body), { status }));
  const future = Date.now() / 1000 + 60;
  const ok = new BackendClient("http://127.0.0.1:8765", TOKEN, reply(200, { ticket: TICKET, expires_at: future }) as never);
  assert.deepEqual(await ok.adminHandoff(), { ticket: TICKET, expires_at: future });
  assert.equal(calls[0].url, "http://127.0.0.1:8765/api/v1/admin/handoff");
  assert.equal(calls[0].init.method, "POST");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  const bad = new BackendClient("http://127.0.0.1:8765", TOKEN, reply(200, { ticket: "x y", expires_at: future }) as never);
  await assert.rejects(bad.adminHandoff(), (e: unknown) => e instanceof TransportError);
  // 复审反例：格式正确但已过期的票据不拿去打开。
  const expired = new BackendClient("http://127.0.0.1:8765", TOKEN, reply(200, { ticket: TICKET, expires_at: Date.now() / 1000 - 1 }) as never);
  await assert.rejects(expired.adminHandoff(), (e: unknown) => e instanceof TransportError && e.message === "handoff_response_invalid");
  const old = new BackendClient("http://127.0.0.1:8765", TOKEN, reply(403, { error: { code: "admin_required" } }) as never);
  await assert.rejects(old.adminHandoff(), (e: unknown) => e instanceof BackendError && e.status === 403 && e.code === "admin_required");
});
