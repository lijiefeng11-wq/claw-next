import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { FetchLike } from "../src/core/backend.js";
import type { MarkColor } from "../src/core/protocol.js";
import { receiptExtra, ShopRuntime } from "../src/core/runtime.js";
import { messageStatus } from "../src/core/view.js";
import { TestBackend, eventsOf, makeShop, settle, tempDir, waitFor } from "./helpers.js";

// 契约 1.3“标星执行与成功判据”：运行时的能力声明、claim 前的适用范围、回执形状与 unknown 规则。
// 全部为虚构店铺、虚构买家与内存中的虚构后台；虚构后台直接给出 mark 决定，只为验证前台行为。

type Fake = ReturnType<typeof fakeBackend>;

function fakeBackend(opts: { confirm?: boolean; decision?: Record<string, unknown> | null; color?: MarkColor } = {}) {
  const state = { heartbeats: [] as any[], bodies: [] as any[], claims: [] as any[], receipts: [] as any[], events: new Map<string, any>() };
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
      const caps = opts.confirm !== false ? { capabilities: ["mark_conversation"] } : {};
      return json(200, { shop_id: "shop-a", client_id: "client-a", instance_id: body.instance_id, session_id: body.session_id, generation: 1, expires_at: now + 60, ...caps });
    }
    if (p === "/api/v1/events" && method === "POST") {
      state.bodies.push(body);
      const decision = opts.decision === undefined ? { action: "mark", mark: { color: opts.color ?? "red" }, policy_version: 3, reason: "fallback:unhandled", expires_at: now + 120 } : opts.decision;
      const snap = {
        event_id: body.event_id, shop_id: "shop-a", client_id: "client-a", conversation_id: body.conversation_id, message_id: body.message_id,
        context_revision: body.context_revision, session_id: body.session_id, generation: body.generation, state: "ready",
        decision, delivery: { status: "unclaimed", attempt_id: null, platform_message_id: null }, created_at: now,
      };
      state.events.set(body.event_id, snap);
      return json(202, snap);
    }
    const m = /^\/api\/v1\/events\/([^/]+)(?:\/(claim|receipt))?$/.exec(p);
    const snap = m ? state.events.get(decodeURIComponent(m[1])) : null;
    if (snap && method === "GET" && !m![2]) return json(200, snap);
    if (snap && m![2] === "claim") {
      state.claims.push(body);
      snap.delivery = { status: "claimed", attempt_id: body.attempt_id, platform_message_id: null, claim_expires_at: now + 10 };
      return json(200, snap);
    }
    if (snap && m![2] === "receipt") {
      state.receipts.push(body);
      snap.delivery = { ...snap.delivery, status: body.status };
      return json(200, snap);
    }
    return json(404, { error: { code: "not_found" } });
  }) as FetchLike;
  return { state, fetchImpl };
}

const FAKE = { url: "http://127.0.0.1:9" } as TestBackend;
const running: ShopRuntime[] = [];
async function shop(fake: Fake, o: { declare?: boolean; marked?: boolean | null; dir?: string } = {}) {
  const h = await makeShop({ backend: FAKE, fetchImpl: fake.fetchImpl, login: false, declareMark: o.declare !== false, dir: o.dir });
  const marked = o.marked === undefined ? false : o.marked;
  (h.mock as any).readConvState = async () => ({ marked, color: null });
  await h.mock.login();
  await waitFor(() => h.rt.lease.state === "held", "lease");
  running.push(h.rt);
  return h;
}
afterEach(async () => {
  for (const rt of running.splice(0)) await rt.stop(false);
});

async function decided(fake: Fake, h: Awaited<ReturnType<typeof shop>>, content = "在吗") {
  h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content });
  await waitFor(() => fake.state.bodies.length > 0, "submit");
  await waitFor(() => eventsOf(h.rt)[0]?.snapshot?.state === "ready", "ready");
  await settle(h.rt);
  return eventsOf(h.rt)[0];
}

