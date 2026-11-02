import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adminFailureOf,
  adminGrantKey,
  adminOpenText,
  adminOrigin,
  adminPageUrl,
  isHandoffTicket,
  isLoopbackBackend,
  normalizeAdminGrant,
  pickAdminShop,
} from "../src/core/adminHandoff.js";
import { BackendClient, BackendError, TransportError } from "../src/core/backend.js";
import { validateIpc } from "../src/core/ipc.js";

// #63/#67 客户端一键打开后台管理：全部为虚构地址、授权码与票据。
const TICKET = "ticket_" + "a".repeat(36);
const GRANT = "g".repeat(43);
const TOKEN = "fixture-client-token-0123456789abcdef0123456789";

test("只有本机后台才换票据；地址不合法按非本机处理", () => {
  assert.equal(isLoopbackBackend("http://127.0.0.1:8765"), true);
  assert.equal(isLoopbackBackend("http://localhost:8765/"), true);
  assert.equal(isLoopbackBackend("http://[::1]:8765"), true);
  assert.equal(isLoopbackBackend("https://admin.example.com"), false);
  assert.equal(isLoopbackBackend("http://192.168.1.5:8765"), false);
  assert.equal(isLoopbackBackend("not a url"), false);
});

test("票据必须是精确 43 位；只放在 # 后面，格式不符不拼进地址", () => {
  assert.equal(TICKET.length, 43);
  assert.equal(isHandoffTicket(TICKET), true);
  assert.equal(isHandoffTicket("a".repeat(42)), false);
  assert.equal(isHandoffTicket("a".repeat(44)), false);
  assert.equal(isHandoffTicket("short"), false);
  assert.equal(adminPageUrl("http://127.0.0.1:8765/", TICKET), `http://127.0.0.1:8765/#handoff=${TICKET}`);
  assert.equal(adminPageUrl("http://127.0.0.1:8765", null), "http://127.0.0.1:8765/");
  assert.equal(adminPageUrl("http://127.0.0.1:8765", "bad ticket&x=1"), "http://127.0.0.1:8765/");
});

test("授权码：首尾空白先去掉，必须恰为 43 位字母、数字、_ 或 -", () => {
  assert.equal(GRANT.length, 43);
  assert.equal(normalizeAdminGrant(` \n${GRANT}\t `), GRANT);
  assert.equal(normalizeAdminGrant("a".repeat(42)), null);
  assert.equal(normalizeAdminGrant("a".repeat(44)), null);
  assert.equal(normalizeAdminGrant("a".repeat(21) + " " + "a".repeat(21)), null);
  assert.equal(normalizeAdminGrant(GRANT.replace("g", "+")), null);
  assert.equal(normalizeAdminGrant(undefined), null);
});

test("origin 键：同一 origin 不同路径/主机大小写得到同一键，不同端口不同键", () => {
  assert.equal(adminOrigin("http://LOCALHOST:8765/a"), "http://localhost:8765");
  assert.equal(adminOrigin("http://127.0.0.1:8765/a?x=1#y"), "http://127.0.0.1:8765");
  const key = adminGrantKey("http://127.0.0.1:8765/a");
  assert.match(key, /^[a-f0-9]{32}$/);
  assert.equal(key, adminGrantKey("http://127.0.0.1:8765/b"));
  assert.equal(adminGrantKey("http://LOCALHOST:8765/a"), adminGrantKey("http://localhost:8765/b"));
  assert.notEqual(key, adminGrantKey("http://127.0.0.1:8766/a"));
});

test("选店铺：优先选中的，其次第一个；没有店铺为 null", () => {
  const configs = [
    { shop_id: "a", backend_url: "http://127.0.0.1:1" },
    { shop_id: "b", backend_url: "http://127.0.0.1:2" },
    { shop_id: "c", backend_url: "http://127.0.0.1:3" },
  ];
  assert.equal(pickAdminShop(configs, "c")?.shop_id, "c");
  assert.equal(pickAdminShop(configs, "missing")?.shop_id, "a");
  assert.equal(pickAdminShop(configs, null)?.shop_id, "a");
  assert.equal(pickAdminShop([], "a"), null);
});

test("结果说明：成功只说已打开链接；无授权码、授权码无效、非本机各有文案，不含票据或授权码", () => {
  for (const r of ["ok", "not_local", "unsupported", "failed", "no_shop", "no_grant", "grant_invalid"] as const) {
    const text = adminOpenText(r, "timeout");
    assert.ok(text.length > 0);
    assert.ok(!text.includes(TICKET) && !text.includes(GRANT) && !text.includes(TOKEN));
  }
  assert.equal(adminOpenText("ok"), "已打开后台登录链接，登录结果请在浏览器查看");
  assert.doesNotMatch(adminOpenText("ok"), /已自动登录|已登录/);
  assert.match(adminOpenText("no_grant"), /授权码/);
  assert.match(adminOpenText("grant_invalid"), /撤销/);
  assert.match(adminOpenText("failed", "timeout"), /超时/);
  assert.match(adminOpenText("failed", "http_403"), /HTTP 403/);
  assert.match(adminOpenText("unsupported"), /密码/);
});

