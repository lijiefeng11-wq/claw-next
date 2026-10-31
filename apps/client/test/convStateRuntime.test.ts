import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { FetchLike } from "../src/core/backend.js";
import { ShopRuntime } from "../src/core/runtime.js";
import { TestBackend, makeShop, settle, waitFor } from "./helpers.js";

// 契约“会话操作（1.3 草案）”：只读收藏状态 conv_state 的提交规则。全部为虚构店铺与虚构内容。
// 本阶段前台不在心跳里声明 mark_conversation；这里由虚构后台直接回能力，只为验证确认后的提交形状。

function fakeBackend(opts: { mark: boolean }) {
  const state = { heartbeats: [] as any[], bodies: [] as any[] };
  const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    const now = Date.now() / 1000;
    const p = url.pathname;
    if (p === "/health") return json(200, { service: "claw-next", status: "ok", protocol_version: "1.0" });
    if (p === "/api/v1/me") return json(200, { role: "client", client_id: "client-a", shop_id: "shop-a", protocol_version: "1.0" });
    if (p === "/api/v1/heartbeat") {
      state.heartbeats.push(body);
      return json(200, { shop_id: "shop-a", client_id: "client-a", instance_id: body.instance_id, session_id: body.session_id, generation: 1, expires_at: now + 60, ...(opts.mark ? { capabilities: ["mark_conversation"] } : {}) });
    }
    if (p === "/api/v1/events" && method === "POST") {
      state.bodies.push(body);
      return json(202, {
        event_id: body.event_id, shop_id: "shop-a", client_id: "client-a", conversation_id: body.conversation_id, message_id: body.message_id,
        context_revision: body.context_revision, session_id: body.session_id, generation: body.generation, state: "ready",
        decision: { action: "none", text: "", reason: "rule:test", expires_at: now + 120 },
        delivery: { status: "unclaimed", attempt_id: null, platform_message_id: null }, created_at: now,
      });
    }
    return json(404, { error: { code: "not_found" } });
  }) as FetchLike;
  return { state, fetchImpl };
}

const FAKE = { url: "http://127.0.0.1:9" } as TestBackend;
const running: ShopRuntime[] = [];
async function shop(fake: ReturnType<typeof fakeBackend>, read?: (conv: string) => Promise<unknown>) {
  const h = await makeShop({ backend: FAKE, fetchImpl: fake.fetchImpl, login: false });
  if (read) (h.mock as any).readConvState = read;
  await h.mock.login();
  await waitFor(() => h.rt.lease.state === "held", "lease");
  running.push(h.rt);
  return h;
}
afterEach(async () => {
  for (const rt of running.splice(0)) await rt.stop(false);
});

async function submitted(fake: ReturnType<typeof fakeBackend>, h: Awaited<ReturnType<typeof shop>>) {
  h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "在吗" });
  await waitFor(() => fake.state.bodies.length > 0, "submit");
  await settle(h.rt);
  return fake.state.bodies[0];
}

describe("会话状态 conv_state：只读采集与提交", () => {
  test("本阶段心跳不声明 mark_conversation；能力未确认时不读状态、不带 conv_state", async () => {
    const fake = fakeBackend({ mark: false });
    let reads = 0;
    const h = await shop(fake, async () => (reads++, { marked: true, color: null }));
    assert.ok(!(fake.state.heartbeats[0].capabilities ?? []).includes("mark_conversation"));
    assert.equal(h.rt.markConfirmed(), false);
    const body = await submitted(fake, h);
    assert.equal(body.context.conv_state, undefined);
    assert.equal(reads, 0);
  });

  test("能力确认后带 conv_state：读数按买家传入，只含三键", async () => {
    const fake = fakeBackend({ mark: true });
    const seen: string[] = [];
    const h = await shop(fake, async (conv) => (seen.push(conv), { marked: true, color: "orange" }));
    assert.equal(h.rt.markConfirmed(), true);
    const st = (await submitted(fake, h)).context.conv_state;
    assert.deepEqual(Object.keys(st).sort(), ["color", "marked", "observed_at"]);
    assert.deepEqual([st.marked, st.color], [true, "orange"]);
    assert.ok(Number.isFinite(st.observed_at));
    assert.deepEqual(seen, ["buyer-1"]);
  });

  test("未收藏时颜色一律为 null", async () => {
    const fake = fakeBackend({ mark: true });
    const h = await shop(fake, async () => ({ marked: false, color: "red" }));
    const st = (await submitted(fake, h)).context.conv_state;
    assert.deepEqual([st.marked, st.color], [false, null]);
  });

  for (const [name, read] of [
    ["适配器没有读取能力", undefined],
    ["读取抛错", async () => { throw new Error("boom"); }],
    ["读取返回未知", async () => ({ marked: null, color: "red" })],
  ] as const) {
    test(`${name}：如实报 marked=null、color=null，事件照常提交`, async () => {
      const fake = fakeBackend({ mark: true });
      const h = await shop(fake, read as ((conv: string) => Promise<unknown>) | undefined);
      const st = (await submitted(fake, h)).context.conv_state;
      assert.deepEqual([st.marked, st.color], [null, null]);
    });
  }
});
