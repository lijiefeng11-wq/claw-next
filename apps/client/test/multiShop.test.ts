import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ShopRuntime } from "../src/core/runtime.js";
import { HOURS_REPLY, TestBackend, eventsOf, makeShop, settle, startBackend, waitFor } from "./helpers.js";

// 多店同时运行的故障隔离（docs/store-acceptance.md 第 2 节“待补”各项）：
// 与真实的仓库后台（Python）联调，两家虚构店铺各用模拟平台；全部是虚构店铺与虚构消息。

let backend: TestBackend;
const running: ShopRuntime[] = [];

async function shop(opts: Omit<Parameters<typeof makeShop>[0], "backend"> = {}) {
  const h = await makeShop({ backend, ...opts });
  running.push(h.rt);
  return h;
}

const uploaded = (rt: ShopRuntime, n: number) => eventsOf(rt).filter((e) => e.attempt?.receipt?.upload === "uploaded").length >= n;

beforeEach(async () => {
  backend = await startBackend();
  await backend.settings("shop-a", true);
  await backend.settings("shop-b", true);
});

afterEach(async () => {
  for (const rt of running.splice(0)) await rt.stop(false);
  await backend.stop();
});

describe("多店故障隔离", () => {
  test("A 店平台登录失效：A 店不提交、不发送，B 店照常收发", async () => {
    const a = await shop({ shop: "shop-a" });
    const b = await shop({ shop: "shop-b" });
    a.mock.expire();
    const ma = a.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    b.mock.injectBuyerMessage({ conversation_id: "buyer-2", content: "营业时间？" });
    await waitFor(() => uploaded(b.rt, 1), "b sent");
    await settle(a.rt);
    assert.equal(b.mock.platformSends.length, 1);
    assert.equal(b.mock.platformSends[0].text, HOURS_REPLY);
    assert.equal(eventsOf(a.rt).length, 0);
    assert.equal(a.mock.platformSends.length, 0);
    // 登录失效的页面收不到新消息：A 店记录里没有这条，也就不会提交或发送。
    assert.ok(!a.rt.journal.hasMessage("buyer-1", ma.platform_message_id as string));
    assert.equal(b.rt.lease.state, "held");
    assert.equal((await backend.events("shop-a")).length, 0);
  });

  test("两店出现相同的买家会话编号：各店只在本店平台发送，事件与记录不串店", async () => {
    const a = await shop({ shop: "shop-a" });
    const b = await shop({ shop: "shop-b" });
    const ma = a.mock.injectBuyerMessage({ conversation_id: "buyer-same", content: "营业时间？" });
    const mb = b.mock.injectBuyerMessage({ conversation_id: "buyer-same", content: "营业时间是几点？" });
    await waitFor(() => uploaded(a.rt, 1) && uploaded(b.rt, 1), "both sent");
    assert.equal(a.mock.platformSends.length, 1);
    assert.equal(b.mock.platformSends.length, 1);
    // 各店记录里只有本店平台的消息。
    const ids = (rt: ShopRuntime) => rt.journal.conversation("buyer-same").messages.map((m) => m.id);
    assert.ok(ids(a.rt).includes(ma.platform_message_id as string));
    assert.ok(!ids(a.rt).includes(mb.platform_message_id as string));
    assert.ok(ids(b.rt).includes(mb.platform_message_id as string));
    assert.ok(!ids(b.rt).includes(ma.platform_message_id as string));
    // 后台事件各归各店，触发消息各是本店的那条。
    const [ea] = await backend.events("shop-a");
    const [eb] = await backend.events("shop-b");
    assert.equal(ea.message_id, ma.platform_message_id);
    assert.equal(eb.message_id, mb.platform_message_id);
    assert.equal((await backend.events("shop-a")).length, 1);
    assert.equal((await backend.events("shop-b")).length, 1);
  });

  test("A 店出现 unknown：只锁定该条事件，不重发；A 店其他买家与 B 店照常发送", async () => {
    const a = await shop({ shop: "shop-a" });
    const b = await shop({ shop: "shop-b" });
    a.mock.sendBehavior = "ack_without_id";
    a.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(a.rt)[0]?.attempt?.phase === "unknown" && uploaded(a.rt, 1), "a unknown");
    a.mock.sendBehavior = "confirm";
    a.mock.injectBuyerMessage({ conversation_id: "buyer-2", content: "营业时间？" });
    b.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => uploaded(a.rt, 2) && uploaded(b.rt, 1), "others sent");
    await settle(a.rt);
    const unknownEv = eventsOf(a.rt).find((e) => e.conversation_id === "buyer-1");
    assert.equal(unknownEv?.attempt?.phase, "unknown");
    assert.equal(a.mock.platformSends.filter((s) => s.conversation_id === "buyer-1").length, 1, "unknown 不重发");
    assert.equal(a.mock.platformSends.filter((s) => s.conversation_id === "buyer-2").length, 1);
    assert.equal(eventsOf(a.rt).find((e) => e.conversation_id === "buyer-2")?.attempt?.phase, "sent");
    assert.equal(b.mock.platformSends.length, 1);
    assert.equal(eventsOf(b.rt)[0].attempt?.phase, "sent");
  });

  test("断开 A 店（不是退出客户端）：B 店进行中的发送与回执照常完成", async () => {
    const a = await shop({ shop: "shop-a" });
    const b = await shop({ shop: "shop-b" });
    // B 店的平台发送被拖慢，确保断开 A 店时 B 店正处在发送中。
    const send = b.mock.send.bind(b.mock);
    let sending = false;
    b.mock.send = async (req) => {
      sending = true;
      await new Promise((r) => setTimeout(r, 300));
      return send(req);
    };
    b.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => sending, "b sending");
    assert.equal(eventsOf(b.rt)[0].attempt?.phase, "sending");
    await a.rt.stop();
    await waitFor(() => uploaded(b.rt, 1), "b receipt");
    assert.equal(eventsOf(b.rt)[0].attempt?.phase, "sent");
    assert.equal(b.mock.platformSends.length, 1);
    const [server] = await backend.events("shop-b");
    assert.equal(server.delivery.status, "sent");
    // A 店断开后新消息不处理，B 店继续处理新消息。
    a.mock.injectBuyerMessage({ conversation_id: "buyer-9", content: "营业时间？" });
    b.mock.injectBuyerMessage({ conversation_id: "buyer-2", content: "营业时间？" });
    await waitFor(() => uploaded(b.rt, 2), "b second");
    assert.equal(a.mock.platformSends.length, 0);
    assert.equal(eventsOf(a.rt).length, 0);
  });
});
