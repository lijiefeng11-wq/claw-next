import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { BackendClient, BackendError, TransportError } from "../src/core/backend.js";
import { decodePairing, encodePairing, newPairing, pairShop, pairingFailureOf, pairingKey, pairingName, parseRegistration, type PairingDeps, type PairingFailure } from "../src/core/shopPairing.js";

// 本机店铺自动登记（#75）：全部用虚构店铺、虚构授权码与内存存储，不连真实后台。
const ORIGIN = "http://127.0.0.1:18880";
const GRANT = "g".repeat(43);

function deps(over: Partial<PairingDeps> = {}) {
  const store = new Map<string, string>();
  const saved: string[] = [];
  const sent: unknown[] = [];
  const d: PairingDeps = {
    shopId: "demo-shop",
    displayName: " 虚构店铺 ",
    origin: ORIGIN,
    grant: () => GRANT,
    store: { has: (k) => store.has(k), get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) },
    register: async (_o, _g, body) => {
      sent.push(body);
      return { created: true };
    },
    saveToken: (t) => void saved.push(t),
    ...over,
  };
  return { d, store, saved, sent };
}

describe("凭据生成与保存格式", () => {
  test("client_id 合规，口令为 43 位 URL-safe；每次不同", () => {
    const a = newPairing(), b = newPairing();
    assert.match(a.client_id, /^claw-[0-9a-f]{24}$/);
    assert.match(a.client_token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a.client_token, b.client_token);
    assert.notEqual(a.client_id, b.client_id);
  });
  test("编码可读回；损坏或格式不符返回 null", () => {
    const p = newPairing();
    assert.deepEqual(decodePairing(encodePairing(p)), p);
    for (const raw of [null, "", "{", "[]", JSON.stringify({ v: 2, ...p }), JSON.stringify({ v: 1, client_id: "bad id", client_token: p.client_token }), JSON.stringify({ v: 1, client_id: p.client_id, client_token: "short" })]) assert.equal(decodePairing(raw), null, String(raw));
  });
  test("键按店铺和 origin 区分，且只含十六进制", () => {
    assert.match(pairingKey("a", ORIGIN), /^[0-9a-f]{32}$/);
    assert.notEqual(pairingKey("a", ORIGIN), pairingKey("b", ORIGIN));
    assert.notEqual(pairingKey("a", ORIGIN), pairingKey("a", "http://localhost:18880"));
  });
  test("名称去首尾空白，空时用店铺编号，最多 128 字", () => {
    assert.equal(pairingName("  小马  ", "x"), "小马");
    assert.equal(pairingName("   ", "demo-shop"), "demo-shop");
    assert.equal([...pairingName("店".repeat(200), "x")].length, 128);
  });
});

describe("登记流程 pairShop", () => {
  test("首次：先存凭据再发请求，成功后保存为本店口令；请求体恰为四个字段", async () => {
    let storedBeforeRequest = false;
    const t = deps();
    t.d.register = async (_o, g, body) => {
      storedBeforeRequest = t.store.size === 1;
      assert.equal(g, GRANT);
      t.sent.push(body);
      return { created: true };
    };
    const r = await pairShop(t.d);
    assert.deepEqual(r, { ok: true, created: true });
    assert.ok(storedBeforeRequest, "发请求前已写入安全存储");
    const body = t.sent[0] as Record<string, string>;
    assert.deepEqual(Object.keys(body).sort(), ["client_id", "client_token", "name", "shop_id"]);
    assert.equal(body.name, "虚构店铺");
    assert.deepEqual(t.saved, [body.client_token]);
  });

  test("响应丢失（超时）后再点：用同一组值核对，不重新生成", async () => {
    const t = deps();
    t.d.register = async (_o, _g, body) => {
      t.sent.push(body);
      throw new TransportError("timeout");
    };
    assert.deepEqual(await pairShop(t.d), { ok: false, failure: "uncertain" });
    assert.deepEqual(t.saved, [], "结果不确定时不保存为本店口令");
    t.d.register = async (_o, _g, body) => {
      t.sent.push(body);
      return { created: false };
    };
    assert.deepEqual(await pairShop(t.d), { ok: true, created: false });
    assert.deepEqual(t.sent[0], t.sent[1], "第二次提交与第一次完全相同");
    assert.equal(t.store.size, 1);
  });

  test("本地记录损坏：不换新、不发请求", async () => {
    const t = deps();
    t.store.set(pairingKey("demo-shop", ORIGIN), "garbage");
    assert.deepEqual(await pairShop(t.d), { ok: false, failure: "stored_invalid" });
    assert.equal(t.sent.length, 0);
    assert.equal(t.store.get(pairingKey("demo-shop", ORIGIN)), "garbage");
  });

  test("安全存储读取抛错也按损坏处理，不换新", async () => {
    const t = deps();
    t.store.set(pairingKey("demo-shop", ORIGIN), "x");
    t.d.store = { ...t.d.store, has: () => true, get: () => { throw new Error("decrypt failed"); } };
    assert.deepEqual(await pairShop(t.d), { ok: false, failure: "stored_invalid" });
    assert.equal(t.sent.length, 0);
  });

  test("后台不在本机：不登记；没有授权码：不生成凭据、不发请求", async () => {
    const remote = deps({ origin: null });
    assert.deepEqual(await pairShop(remote.d), { ok: false, failure: "not_local" });
    const noGrant = deps({ grant: () => null });
    assert.deepEqual(await pairShop(noGrant.d), { ok: false, failure: "no_grant" });
    assert.equal(noGrant.store.size, 0);
    assert.equal(noGrant.sent.length, 0);
  });

  test("登记等待期间本店被删除或改了后台地址：旧响应不写回口令", async () => {
    let current = true;
    const t = deps({ stillCurrent: () => current });
    t.d.register = async (_o, _g, body) => {
      t.sent.push(body);
      current = false; // 等待响应期间用户删店/改地址
      return { created: true };
    };
    assert.deepEqual(await pairShop(t.d), { ok: false, failure: "changed" });
    assert.deepEqual(t.saved, [], "不写回本店口令");
  });

  test("授权码按 origin 取：已授权后台 A、本店后台 B 时不带 A 的授权去 B，零请求", async () => {
    const A = "http://127.0.0.1:18880", B = "http://127.0.0.1:18881";
    const asked: string[] = [];
    const t = deps({ origin: B, grant: (o) => (asked.push(o), o === A ? GRANT : null) });
    assert.deepEqual(await pairShop(t.d), { ok: false, failure: "no_grant" });
    assert.deepEqual(asked, [B]);
    assert.equal(t.sent.length, 0);
    const ok = deps({ origin: A, grant: (o) => (o === A ? GRANT : null) });
    const origins: string[] = [];
    ok.d.register = async (o, g, body) => (origins.push(o), assert.equal(g, GRANT), ok.sent.push(body), { created: true });
    assert.deepEqual(await pairShop(ok.d), { ok: true, created: true });
    assert.deepEqual(origins, [A], "只向 A 登记");
  });

  test("安全存储不可用：不发请求", async () => {
    const t = deps();
    t.d.store = { ...t.d.store, set: () => { throw new Error("unavailable"); } };
    assert.deepEqual(await pairShop(t.d), { ok: false, failure: "storage_unavailable" });
    assert.equal(t.sent.length, 0);
  });

  test("后台拒绝的各类结果只映射到封闭类别，凭据保留、不保存为口令", async () => {
    const cases: [unknown, PairingFailure][] = [
      [new BackendError(404, "not_found"), "unsupported"],
      [new BackendError(401, "invalid_handoff_grant"), "grant_invalid"],
      [new BackendError(409, "client_registration_conflict"), "conflict"],
      [new BackendError(409, "shop_id_reserved"), "reserved"],
      [new BackendError(429, "login_rate_limited"), "rate_limited"],
      [new BackendError(403, "local_only"), "local_only"],
      [new BackendError(400, "invalid_shop_registration"), "invalid_request"],
      [new BackendError(500, "boom"), "rejected"],
      [new TransportError("network_error"), "uncertain"],
      [new TransportError("registration_response_invalid"), "uncertain"],
    ];
    for (const [err, want] of cases) {
      assert.equal(pairingFailureOf(err), want);
      const t = deps({ register: async () => { throw err; } });
      assert.deepEqual(await pairShop(t.d), { ok: false, failure: want });
      assert.equal(t.store.size, 1, `${want}：凭据保留，下次核对`);
      assert.deepEqual(t.saved, []);
    }
  });
});