describe("标星：能力声明（默认关闭）", () => {
  test("默认不声明 mark_conversation；即使后台回了该能力也不执行、不 claim", async () => {
    const fake = fakeBackend();
    const h = await shop(fake, { declare: false });
    assert.ok(!(fake.state.heartbeats[0].capabilities ?? []).includes("mark_conversation"));
    assert.equal(h.rt.markExecutable(), false);
    const ev = await decided(fake, h);
    assert.equal(ev.blocked, "capability_not_confirmed");
    assert.equal(fake.state.claims.length, 0);
    assert.equal(h.mock.platformMarks.length, 0);
  });

  test("明确开启且适配器能读能执行时才声明；适配器不能读状态则不声明", async () => {
    const fake = fakeBackend();
    const h = await shop(fake);
    assert.ok(fake.state.heartbeats[0].capabilities.includes("mark_conversation"));
    assert.equal(h.rt.markExecutable(), true);

    const fake2 = fakeBackend();
    const h2 = await makeShop({ backend: FAKE, fetchImpl: fake2.fetchImpl, declareMark: true });
    running.push(h2.rt);
    await waitFor(() => fake2.state.heartbeats.length > 0, "heartbeat");
    assert.ok(!fake2.state.heartbeats[0].capabilities.includes("mark_conversation"));
    assert.equal(h2.rt.markExecutable(), false);
  });
});

describe("标星：适用范围（claim 之前）", () => {
  for (const marked of [true, null] as const) {
    test(`提交时 conv_state.marked=${marked}：不 claim、不点击，只在本地记为阻止`, async () => {
      const fake = fakeBackend();
      const h = await shop(fake, { marked });
      const ev = await decided(fake, h);
      assert.equal(fake.state.bodies[0].context.conv_state.marked, marked);
      assert.equal(ev.blocked, "conv_state_not_unmarked");
      assert.equal(ev.attempt, null);
      assert.deepEqual([fake.state.claims.length, fake.state.receipts.length, h.mock.platformMarks.length], [0, 0, 0]);
    });
  }

  for (const [name, decision] of [
    ["颜色不合法", { action: "mark", mark: { color: "yellow" }, policy_version: 3 }],
    ["缺 policy_version", { action: "mark", mark: { color: "red" } }],
    ["transfer 本阶段不执行", { action: "transfer", transfer: { target_id: "t-1", unmark_policy: { allow: true, version: 3 } }, policy_version: 3 }],
  ] as const) {
    test(`${name}：按 none 记录，不 claim`, async () => {
      const fake = fakeBackend({ decision: { ...decision, reason: "fallback:unhandled", expires_at: Date.now() / 1000 + 120 } });
      const h = await shop(fake);
      const ev = await decided(fake, h);
      assert.equal(ev.snapshot?.decision?.action, "none");
      assert.deepEqual([fake.state.claims.length, h.mock.platformMarks.length], [0, 0]);
    });
  }

  test("仅观察模式：不 claim", async () => {
    const fake = fakeBackend();
    const h = await shop(fake);
    h.rt.setMode("observe");
    const ev = await decided(fake, h);
    assert.equal(ev.blocked, "mode_observe");
    assert.equal(fake.state.claims.length, 0);
  });
});

