import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { FetchLike } from "../src/core/backend.js";
import type { TransferRequest } from "../src/core/adapter.js";
import { parseSnapshot } from "../src/core/protocol.js";
import { receiptExtra, ShopRuntime } from "../src/core/runtime.js";
import { makeShop, eventsOf, waitFor, settle, type TestBackend } from "./helpers.js";

const targets = () => [{ target_id: "t-main", name: "fictional-main", observed_at: Date.now() / 1000 }];
const running: ShopRuntime[] = [];
afterEach(async () => { for (const rt of running.splice(0)) await rt.stop(false); });

async function harness(opts: { declare?: boolean; confirm?: boolean; target?: string; marked?: boolean | null; allowUnmark?: boolean; staleAtDecision?: boolean; cleanupReply?: boolean; mode?: "auto" | "observe" | "manual"; takeover?: boolean; result?: "unknown" | "confirmed" | "not_sent" } = {}) {
  const state = { heartbeats: [] as any[], bodies: [] as any[], claims: [] as any[], receipts: [] as any[], transfers: [] as TransferRequest[], discoveries: 0, discoveryBusy: false, submittedDuringCleanup: false, sends: 0, events: new Map<string, any>() };
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (input: any, init?: any) => {
    const p = new URL(String(input)).pathname, body = init?.body ? JSON.parse(init.body) : null, now = Date.now() / 1000;
    if (p === "/health") return response({ service: "claw-next", status: "ok", protocol_version: "1.0" });
    if (p === "/api/v1/me") return response({ role: "client", client_id: "client-a", shop_id: "shop-a", protocol_version: "1.0" });
    if (p === "/api/v1/heartbeat") {
      state.heartbeats.push(body);
      return response({ shop_id: "shop-a", client_id: "client-a", instance_id: body.instance_id, session_id: body.session_id, generation: 1, expires_at: now + 60, capabilities: opts.confirm === false ? [] : ["transfer_conversation"] });
    }
    if (p === "/api/v1/events") {
      state.submittedDuringCleanup ||= state.discoveryBusy;
      if (opts.staleAtDecision) for (const list of (h.rt as any).eventTransferTargets.values()) for (const target of list) target.observed_at -= 31;
      state.bodies.push(body);
      const snap = { event_id: body.event_id, shop_id: "shop-a", client_id: "client-a", conversation_id: body.conversation_id, message_id: body.message_id, context_revision: body.context_revision, session_id: body.session_id, generation: 1, state: "ready", decision: { action: "transfer", transfer: { target_id: opts.target ?? "t-main", unmark_policy: { allow: opts.allowUnmark ?? false, version: 3 } }, policy_version: 3, reason: "fallback:unhandled", expires_at: now + 60 }, delivery: { status: "unclaimed", attempt_id: null, platform_message_id: null }, created_at: now };
      if (opts.cleanupReply) snap.decision = { action: "reply", text: "虚构短回复", reason: "rule:reply", expires_at: now + 60 } as any;
      state.events.set(body.event_id, snap); return response(snap, 202);
    }
    const m = /\/events\/([^/]+)(?:\/(claim|receipt))?$/.exec(p), snap = m && state.events.get(m[1]);
    if (snap && m![2] === "claim") { state.claims.push(body); snap.delivery = { status: "claimed", attempt_id: body.attempt_id, platform_message_id: null, claim_expires_at: now + 10 }; return response(snap); }
    if (snap && m![2] === "receipt") { state.receipts.push(body); snap.delivery.status = body.status; return response(snap); }
    if (snap) return response(snap);
    return response({ error: { code: "not_found" } }, 404);
  }) as FetchLike;
  const h = await makeShop({ backend: { url: "http://127.0.0.1:9" } as TestBackend, fetchImpl, login: false, mode: opts.mode, declareTransfer: opts.declare !== false, ...(opts.cleanupReply ? { timing: { prepBudgetMs: 20 } } : {}) });
  running.push(h.rt);
  (h.mock as any).readConvState = async () => ({ marked: opts.marked === undefined ? false : opts.marked, color: null });
  (h.mock as any).readTransferTargets = async () => {
    state.discoveries++;
    if (opts.cleanupReply) {
      state.discoveryBusy = true;
      try { await new Promise(resolve => setTimeout(resolve, 100)); } finally { state.discoveryBusy = false; }
    }
    return targets();
  };
  (h.mock as any).transferConversation = async (request: TransferRequest) => {
    const blocked = request.recheck();
    if (blocked) return { status: "not_sent", reason: blocked };
    state.transfers.push(request);
    return opts.result === "confirmed" ? { status: "confirmed", page_observed: "left_list" } : opts.result === "not_sent" ? { status: "not_sent", reason: "conv_state_changed" } : { status: "unknown", reason: "transfer_binding_unproven", page_observed: "left_list" };
  };
  (h.mock as any).send = async () => {
    state.sends++;
    if (opts.cleanupReply) return state.discoveryBusy ? { status: "not_sent", reason: "pdd_send_busy" } : { status: "confirmed", platform_message_id: "fictional-reply-1" };
    return { status: "unknown", reason: "unexpected_text_send" };
  };
  await h.mock.login(); await waitFor(() => h.rt.lease.state === "held", "lease");
  if (opts.takeover) { h.rt.journal.conversation("buyer-1"); h.rt.setTakeover("buyer-1", true); }
  h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "虚构售后问题" });
  await waitFor(() => state.bodies.length > 0, "submit");
  await waitFor(() => eventsOf(h.rt)[0]?.snapshot?.state === "ready", "ready");
  await settle(h.rt);
  return { ...h, state, event: eventsOf(h.rt)[0] };
}

