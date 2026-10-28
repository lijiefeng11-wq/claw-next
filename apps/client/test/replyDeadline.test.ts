import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Journal, type StoredMessage } from "../src/core/journal.js";
import { ReplyTiming, REPLY_DEADLINE_REASON } from "../src/core/replyTiming.js";
import { DEFAULT_TIMING } from "../src/core/runtime.js";
import { messageStatus } from "../src/core/view.js";
import { eventsOf, makeShop, settle, startBackend, tempDir, withoutCapability, type Harness, type TestBackend } from "./helpers.js";

const stored = (first?: number): StoredMessage => ({ id: "message-1", stable: true, role: "buyer", kind: "text", content: "虚构", created_at: 1, received_at: 1, first_seen_at: first, live: true, session_id: "session-1" });

test("默认查询间隔为 500 ms", () => assert.equal(DEFAULT_TIMING.pollMs, 500));

test("单调计时不受墙钟调整或重复观察影响；重启只恢复剩余预算", () => {
  let mono = 0, wall = 100_000;
  const timing = new ReplyTiming(() => mono, () => wall), message = stored(wall);
  timing.observe(message, true); mono = 7000; wall += 3600_000;
  timing.observe(message, true); assert.equal(timing.remaining(message), 13000);
  wall = 107_000; const restarted = new ReplyTiming(() => 500, () => wall);
  restarted.observe(message); assert.equal(restarted.remaining(message), 13000);
  for (const first of [undefined, NaN, Infinity, 108_000, 1]) assert.equal(new ReplyTiming(() => 10, () => wall).remaining(stored(first)), 0);
});

