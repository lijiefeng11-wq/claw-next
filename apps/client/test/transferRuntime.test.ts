import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, test } from "node:test";
import { BackendError, type FetchLike } from "../src/core/backend.js";
import type { TransferRequest } from "../src/core/adapter.js";
import { CAP_TRANSFER_BY_ACCOUNT, parseSnapshot } from "../src/core/protocol.js";
import { receiptExtra, ShopRuntime } from "../src/core/runtime.js";
import { messageStatus } from "../src/core/view.js";
import { makeShop, eventsOf, waitFor, settle, startBackend, type TestBackend } from "./helpers.js";

const running: { rt: ShopRuntime; dir: string }[] = [];
afterEach(async () => {
  for (const h of running.splice(0)) { await h.rt.stop(); fs.rmSync(h.dir, { recursive: true, force: true }); }
});

type Options = {
  declare?: boolean; capability?: string | null; account?: string; allowUnmark?: boolean; unmarkStart?: boolean; unmarked?: true;
  reply?: boolean; mode?: "auto" | "observe" | "manual"; takeover?: boolean;
  result?: "unknown" | "confirmed" | "not_sent"; reason?: string; deadlineAtExecution?: boolean;
};
async function harness(opts: Options = {}) {
  let mono = 0;
  const state = { heartbeats: [] as any[], bodies: [] as any[], claims: [] as any[], receipts: [] as any[], transfers: [] as TransferRequest[], discoveries: 0, stateReads: 0, sends: 0, events: new Map<string, any>() };
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (input: any, init?: any) => {
    const p = new URL(String(input)).pathname, body = init?.body ? JSON.parse(init.body) : null, now = Date.now() / 1000;
    if (p === "/health") return response({ service: "claw-next", status: "ok", protocol_version: "1.0" });
    if (p === "/api/v1/me") return response({ role: "client", client_id: "client-a", shop_id: "shop-a", protocol_version: "1.0" });
    if (p === "/api/v1/heartbeat") {
      state.heartbeats.push(body);
      return response({ shop_id: "shop-a", client_id: "client-a", instance_id: body.instance_id, session_id: body.session_id, generation: 1, expires_at: now + 60, capabilities: opts.capability === null ? [] : [opts.capability ?? CAP_TRANSFER_BY_ACCOUNT] });
    }
    if (p === "/api/v1/events") {
      state.bodies.push(body);
      const snap = { event_id: body.event_id, shop_id: "shop-a", client_id: "client-a", conversation_id: body.conversation_id, message_id: body.message_id, context_revision: body.context_revision, session_id: body.session_id, generation: 1, state: "ready", decision: { action: "transfer", transfer: { account: opts.account ?? "fictional-main", unmark_policy: { allow: opts.allowUnmark ?? false, version: 3 } }, policy_version: 3, reason: "fallback:unhandled", expires_at: now + 60 }, delivery: { status: "unclaimed", attempt_id: null, platform_message_id: null }, created_at: now };
      if (opts.reply) snap.decision = { action: "reply", text: "虚构短回复", reason: "rule:reply", expires_at: now + 60 } as any;
      state.events.set(body.event_id, snap); return response(snap, 202);
    }
    const m = /\/events\/([^/]+)(?:\/(claim|receipt))?$/.exec(p), snap = m && state.events.get(m[1]);
    if (snap && m![2] === "claim") { state.claims.push(body); snap.delivery = { status: "claimed", attempt_id: body.attempt_id, platform_message_id: null, claim_expires_at: now + 10 }; return response(snap); }
    if (snap && m![2] === "receipt") { state.receipts.push(body); snap.delivery.status = body.status; return response(snap); }
    if (snap) return response(snap);
    return response({ error: { code: "not_found" } }, 404);
  }) as FetchLike;
  const h = await makeShop({ backend: { url: "http://127.0.0.1:9" } as TestBackend, fetchImpl, login: false, mode: opts.mode,
    declareTransfer: opts.declare !== false, monotonicNow: () => mono, timing: { prepBudgetMs: 20, unknownCheckDelaysMs: [] } });
  running.push(h);
  // 即使旧适配器暴露这些方法，普通准备也不再调用它们或打开转接弹窗。
  (h.mock as any).readConvState = async () => { state.stateReads++; return { marked: null, color: null }; };
  (h.mock as any).readTransferTargets = async () => { state.discoveries++; throw Error("must_not_precollect_recipients"); };
  (h.mock as any).transferConversation = async (request: TransferRequest) => {
    assert.equal(state.claims.length, 1, "only execute after backend decision and claim");
    assert.equal(eventsOf(h.rt)[0].attempt?.phase, "sending", "attempt is durable before platform operation");
    if (opts.deadlineAtExecution) mono = 20_000;
    const blocked = request.recheck();
    if (blocked) return { status: "not_sent", reason: blocked };
    state.transfers.push(request);
    if (opts.unmarkStart) request.before_unmark!();
    return opts.result === "confirmed" ? { status: "confirmed", page_observed: "left_list", ...(opts.unmarked ? { unmarked: true } : {}) } : opts.result === "not_sent" ? { status: "not_sent", reason: opts.reason ?? "transfer_target_missing" } : { status: "unknown", reason: "transfer_binding_unproven", page_observed: "left_list" };
  };
  h.mock.send = async () => { state.sends++; return { status: "confirmed", platform_message_id: "fictional-reply-1" }; };
  await h.mock.login(); await waitFor(() => h.rt.lease.state === "held", "lease");
  if (opts.takeover) { h.rt.journal.conversation("buyer-1"); h.rt.setTakeover("buyer-1", true); }
  const message = h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "虚构售后问题" });
  await waitFor(() => state.bodies.length > 0, "submit");
  await waitFor(() => eventsOf(h.rt)[0]?.snapshot?.state === "ready", "ready");
  await settle(h.rt);
  return { ...h, state, message, event: eventsOf(h.rt)[0] };
}