describe("BackendClient.registerShop", () => {
  const body = { shop_id: "demo-shop", name: "虚构店铺", client_id: "claw-0123", client_token: "t".repeat(43) };
  const fakeFetch = (status: number, json: unknown, seen: { url?: string; init?: RequestInit }[] = []) =>
    (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

  test("用本机授权码作 Bearer、POST 到登记接口、不跟随重定向；响应核对店铺与 client_id", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const c = new BackendClient(ORIGIN, GRANT, fakeFetch(200, { shop_id: "demo-shop", name: "虚构店铺", client_id: "claw-0123", created: true, protocol_version: "1.0" }, seen));
    assert.deepEqual(await c.registerShop(body), { created: true, name: "虚构店铺" });
    assert.equal(seen[0].url, `${ORIGIN}/api/v1/admin/handoff/shops`);
    assert.equal(seen[0].init?.method, "POST");
    assert.equal(seen[0].init?.redirect, "error");
    assert.equal((seen[0].init?.headers as Record<string, string>).Authorization, `Bearer ${GRANT}`);
    assert.deepEqual(JSON.parse(String(seen[0].init?.body)), body);
  });

  test("响应店铺或 client_id 不符、缺字段：按结果不确定", async () => {
    for (const json of [
      { shop_id: "other", name: "x", client_id: "claw-0123", created: true, protocol_version: "1.0" },
      { shop_id: "demo-shop", name: "x", client_id: "claw-9", created: true, protocol_version: "1.0" },
      { shop_id: "demo-shop", name: "x", client_id: "claw-0123", protocol_version: "1.0" },
      { shop_id: "demo-shop", name: "x", client_id: "claw-0123", created: true },
    ]) {
      const c = new BackendClient(ORIGIN, GRANT, fakeFetch(200, json));
      await assert.rejects(c.registerShop(body), (e: unknown) => e instanceof TransportError && pairingFailureOf(e) === "uncertain");
    }
    assert.equal(parseRegistration(null, body), null);
  });

  test("后台错误码原样交给分类", async () => {
    const c = new BackendClient(ORIGIN, GRANT, fakeFetch(409, { error: { code: "client_registration_conflict", message: "x" } }));
    await assert.rejects(c.registerShop(body), (e: unknown) => pairingFailureOf(e) === "conflict");
  });
});

test("每个登记失败类别在界面上都有中文说明", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "../../src/renderer/app.ts"), "utf8");
  const failures: PairingFailure[] = ["no_grant", "unsupported", "grant_invalid", "conflict", "reserved", "rate_limited", "local_only", "invalid_request", "uncertain", "rejected", "stored_invalid", "changed"];
  for (const f of failures) assert.match(renderer, new RegExp(`\\bpairing_${f}: "`), f);
  const preload = fs.readFileSync(path.join(__dirname, "../../src/preload/preload.ts"), "utf8");
  assert.ok(preload.includes('"shop:pair"'), "预加载脚本放行 shop:pair");
});
