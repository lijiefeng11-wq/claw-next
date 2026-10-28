import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { PlatformMessage } from "../src/core/adapter.js";
import { matchesTarget } from "../src/core/runtime.js";
import { messageStatus, unknownStatus } from "../src/core/view.js";
import { HOURS_REPLY, eventsOf, makeShop, settle, startBackend, waitFor, type Harness, type TestBackend } from "./helpers.js";

// 发送结果不确定后的自动核对：只读聊天记录给人工提示，不改 unknown、不上报、不重发。全部为虚构数据。

describe("unknown 自动核对聊天记录", () => {
  let backend: TestBackend;
  const running: Harness[] = [];
  beforeEach(async () => { backend = await startBackend(); await backend.settings("shop-a", true); });
  afterEach(async () => { for (const h of running.splice(0)) { await h.rt.stop(); fs.rmSync(h.dir, { recursive: true, force: true }); } await backend.stop(); });
  const shop = async (log?: (line: string) => void) => { const h = await makeShop({ backend, log }); running.push(h); return h; };
  /** 让模拟平台返回 unknown；appear=true 时平台记录里随后出现这条客服消息（相当于其实发出去了）。 */
  /** later=true：发送后平台记录里还出现一条 60 秒后的消息，使同一页能证明覆盖了发送前后。 */
  const unknownSend = (h: Harness, appear: boolean, later = !appear) => {
    h.mock.sendBehavior = "ack_without_id";
    const send = h.mock.send.bind(h.mock);
    h.mock.send = async (req) => {
      if (appear) h.mock.addAgentHistory(req.conversation_id, req.text);
      const r = await send(req);
      if (later) h.mock.addHistoryMessage({ conversation_id: req.conversation_id, platform_message_id: `later-${Date.now()}`, role: "system", kind: "text", content: "虚构系统提示", created_at: Date.now() / 1000 + 60 });
      return r;
    };
  };
  const checked = async (h: Harness) => { await waitFor(() => !!eventsOf(h.rt)[0]?.check, "check"); return eventsOf(h.rt)[0]; };

  test("记录里出现同一条回复：标为已看到，仍是 unknown，不重发、不改回执", async () => {
    const logs: string[] = [];
    const h = await shop((l) => logs.push(l));
    unknownSend(h, true);
    h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    const ev = await checked(h);
    assert.equal(ev.check?.result, "seen");
    assert.equal(ev.attempt?.phase, "unknown");
    assert.equal(ev.attempt?.receipt?.status, "unknown");
    await settle(h.rt);
    assert.equal(h.mock.platformSends.length, 1);
    assert.equal((await backend.events("shop-a"))[0].delivery.status, "unknown");
    const conv = h.rt.journal.conversation("buyer-1");
    assert.equal(messageStatus(conv.messages[0], ev, undefined)?.label, "待核查·记录里已看到");
    const stats = logs.filter((l) => l.startsWith("unknown_stats "));
    assert.equal(stats.length, 1);
    assert.deepEqual(JSON.parse(stats[0].slice("unknown_stats ".length)), { total: 1, by_reason: { "text:platform_ack_without_message_id": 1 } });
    assert.ok(!logs.some((l) => l.includes(HOURS_REPLY)), "日志不含回复正文");
  });

  test("记录已刷新但没有这条回复：标为没看到，提示人工补发，不自动重发", async () => {
    const h = await shop();
    unknownSend(h, false);
    h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    const ev = await checked(h);
    assert.equal(ev.check?.result, "not_seen");
    await settle(h.rt);
    assert.equal(h.mock.platformSends.length, 1);
    assert.equal(messageStatus(h.rt.journal.conversation("buyer-1").messages[0], ev, undefined)?.label, "待核查·记录里没看到");
  });

  test("发送前就有的同一句回复不算：只比对发送后新出现的客服消息", async () => {
    const h = await shop();
    h.mock.injectAgentReply("buyer-1", HOURS_REPLY);
    await settle(h.rt);
    unknownSend(h, false);
    h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    const ev = await checked(h);
    assert.equal(ev.check?.result, "not_seen");
  });

  test("发送后聊天记录一直没刷新：到最后一次仍不下结论，标为无法核对", async () => {
    const h = await shop();
    unknownSend(h, true);
    h.mock.historyLoadedAtMs = 0;
    h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    const ev = await checked(h);
    assert.deepEqual([ev.check?.result, ev.check?.detail], ["unavailable", "history_not_refreshed"]);
    assert.equal(h.mock.platformSends.length, 1);
  });

  test("只在发送打开对话时加载过、发送返回后没再刷新：不当作“没看到”，最终标无法核对", async () => {
    const h = await shop();
    h.mock.sendBehavior = "ack_without_id";
    const send = h.mock.send.bind(h.mock);
    // 发送调用内（点击前）页面加载过一次聊天记录，之后再没刷新。
    h.mock.send = async (req) => { h.mock.historyLoadedAtMs = Date.now(); return send(req); };
    h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    const ev = await checked(h);
    assert.deepEqual([ev.check?.result, ev.check?.detail], ["unavailable", "history_not_refreshed"]);
  });

  test("第一次核对没看到时不下结论，第二次刷新后看到就标已看到", async () => {
    // 第二次核对放在 2 秒后，留足时间在两次核对之间补上记录（避免慢机器上的竞态）。
    const h = await makeShop({ backend, timing: { unknownCheckDelaysMs: [150, 2000] } });
    running.push(h);
    unknownSend(h, false);
    h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(h.rt)[0]?.attempt?.phase === "unknown", "unknown");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(eventsOf(h.rt)[0].check, undefined);
    h.mock.addAgentHistory("buyer-1", HOURS_REPLY);
    const ev = await checked(h);
    assert.equal(ev.check?.result, "seen");
  });

  // 后台 agent 在 #48 复现的三种情况：加载时间晚于发送返回，但加载的只是旧分页，不能证明覆盖发送前后。
  for (const [name, loads] of [
    ["发送后只加载了旧分页（不含触发消息、最新消息早于发送）", (trigger: string, now: number) => [{ at: now, ids: ["old-1"], newest: now / 1000 - 20, dropped: 0 }]],
    ["发送前加载过完整记录、发送后只加载旧分页", (trigger: string, now: number) => [{ at: now - 60_000, ids: [trigger], newest: now / 1000 - 1, dropped: 0 }, { at: now, ids: ["old-1"], newest: now / 1000 - 20, dropped: 0 }]],
    ["发送后那一页含触发消息也有之后的消息，但有被丢弃的消息", (trigger: string, now: number) => [{ at: now, ids: [trigger, "later"], newest: now / 1000 + 60, dropped: 1 }]],
    ["发送后那一页含触发消息，但没有晚于发送 30 秒以上的消息", (trigger: string, now: number) => [{ at: now, ids: [trigger], newest: now / 1000 + 5, dropped: 0 }]],
  ] as const) {
    test(`覆盖未证明：${name} → 标无法确认，不引导补发`, async () => {
      const h = await shop();
      unknownSend(h, false, false);
      const m = h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
      await waitFor(() => eventsOf(h.rt)[0]?.attempt?.phase === "unknown", "unknown");
      h.mock.historyLoadsOverride = [...loads(m.platform_message_id!, Date.now())];
      const ev = await checked(h);
      assert.deepEqual([ev.check?.result, ev.check?.detail], ["unavailable", "coverage_unproven"]);
      assert.doesNotMatch(messageStatus(h.rt.journal.conversation("buyer-1").messages[0], ev, undefined)!.reason, /补发/);
      assert.equal(h.mock.platformSends.length, 1);
    });
  }

  test("核对结论随本地日志恢复，重启后不再核对也不重发", async () => {
    const h = await shop();
    unknownSend(h, true);
    h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    const ev = await checked(h);
    await h.rt.stop();
    running.splice(running.indexOf(h), 1);
    const again = await makeShop({ backend, dir: h.dir });
    running.push(again);
    const restored = eventsOf(again.rt).find((e) => e.event_id === ev.event_id);
    assert.deepEqual(restored?.check, ev.check);
    assert.equal(again.mock.platformSends.length, 0);
  });
});