for (const opts of [{ declare: false }, { capability: null }, { capability: "transfer_conversation" }]) {
  test(`按账号转接必须声明并确认新能力：${JSON.stringify(opts)}`, async () => {
    const h = await harness(opts);
    assert.equal(h.rt.transferExecutable(), false);
    assert.equal(h.state.claims.length, 0); assert.equal(h.state.transfers.length, 0);
    assert.equal(h.state.discoveries, 0);
  });
}

test("无需预采集名单或收藏状态：后台账号直接进入领取后的转接，unknown 仅执行一次", async () => {
  const h = await harness();
  assert(h.state.heartbeats[0].capabilities.includes(CAP_TRANSFER_BY_ACCOUNT));
  assert(!h.state.heartbeats[0].capabilities.includes("transfer_conversation"));
  assert.equal(h.state.bodies[0].context.conv_state, undefined);
  assert.equal(h.state.bodies[0].context.transfer_targets, undefined);
  assert.equal(h.state.discoveries, 0); assert.equal(h.state.stateReads, 0);
  assert.equal(h.state.transfers.length, 1); assert.equal(h.state.transfers[0].account, "fictional-main");
  assert.equal(h.state.sends, 0);
  assert.equal(h.state.receipts[0].status, "unknown");
  assert.deepEqual(h.state.receipts[0].steps, [{ step: "transfer", status: "unknown" }]);
  assert.equal(h.state.receipts[0].platform_message_id, undefined);
  const attemptId = h.event.attempt!.attempt_id;
  h.mock.redeliver(h.message);
  await Promise.all([h.rt.refresh(), h.rt.refresh()]); await settle(h.rt);
  assert.equal(h.state.transfers.length, 1); assert.equal(h.state.claims.length, 1);
  assert.equal(h.event.attempt?.attempt_id, attemptId);
});