test("首次观察时间持久化，旧日志缺失时间不获得新预算", () => {
  const dir = tempDir("claw-first-seen-");
  try {
    const first = new Journal(dir); first.addMessage("buyer-1", stored(100_000)); first.addMessage("buyer-2", stored()); first.close();
    const restored = new Journal(dir);
    const clock = new ReplyTiming(() => 10, () => 107_000);
    assert.equal(clock.remaining(restored.conversation("buyer-1").messages[0]), 13000);
    assert.equal(clock.remaining(restored.conversation("buyer-2").messages[0]), 0);
    restored.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

describe("虚构后台：20 秒发送开始截止", () => {
  let backend: TestBackend;
  const running: Harness[] = [];
  beforeEach(async () => { backend = await startBackend(); await backend.settings("shop-a", true); });
  afterEach(async () => { for (const h of running.splice(0)) { await h.rt.stop(); fs.rmSync(h.dir, { recursive: true, force: true }); } await backend.stop(); });
  // 本组只验证本地 20 秒限制：固定为不确认 reply_deadline 的旧后台组合；契约 A 组合见 replyDeadlineContract.test.ts。
  const shop = async (clock: () => number, log?: (line: string) => void) => {
    const h = await makeShop({ backend, monotonicNow: clock, log, fetchImpl: withoutCapability("reply_deadline") }); running.push(h); return h;
  };

  test("准备阶段按剩余预算等待，超时不提交，也不冻结同一买家的新消息", async () => {
    let mono = 0;
    const h = await shop(() => mono);
    const history = h.mock.fetchHistory.bind(h.mock);
    h.mock.fetchHistory = async (id) => { const result = await history(id); mono += 19_000; return result; };
    const waits: number[] = [];
    // 自动模式且能力已确认：订单在收集候选时一并确认，等待受剩余预算约束。
    const options = h.mock.sendOptionsSettled.bind(h.mock);
    h.mock.sendOptionsSettled = async (_id, ms) => { waits.push(ms ?? -1); mono += 1000; };
    const old = h.mock.injectBuyerMessage({ conversation_id: "budget-buyer", content: "营业时间" });
    await settle(h.rt);
    assert.deepEqual(waits, [1000]); assert.equal(eventsOf(h.rt).length, 0); assert.equal(h.mock.platformSends.length, 0);
    const conv = h.rt.journal.conversation("budget-buyer");
    assert.equal(conv.notes[old.platform_message_id!], REPLY_DEADLINE_REASON); assert.equal(conv.takeover, false);
    assert.equal(messageStatus(conv.messages[0], undefined, conv.notes[old.platform_message_id!])?.label, "本条待人工");
    const originalSeen = conv.messages[0].first_seen_at;
    h.mock.redeliver(old); await settle(h.rt); assert.equal(conv.messages[0].first_seen_at, originalSeen);
    h.mock.fetchHistory = history; h.mock.sendOptionsSettled = options;
    h.mock.injectBuyerMessage({ conversation_id: "budget-buyer", content: "营业时间" }); await settle(h.rt);
    assert.equal(h.mock.platformSends.length, 1); assert.equal(conv.takeover, false);
  });

  test("准备的候选等待也只使用剩余预算", async () => {
    let mono = 0;
    const h = await shop(() => mono);
    const history = h.mock.fetchHistory.bind(h.mock);
    h.mock.fetchHistory = async (id) => { const result = await history(id); mono = 18_500; return result; };
    let budget = 0;
    h.mock.sendOptionsSettled = async (_id, ms) => { budget = ms ?? 0; mono = 20_000; };
    h.mock.injectBuyerMessage({ conversation_id: "option-budget", content: "营业时间" }); await settle(h.rt);
    assert.equal(budget, 1500); assert.equal(eventsOf(h.rt).length, 0); assert.equal(h.mock.platformSends.length, 0);
  });

  test("提交后到期不 claim；本地超时不伪造取消请求或发送回执", async () => {
    let mono = 0;
    const h = await shop(() => mono);
    const submit = h.rt.backend.submitEvent.bind(h.rt.backend);
    h.rt.backend.submitEvent = async (body) => {
      assert.equal(JSON.parse(body).remaining_budget_ms, undefined);
      assert.equal(JSON.parse(body).first_seen_at, undefined);
      const result = await submit(body); mono = 20_000; return result;
    };
    h.mock.injectBuyerMessage({ conversation_id: "preclaim", content: "营业时间" }); await settle(h.rt);
    const ev = eventsOf(h.rt)[0]; assert.equal(ev.blocked, REPLY_DEADLINE_REASON); assert.equal(ev.attempt, null);
    assert.equal(h.mock.platformSends.length, 0);
  });

  test("等待 claim 时到期，只报告 not_sent，不调用平台", async () => {
    let mono = 0;
    const h = await shop(() => mono);
    const claim = h.rt.backend.claim.bind(h.rt.backend);
    h.rt.backend.claim = async (...args) => { const result = await claim(...args); mono = 20_000; return result; };
    h.mock.injectBuyerMessage({ conversation_id: "claim-budget", content: "营业时间" }); await settle(h.rt);
    const ev = eventsOf(h.rt)[0];
    assert.equal(ev.attempt?.phase, "aborted_before_send"); assert.equal(ev.attempt?.detail, REPLY_DEADLINE_REASON);
    assert.equal(ev.attempt?.receipt?.status, "not_sent"); assert.equal(ev.attempt?.receipt?.upload, "uploaded");
    assert.equal(h.mock.platformSends.length, 0); assert.equal(h.rt.journal.conversation("claim-budget").takeover, false);
  });

  test("适配器准备到点击间到期，再核验阻止文字发送", async () => {
    let mono = 0;
    const h = await shop(() => mono), send = h.mock.send.bind(h.mock);
    h.mock.send = async (request) => { mono = 20_000; return send(request); };
    h.mock.injectBuyerMessage({ conversation_id: "click-budget", content: "营业时间" }); await settle(h.rt);
    assert.equal(h.mock.platformSends.length, 0); assert.equal(eventsOf(h.rt)[0].attempt?.detail, REPLY_DEADLINE_REASON);
    assert.equal(eventsOf(h.rt)[0].attempt?.receipt?.status, "not_sent");
  });

  test("第 19 秒开始可以完成；第 20 秒不会中断已开始发送，摘要只含引用与耗时", async () => {
    let mono = 0;
    const logs: string[] = [], h = await shop(() => mono, (line) => logs.push(line));
    const claim = h.rt.backend.claim.bind(h.rt.backend), send = h.mock.send.bind(h.mock);
    h.rt.backend.claim = async (...args) => { const result = await claim(...args); mono = 19_000; return result; };
    h.mock.send = async (request) => { const result = await send(request); mono = 21_000; return result; };
    h.mock.injectBuyerMessage({ conversation_id: "private-buyer-canary", content: "营业时间 private-message-canary" }); await settle(h.rt);
    assert.equal(h.mock.platformSends.length, 1); assert.equal(eventsOf(h.rt)[0].attempt?.phase, "sent");
    const summaries = logs.filter((line) => line.startsWith("timing_summary "));
    assert.equal(summaries.length, 1); assert.ok(!summaries[0].includes("private-buyer-canary") && !summaries[0].includes("private-message-canary"));
    const summary = JSON.parse(summaries[0].slice("timing_summary ".length));
    assert.equal(summary.total_ms, 21000); assert.equal(summary.over_10s, true); assert.equal(summary.abandoned, false);
    assert.equal(summary.slowest, "claim"); assert.ok("receipt" in summary.stages_ms);
  });

  test("unknown 经过截止和重复发现后保持原结果，新的买家消息仍可发送", async () => {
    let mono = 0;
    const h = await shop(() => mono);
    h.mock.sendBehavior = "ack_without_id";
    const message = h.mock.injectBuyerMessage({ conversation_id: "unknown-buyer", content: "营业时间" }); await settle(h.rt);
    const old = eventsOf(h.rt)[0], attempt = JSON.stringify(old.attempt);
    mono = 50_000; h.mock.redeliver(message); await settle(h.rt);
    assert.equal(JSON.stringify(old.attempt), attempt); assert.equal(h.mock.platformSends.length, 1);
    h.mock.sendBehavior = "confirm"; h.mock.injectBuyerMessage({ conversation_id: "unknown-buyer", content: "营业时间" }); await settle(h.rt);
    assert.equal(h.mock.platformSends.length, 2); assert.equal(old.attempt?.phase, "unknown");
  });
});
