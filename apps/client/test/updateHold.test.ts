import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { FetchLike } from "../src/core/backend.js";
import { ShopRuntime, UPDATE_HOLD_REASON } from "../src/core/runtime.js";
import { TestBackend, eventsOf, makeShop, settle, startBackend, waitFor } from "./helpers.js";

// 客户端安装更新期间的全局保持（#34 条件 4）：与真实的仓库后台（Python）联调；全部是虚构店铺与虚构消息。
// 保持由主进程统一提供（一个读取函数），对已有和之后新建的运行时同时生效。

let backend: TestBackend;
const running: ShopRuntime[] = [];
let hold = false;

async function shop(opts: Omit<Parameters<typeof makeShop>[0], "backend"> = {}) {
  const h = await makeShop({ backend, updateHold: () => hold, ...opts });
  running.push(h.rt);
  return h;
}

/** 按请求路径在转发前执行动作（例如在提交事件或申请许可的那一刻进入“更新中”）。 */
function onRequest(rule: (url: string, method: string) => void, base: FetchLike = fetch): FetchLike {
  return (async (input: any, init?: any) => {
    rule(String(input), init?.method ?? "GET");
    return base(input, init);
  }) as FetchLike;
}

beforeEach(async () => {
  hold = false;
  backend = await startBackend();
  await backend.settings("shop-a", true);
  await backend.settings("shop-b", true);
});

afterEach(async () => {
  hold = false;
  for (const rt of running.splice(0)) await rt.stop(false);
  await backend.stop();
});

describe("更新中：不再开始新的平台动作", () => {
  test("进入更新中后新到的消息：不准备、不提交、不发送，记原因", async () => {
    const { rt, mock } = await shop();
    let reads = 0;
    const fetchHistory = mock.fetchHistory.bind(mock);
    mock.fetchHistory = async (c: string) => {
      reads += 1;
      return fetchHistory(c);
    };
    hold = true;
    const m = mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => rt.journal.conversation("buyer-1").notes[m.platform_message_id as string] === UPDATE_HOLD_REASON, "note");
    await settle(rt);
    assert.equal(reads, 0, "不读页面历史");
    assert.equal(eventsOf(rt).length, 0);
    assert.equal(mock.platformSends.length, 0);
    assert.equal((await backend.events("shop-a")).length, 0);
  });

  test("准备途中进入更新中：不提交新事件", async () => {
    const { rt, mock } = await shop();
    const fetchHistory = mock.fetchHistory.bind(mock);
    mock.fetchHistory = async (c: string) => {
      hold = true;
      return fetchHistory(c);
    };
    const m = mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => rt.journal.conversation("buyer-1").notes[m.platform_message_id as string] === UPDATE_HOLD_REASON, "note");
    await settle(rt);
    assert.equal(eventsOf(rt).length, 0);
    assert.equal((await backend.events("shop-a")).length, 0);
  });

  test("事件已提交、决定在更新中才回来：不申请许可、不发送", async () => {
    const { rt, mock } = await shop({ fetchImpl: onRequest((url, method) => method === "POST" && url.endsWith("/api/v1/events") && (hold = true)) });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt)[0]?.blocked === UPDATE_HOLD_REASON, "blocked");
    await settle(rt);
    assert.equal(eventsOf(rt)[0].attempt, null);
    assert.equal(mock.platformSends.length, 0);
    const [server] = await backend.events("shop-a");
    assert.equal(server.delivery.status, "unclaimed");
  });

  test("申请许可的同时进入更新中：许可之后的再核验拦下，未点击（not_sent），不发送", async () => {
    const { rt, mock } = await shop({ fetchImpl: onRequest((url, method) => method === "POST" && url.endsWith("/claim") && (hold = true)) });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt)[0]?.attempt?.receipt?.upload === "uploaded", "receipt");
    const ev = eventsOf(rt)[0];
    assert.equal(ev.attempt?.phase, "aborted_before_send");
    assert.equal(ev.attempt?.detail, UPDATE_HOLD_REASON);
    assert.equal(ev.attempt?.receipt?.status, "not_sent");
    assert.equal(mock.platformSends.length, 0);
  });

  test("平台账号切换（重新登录）后仍在更新中：新消息照样不处理", async () => {
    const { rt, mock } = await shop();
    hold = true;
    await mock.logout();
    await mock.login();
    const m = mock.injectBuyerMessage({ conversation_id: "buyer-2", content: "营业时间？" });
    await waitFor(() => rt.journal.conversation("buyer-2").notes[m.platform_message_id as string] === UPDATE_HOLD_REASON, "note");
    assert.equal(eventsOf(rt).length, 0);
  });

  test("更新中新连接的店铺：同样受保持约束", async () => {
    hold = true;
    const { rt, mock } = await shop({ shop: "shop-b" });
    const m = mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => rt.journal.conversation("buyer-1").notes[m.platform_message_id as string] === UPDATE_HOLD_REASON, "note");
    assert.equal(eventsOf(rt).length, 0);
    assert.equal(mock.platformSends.length, 0);
  });

  test("解除保持后恢复正常处理", async () => {
    const { rt, mock } = await shop();
    hold = true;
    hold = false;
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt)[0]?.attempt?.receipt?.upload === "uploaded", "receipt");
    assert.equal(mock.platformSends.length, 1);
  });
});

describe("等已有任务归结（idleForUpdate）", () => {
  test("发送进行中不算空闲；超时成 unknown 后保持原样、不重发，回执上传完才空闲", async () => {
    const { rt, mock } = await shop();
    mock.sendBehavior = "timeout_after_call";
    assert.equal(rt.idleForUpdate(), true);
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt)[0]?.attempt?.phase === "sending", "sending");
    hold = true;
    assert.equal(rt.idleForUpdate(), false);
    await waitFor(() => rt.idleForUpdate(), "idle");
    const ev = eventsOf(rt)[0];
    assert.equal(ev.attempt?.phase, "unknown");
    assert.equal(ev.attempt?.receipt?.upload, "uploaded");
    assert.equal(mock.platformSends.length, 1, "unknown 不重发");
  });

  test("回执还没上传成功（后台暂时不可用）不算空闲；上传成功后才空闲", async () => {
    let down = false;
    const { rt, mock } = await shop({
      fetchImpl: (async (input: any, init?: any) => {
        if (down && String(input).endsWith("/receipt")) return new Response(JSON.stringify({ error: { code: "unavailable" } }), { status: 503, headers: { "Content-Type": "application/json" } });
        return fetch(input, init);
      }) as FetchLike,
      timing: { heartbeatMs: 200 },
    });
    down = true;
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt)[0]?.attempt?.phase === "sent", "sent");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(eventsOf(rt)[0].attempt?.receipt?.upload, "pending");
    assert.equal(rt.idleForUpdate(), false);
    down = false;
    await waitFor(() => rt.idleForUpdate(), "idle");
    assert.equal(eventsOf(rt)[0].attempt?.receipt?.upload, "uploaded");
  });
});