for (const unmark of [false, true]) {
  test(`转接已确认完成${unmark ? "（含取消收藏）" : ""}：显示成功、回执 sent，完结后不重转`, async () => {
    const h = await harness({ result: "confirmed", ...(unmark ? { allowUnmark: true, unmarkStart: true, unmarked: true } : {}) });
    assert.equal(h.event.attempt?.phase, "sent"); assert.equal(h.event.attempt?.receipt?.upload, "uploaded");
    assert.equal(h.state.receipts[0].status, "sent");
    assert.deepEqual(h.state.receipts[0].steps, unmark
      ? [{ step: "transfer", status: "not_sent", reason: "blocked_by_mark" }, { step: "unmark_and_transfer", status: "sent", unmarked: true }]
      : [{ step: "transfer", status: "sent" }]);
    const conv = h.rt.journal.conversation(h.event.conversation_id);
    const message = conv.messages.find(m => m.id === h.event.message_id)!;
    assert.equal(messageStatus(message, h.event, conv.notes[message.id])?.label, "转接成功");
    const attemptId = h.event.attempt!.attempt_id;
    h.mock.redeliver(h.message); await Promise.all([h.rt.refresh(), h.rt.refresh()]); await settle(h.rt);
    assert.equal(h.state.transfers.length, 1); assert.equal(h.state.claims.length, 1);
    assert.equal(h.event.attempt?.attempt_id, attemptId);
  });
}

test("普通回复在转接能力开启时也不读取名单或打开转接窗口", async () => {
  const h = await harness({ reply: true });
  assert.equal(h.state.discoveries, 0); assert.equal(h.state.stateReads, 0);
  assert.equal(h.state.transfers.length, 0); assert.equal(h.state.sends, 1);
  assert.equal(h.state.receipts[0].status, "sent");
});

test("转接执行前原始20秒已耗尽：不产生平台动作，回执为 not_sent", async () => {
  const h = await harness({ deadlineAtExecution: true });
  assert.equal(h.state.transfers.length, 0);
  assert.equal(h.event.attempt?.detail, "reply_deadline_exceeded");
  assert.equal(h.state.receipts[0].status, "not_sent");
});

test("后台取消收藏权限原样传递，执行前持久化意图，乐观成功仍为 unknown", async () => {
  const h = await harness({ allowUnmark: true, unmarkStart: true, result: "confirmed" });
  assert.equal(h.state.transfers[0].allow_unmark, true);
  assert.equal(h.state.receipts[0].status, "unknown");
  assert.deepEqual(h.state.receipts[0].steps, [{ step: "transfer", status: "not_sent", reason: "blocked_by_mark" }, { step: "unmark_and_transfer", status: "unknown", unmarked: null }]);
  h.mock.redeliver(h.message); await settle(h.rt); assert.equal(h.state.transfers.length, 1);
});

test("中断的取消收藏意图保留两步回执，不伪造取消结果", () => {
  const ev = { snapshot: { decision: { action: "transfer", transfer: { unmark_policy: { allow: true } } } }, attempt: { detail: "unmark_and_transfer" } } as any;
  assert.deepEqual(receiptExtra(ev, "unknown", "interrupted_during_send")!.steps,
    [{ step: "transfer", status: "not_sent", reason: "blocked_by_mark" }, { step: "unmark_and_transfer", status: "unknown", unmarked: null }]);
});

for (const reason of ["transfer_target_missing", "transfer_target_ambiguous", "conv_state_unavailable"]) {
  test(`执行时失败保留具体原因，不降级成后台人工建议：${reason}`, async () => {
    const h = await harness({ result: "not_sent", reason });
    assert.equal(h.event.snapshot?.decision?.action, "transfer");
    assert.equal(h.event.attempt?.detail, reason);
    assert.equal(h.state.receipts[0].status, "not_sent"); assert.equal(h.state.receipts[0].steps, undefined);
  });
}