test("transfer requires both explicit declaration and negotiated capability", async () => {
  for (const opts of [{ declare: false }, { confirm: false }]) {
    const h = await harness(opts); assert.equal(h.rt.transferExecutable(), false); assert.equal(h.state.claims.length, 0); assert.equal(h.state.transfers.length, 0);
  }
});

test("target list and readable state are frozen in this event; unknown transfers once with no chat/message ID", async () => {
  const h = await harness();
  assert.equal(h.state.bodies[0].context.conv_state.marked, false);
  assert.equal(h.state.bodies[0].context.transfer_targets[0].name, "fictional-main");
  assert.equal(h.state.transfers.length, 1); assert.equal(h.state.sends, 0);
  assert.equal(h.state.receipts.length, 1); assert.equal(h.state.receipts[0].status, "unknown");
  assert.deepEqual(h.state.receipts[0].steps, [{ step: "transfer", status: "unknown" }]);
  assert.equal(h.state.receipts[0].platform_message_id, undefined);
  await settle(h.rt); assert.equal(h.state.transfers.length, 1);
});

for (const [label, opts] of [["unknown state", { marked: null }], ["already marked", { marked: true }], ["unretained target", { target: "other" }], ["expired original observation", { staleAtDecision: true }], ["unsupported unmark", { allowUnmark: true }]] as const) {
  test(`${label}: zero claim and zero platform operation`, async () => { const h = await harness(opts); assert.equal(h.state.claims.length, 0); assert.equal(h.state.transfers.length, 0); assert.equal(h.state.sends, 0); });
}

test("not started receipt omits steps; normal reply remains unaffected", async () => {
  const h = await harness({ result: "not_sent" }); assert.equal(h.state.receipts[0].status, "not_sent"); assert.equal(h.state.receipts[0].steps, undefined); assert.equal(h.state.receipts[0].reason, "conv_state_changed");
  const ev = { snapshot: { decision: { action: "reply" } } } as any; assert.equal(receiptExtra(ev, "sent", null), undefined);
});

test("transfer parser rejects malformed booleans and mismatched policy versions", async () => {
  const h = await harness(); const base = h.event.snapshot!;
  for (const change of [{ unmark_policy: { allow: "false", version: 3 } }, { unmark_policy: { allow: false, version: 4 } }, { target_id: " " }]) {
    const snap = parseSnapshot({ ...base, decision: { ...base.decision, transfer: { ...base.decision!.transfer, ...change } } }); assert.equal(snap.decision!.action, "none");
  }
});


test("ordinary reply waits for bounded discovery cleanup even after preparation budget expires", async () => {
  const h = await harness({ cleanupReply: true });
  assert.equal(h.state.submittedDuringCleanup, false); assert.equal(h.state.sends, 1);
  assert.equal(h.state.transfers.length, 0); assert.equal(h.state.receipts[0].status, "sent");
});

for (const opts of [{ mode: "observe" }, { mode: "manual" }, { mode: "auto", takeover: true }] as const) {
  test(`${opts.mode}${"takeover" in opts ? " with takeover" : ""}: no transfer-dialog discovery or operation`, async () => {
    const h = await harness(opts);
    assert.equal(h.state.discoveries, 0); assert.equal(h.state.claims.length, 0); assert.equal(h.state.transfers.length, 0);
    assert.equal(h.state.bodies[0].context.transfer_targets, undefined);
  });
}