test("后台返回的任意错误码（哪怕含授权码样的字符串）不进日志和提示，只留封闭类别", async () => {
  const evil = `leak-${GRANT}`;
  const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  const c = new BackendClient("http://127.0.0.1:8765", GRANT, reply(500, { error: { code: evil, message: evil } }) as never);
  const err = await c.adminHandoff().catch((e: unknown) => e);
  const f = adminFailureOf(err);
  assert.equal(f, "http_500");
  const text = adminOpenText("failed", f);
  assert.ok(!text.includes(evil) && !text.includes(GRANT));
  assert.equal(adminFailureOf(new TransportError("timeout")), "timeout");
  assert.equal(adminFailureOf(new TransportError("network_error")), "network");
  assert.equal(adminFailureOf(new TransportError("handoff_response_invalid")), "response_invalid");
  assert.equal(adminFailureOf(new Error(evil)), "network");
});

test("IPC：新增授权码通道接受合法输入，拒绝未知字段、格式不符和不安全店铺编号", () => {
  assert.deepEqual(validateIpc("app:setAdminGrant", { shop_id: null, grant: ` ${TICKET}\n` }), { channel: "app:setAdminGrant", shop_id: null, grant: TICKET });
  assert.deepEqual(validateIpc("app:setAdminGrant", { shop_id: "xiaoma", grant: GRANT }), { channel: "app:setAdminGrant", shop_id: "xiaoma", grant: GRANT });
  assert.deepEqual(validateIpc("app:clearAdminGrant", { shop_id: null }), { channel: "app:clearAdminGrant", shop_id: null });
  assert.deepEqual(validateIpc("app:clearAdminGrant", { shop_id: "xiaoma" }), { channel: "app:clearAdminGrant", shop_id: "xiaoma" });
  assert.throws(() => validateIpc("app:setAdminGrant", { shop_id: null, grant: "short" }));
  assert.throws(() => validateIpc("app:setAdminGrant", { shop_id: null, grant: "a".repeat(44) }));
  assert.throws(() => validateIpc("app:setAdminGrant", { shop_id: null, grant: GRANT, extra: null }));
  assert.throws(() => validateIpc("app:setAdminGrant", { shop_id: "../x", grant: GRANT }));
  assert.throws(() => validateIpc("app:clearAdminGrant", { shop_id: null, grant: GRANT }));
});

test("IPC：openAdmin 的 shop_id 可为空；不接受多余字段或不安全的店铺编号", () => {
  assert.deepEqual(validateIpc("app:openAdmin", { shop_id: null }), { channel: "app:openAdmin", shop_id: null });
  assert.deepEqual(validateIpc("app:openAdmin", undefined), { channel: "app:openAdmin", shop_id: null });
  assert.deepEqual(validateIpc("app:openAdmin", { shop_id: "xiaoma" }), { channel: "app:openAdmin", shop_id: "xiaoma" });
  assert.throws(() => validateIpc("app:openAdmin", { shop_id: "../x" }));
  assert.throws(() => validateIpc("app:openAdmin", { shop_id: "a", url: "http://evil" }));
});

test("后台客户端：用授权码作 Bearer POST 换票据；响应不合格按传输错误处理；401/404 带状态码", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = (status: number, body: unknown) => async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(JSON.stringify(body), { status }));
  const future = Date.now() / 1000 + 60;
  const ok = new BackendClient("http://127.0.0.1:8765", GRANT, reply(200, { ticket: TICKET, expires_at: future }) as never);
  assert.deepEqual(await ok.adminHandoff(), { ticket: TICKET, expires_at: future });
  assert.equal(calls[0].url, "http://127.0.0.1:8765/api/v1/admin/handoff");
  assert.equal(calls[0].init.method, "POST");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${GRANT}`);
  const bad = new BackendClient("http://127.0.0.1:8765", GRANT, reply(200, { ticket: "x y", expires_at: future }) as never);
  await assert.rejects(bad.adminHandoff(), (e: unknown) => e instanceof TransportError);
  const short = new BackendClient("http://127.0.0.1:8765", GRANT, reply(200, { ticket: "a".repeat(42), expires_at: future }) as never);
  await assert.rejects(short.adminHandoff(), (e: unknown) => e instanceof TransportError);
  const expired = new BackendClient("http://127.0.0.1:8765", GRANT, reply(200, { ticket: TICKET, expires_at: Date.now() / 1000 - 1 }) as never);
  await assert.rejects(expired.adminHandoff(), (e: unknown) => e instanceof TransportError && e.message === "handoff_response_invalid");
  const revoked = new BackendClient("http://127.0.0.1:8765", GRANT, reply(401, { error: { code: "invalid_handoff_grant" } }) as never);
  await assert.rejects(revoked.adminHandoff(), (e: unknown) => e instanceof BackendError && e.status === 401 && e.code === "invalid_handoff_grant");
  const old = new BackendClient("http://127.0.0.1:8765", GRANT, reply(404, { error: { code: "not_found" } }) as never);
  await assert.rejects(old.adminHandoff(), (e: unknown) => e instanceof BackendError && e.status === 404);
});