describe("标星：执行与回执", () => {
  test("确认成功：回执 sent，唯一步骤 mark（带颜色），不带平台消息编号；界面显示已标星", async () => {
    const fake = fakeBackend({ color: "orange" });
    const h = await shop(fake);
    const ev = await decided(fake, h);
    assert.equal(h.mock.platformMarks.length, 1);
    assert.equal(h.mock.platformMarks[0].color, "orange");
    assert.equal(h.mock.platformMarks[0].conversation_id, "buyer-1");
    assert.deepEqual(fake.state.receipts, [{ attempt_id: ev.attempt!.attempt_id, status: "sent", steps: [{ step: "mark", status: "sent", color: "orange" }], page_observed: "marked" }]);
    assert.equal(ev.attempt?.phase, "sent");
    const conv = h.rt.journal.conversation("buyer-1");
    const status = messageStatus(conv.messages[0], ev, undefined);
    assert.equal(status?.label, "已标星");
    assert.match(status?.reason ?? "", /黄色/);
  });

  test("点击后不能确认：回执 unknown（步骤 unknown），只点一次，不重试", async () => {
    const fake = fakeBackend();
    const h = await shop(fake);
    h.mock.markBehavior = "unknown";
    const ev = await decided(fake, h);
    assert.deepEqual(fake.state.receipts.map((r) => [r.status, r.steps, r.platform_message_id]), [["unknown", [{ step: "mark", status: "unknown", color: "red" }], undefined]]);
    await h.rt.refresh();
    await settle(h.rt);
    assert.deepEqual([fake.state.claims.length, h.mock.platformMarks.length], [1, 1]);
    assert.equal(ev.attempt?.phase, "unknown");
    assert.equal(messageStatus(h.rt.journal.conversation("buyer-1").messages[0], ev, undefined)?.label, "标星结果待核查");
  });

  test("点击后适配器无结果：超时 unknown（步骤 unknown）", async () => {
    const fake = fakeBackend();
    const h = await shop(fake);
    h.mock.markBehavior = "timeout_after_click";
    await decided(fake, h);
    await waitFor(() => fake.state.receipts.length > 0, "receipt", 6000);
    assert.deepEqual(fake.state.receipts.map((r) => [r.status, r.steps]), [["unknown", [{ step: "mark", status: "unknown", color: "red" }]]]);
  });

  test("点击前发现状态变化：回执 not_sent，不列步骤，带原因 conv_state_changed", async () => {
    const fake = fakeBackend();
    const h = await shop(fake);
    h.mock.markBehavior = "page_changed";
    const ev = await decided(fake, h);
    assert.deepEqual(fake.state.receipts, [{ attempt_id: ev.attempt!.attempt_id, status: "not_sent", reason: "conv_state_changed" }]);
    assert.equal(h.mock.platformMarks.length, 0);
  });

  test("领取后、点击前买家来了新消息：点击前再核验阻止，not_sent（not_started），不点击", async () => {
    const fake = fakeBackend();
    const h = await shop(fake);
    let injected = false;
    h.mock.beforeMarkClick = () => {
      if (injected) return;
      injected = true;
      h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "还有一句" });
    };
    const first = await decided(fake, h);
    await waitFor(() => fake.state.receipts.length > 0, "receipt");
    const attempt = first.attempt!.attempt_id;
    assert.equal(first.attempt?.detail, "superseded");
    assert.deepEqual(fake.state.receipts.find((r) => r.attempt_id === attempt), { attempt_id: attempt, status: "not_sent", reason: "not_started" });
    // 新消息另成事件、另行判断；被阻止的这次尝试没有点击。
    assert.ok(!h.mock.platformMarks.some((m) => m.attempt_id === attempt));
  });

  test("能力在点击前被撤回：not_sent（capability_withdrawn）", async () => {
    const fake = fakeBackend();
    const h = await shop(fake);
    h.mock.beforeMarkClick = () => void ((h.rt as any).capabilities = new Set());
    await decided(fake, h);
    await waitFor(() => fake.state.receipts.length > 0, "receipt");
    assert.deepEqual([fake.state.receipts[0].status, fake.state.receipts[0].reason], ["not_sent", "capability_withdrawn"]);
  });

  test("点击中途客户端退出：重启后按 unknown 上报（带 mark 步骤），不重新点击", async () => {
    const fake = fakeBackend();
    const dir = tempDir("claw-next-mark-");
    const h = await shop(fake, { dir });
    h.mock.markBehavior = "timeout_after_click";
    h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "在吗" });
    await waitFor(() => h.mock.platformMarks.length === 1, "clicked");
    await h.rt.stop(false);
    running.splice(running.indexOf(h.rt), 1);
    assert.equal(fake.state.receipts.length, 0);
    const again = await makeShop({ backend: FAKE, fetchImpl: fake.fetchImpl, declareMark: true, dir, login: false });
    running.push(again.rt);
    await waitFor(() => fake.state.receipts.length > 0, "receipt after restart");
    assert.deepEqual(fake.state.receipts.map((r) => [r.status, r.steps]), [["unknown", [{ step: "mark", status: "unknown", color: "red" }]]]);
    assert.equal(again.mock.platformMarks.length, 0);
  });
});

describe("标星：回执字段", () => {
  const ev = (action: string) => ({ snapshot: { decision: { action, text: "", reason: "r", expires_at: 1, ...(action === "mark" ? { mark: { color: "blue" }, policy_version: 2 } : {}) } } }) as any;
  test("mark：sent/unknown 带唯一步骤；not_sent 只带归类原因；其他动作不带", () => {
    assert.deepEqual(receiptExtra(ev("mark"), "sent", null, "marked"), { steps: [{ step: "mark", status: "sent", color: "blue" }], page_observed: "marked" });
    assert.deepEqual(receiptExtra(ev("mark"), "unknown", "interrupted_during_send"), { steps: [{ step: "mark", status: "unknown", color: "blue" }] });
    assert.deepEqual(receiptExtra(ev("mark"), "not_sent", "restarted_before_send"), { reason: "not_started" });
    assert.deepEqual(receiptExtra(ev("mark"), "not_sent", "claim_expiring"), { reason: "deadline_exceeded" });
    assert.equal(receiptExtra(ev("reply"), "sent", null), undefined);
    assert.equal(receiptExtra(ev("send_item"), "unknown", null), undefined);
  });
});