test("转接解析拒绝旧编号、无效账号、非布尔权限及不一致版本", async () => {
  const h = await harness(); const base = h.event.snapshot!;
  for (const change of [{ unmark_policy: { allow: "false", version: 3 } }, { unmark_policy: { allow: false, version: 4 } },
    ...["", " ", " x", "x ", "x".repeat(41), null, []].map(account => ({ account })), { target_id: "legacy" }]) {
    const snap = parseSnapshot({ ...base, decision: { ...base.decision, transfer: { ...base.decision!.transfer, ...change } } });
    assert.equal(snap.decision!.action, "none");
  }
  const old = parseSnapshot({ ...base, decision: { ...base.decision, transfer: { target_id: "legacy", unmark_policy: { allow: false, version: 3 } } } });
  assert.equal(old.decision!.action, "none");
});

for (const completion of ["sent", "unmark_sent", "unknown"] as const) {
  test(`真实本机测试后台：${completion} 回执落库，终态消息重复推送不重转`, async () => {
    const unmark = completion === "unmark_sent";
    const expected = completion === "unknown" ? "unknown" : "sent";
    const backend = await startBackend();
    let h: Awaited<ReturnType<typeof makeShop>> | undefined;
    let transfers = 0;
    try {
      await backend.settings("shop-a", true, [{ id: "human", contains: "人工", handling: { action: "transfer", account: "fictional-main", allow_unmark: unmark } }] as any);
      h = await makeShop({ backend, login: false, declareTransfer: true, timing: { unknownCheckDelaysMs: [] } });
      (h.mock as any).transferConversation = async (request: TransferRequest) => {
        assert.equal(request.account, "fictional-main"); assert.equal(request.recheck(), null);
        transfers++;
        if (unmark) request.before_unmark!();
        return expected === "unknown" ? { status: "unknown", reason: "transfer_binding_unproven" }
          : { status: "confirmed", page_observed: "left_list", ...(unmark ? { unmarked: true } : {}) };
      };
      await h.mock.login(); await waitFor(() => h!.rt.transferExecutable(), "account capability");
      const message = h.mock.injectBuyerMessage({ conversation_id: "fictional-buyer", content: "人工" });
      await waitFor(() => eventsOf(h!.rt)[0]?.attempt?.receipt?.upload === "uploaded", "account transfer receipt");
      const ev = eventsOf(h.rt)[0];
      assert.equal(JSON.parse(ev.body).context.transfer_targets, undefined);
      assert.equal(JSON.parse(ev.body).context.conv_state, undefined);
      assert.equal(ev.snapshot?.decision?.transfer?.account, "fictional-main");
      const saved = await backend.events("shop-a");
      assert.equal(saved.length, 1); assert.equal(saved[0].delivery.status, expected);
      assert.equal(ev.attempt?.phase, expected);
      if (unmark) assert.equal(saved[0].delivery.steps[1].unmarked, true);
      await assert.rejects(() => h!.rt.backend.claim(ev.event_id,
        { instance_id: ev.instance_id, session_id: ev.session_id, generation: ev.generation }, "att-duplicate"),
        error => error instanceof BackendError && error.code === "delivery_terminal");
      h.mock.redeliver(message); await h.rt.refresh(); await settle(h.rt);
      assert.equal(transfers, 1);
    } finally {
      if (h) { await h.rt.stop(); fs.rmSync(h.dir, { recursive: true, force: true }); }
      await backend.stop();
    }
  });
}

for (const opts of [{ mode: "observe" }, { mode: "manual" }, { mode: "auto", takeover: true }] as const) {
  test(`${opts.mode}${"takeover" in opts ? " with takeover" : ""}：不准备名单、不领取、不转接`, async () => {
    const h = await harness(opts);
    assert.equal(h.state.discoveries, 0); assert.equal(h.state.claims.length, 0); assert.equal(h.state.transfers.length, 0);
  });
}