describe("unknown 核对：比对规则与界面文字", () => {
  const msg = (m: Partial<PlatformMessage>): PlatformMessage => ({ conversation_id: "c", platform_message_id: "m", role: "agent", kind: "text", content: "", created_at: 1, ...m });
  test("文字按全文比对，忽略空白差异；部分相同不算", () => {
    assert.ok(matchesTarget(msg({ content: "您好， 营业时间\n9 点" }), { kind: "text", text: "您好，营业时间9点" }));
    assert.ok(!matchesTarget(msg({ content: "您好，营业时间9点。另外…" }), { kind: "text", text: "您好，营业时间9点" }));
    assert.ok(!matchesTarget(msg({ content: "" }), { kind: "text", text: "  " }));
  });
  test("附加内容按候选名称/商品标题出现在非文字消息中", () => {
    const option = { type: "instruction" as const, key: "k", goods_title: "虚构商品", name: "虚构说明书", observed_at: 1 };
    assert.ok(matchesTarget(msg({ kind: "card", card: { type: "goods", title: "虚构说明书" } }), { kind: "item", option }));
    assert.ok(!matchesTarget(msg({ kind: "text", content: "虚构说明书" }), { kind: "item", option }));
    assert.ok(!matchesTarget(msg({ kind: "card", card: { type: "goods", title: "别的说明书" } }), { kind: "item", option }));
  });
  test("界面：都写明不会自动重发；未核对时不声称正在核对", () => {
    for (const check of [undefined, "seen", "not_seen", "unavailable"] as const) {
      const s = unknownStatus("平台未返回消息编号", check ? { attempt_id: "a", result: check, detail: "", at: 1 } : undefined);
      assert.match(s.reason, /不会(自动)?重发/);
      assert.ok(!s.reason.includes("正在"));
    }
  });
});
