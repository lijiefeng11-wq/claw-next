import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { FetchLike } from "../src/core/backend.js";
import type { PlatformOrder } from "../src/core/pddOrders.js";
import { ShopRuntime } from "../src/core/runtime.js";
import { TestBackend, eventsOf, makeShop, settle, waitFor } from "./helpers.js";

// 契约“商品快照（1.2 草案）”：用内存中的虚构后台验证能力协商与提交内容。全部为虚构店铺与虚构内容。

function fakeBackend(opts: { goods: boolean }) {
  const state = { goods: opts.goods, heartbeats: [] as any[], bodies: [] as any[] };
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
      const caps = state.goods && body.capabilities?.includes("goods_snapshot") ? { capabilities: ["goods_snapshot"] } : {};
      return json(200, { shop_id: "shop-a", client_id: "client-a", instance_id: body.instance_id, session_id: body.session_id, generation: 1, expires_at: now + 60, ...caps });
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
async function shop(fake: ReturnType<typeof fakeBackend>) {
  const h = await makeShop({ backend: FAKE, fetchImpl: fake.fetchImpl, login: false });
  await h.mock.login();
  await waitFor(() => h.rt.lease.state === "held", "lease");
  running.push(h.rt);
  return h;
}
afterEach(async () => {
  for (const rt of running.splice(0)) await rt.stop(false);
});

const ORDER: PlatformOrder = {
  key: "241024-000000000000009",
  summary: { status: "已发货", goods_title: "虚构遮阳挡", sku: "红色", quantity: 1, amount: "19.90", order_time: 1790000000, observed_at: 1790000100 },
  goods: [{ goods_id: "501", title: "虚构遮阳挡", sku: "红色", quantity: 1 }, { goods_id: "501", title: "虚构遮阳挡", sku: "蓝色", quantity: 2 }, { goods_id: "502", title: "虚构挂钩" }],
};
const CARD = { type: "goods" as const, title: "虚构遮阳挡", fields: [{ label: "价格", value: "¥19.90" }] };

describe("商品快照：能力协商与提交", () => {
  test("心跳声明 goods_snapshot；后台未确认时不带 goods 和 items", async () => {
    const fake = fakeBackend({ goods: false });
    const h = await shop(fake);
    assert.ok(fake.state.heartbeats[0].capabilities.includes("goods_snapshot"));
    assert.equal(h.rt.goodsSnapshotConfirmed(), false);
    h.mock.injectOrders("buyer-1", [ORDER]);
    h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "商品卡片：虚构遮阳挡", kind: "card", card: CARD });
    await waitFor(() => fake.state.bodies.length > 0, "submit");
    await settle(h.rt);
    const ctx = fake.state.bodies[0].context;
    assert.equal(ctx.goods, undefined);
    assert.equal(ctx.orders.length, 1);
    assert.equal(ctx.orders[0].items, undefined);
    assert.equal(eventsOf(h.rt)[0].has_goods, undefined);
  });

  test("后台确认后：带 goods 与订单 items；引用一致；平台编号不出现；本地日志不存商品", async () => {
    const fake = fakeBackend({ goods: true });
    const h = await shop(fake);
    assert.equal(h.rt.goodsSnapshotConfirmed(), true);
    h.mock.injectOrders("buyer-1", [ORDER]);
    h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "商品卡片：虚构遮阳挡", kind: "card", card: CARD });
    await waitFor(() => fake.state.bodies.length > 0, "submit");
    await settle(h.rt);
    const ctx = fake.state.bodies[0].context;
    const order = ctx.orders[0];
    // 原摘要不变，明细 3 条（同商品两种规格共用引用）
    assert.equal(order.goods_title, "虚构遮阳挡");
    assert.equal(order.items.length, 3);
    assert.equal(order.items[0].goods_ref, order.items[1].goods_ref);
    assert.deepEqual(order.items.map((i: any) => i.sku ?? null), ["红色", "蓝色", null]);
    // goods：编号 501、编号 502、只有标题的卡片，三个条目
    assert.equal(ctx.goods.length, 3);
    const refs = new Set(ctx.goods.map((g: any) => g.goods_ref));
    for (const i of order.items) assert.ok(refs.has(i.goods_ref));
    for (const g of ctx.goods) {
      for (const e of g.evidence) {
        if (e.source === "order") {
          assert.equal(e.order_ref, order.order_ref);
          assert.equal(e.observed_at, order.observed_at);
          assert.ok(order.items.some((i: any) => i.goods_ref === g.goods_ref));
        } else {
          const msg = ctx.messages.find((m: any) => m.id === e.message_id);
          assert.equal(msg.kind, "card");
          assert.equal(msg.card.title, g.title);
          assert.equal(e.observed_at, msg.created_at);
          assert.equal(e.card_price, "¥19.90");
        }
      }
    }
    const raw = JSON.stringify(fake.state.bodies[0]);
    assert.ok(!raw.includes("241024") && !/"50[12]"/.test(raw), "不含平台订单号与商品编号");
    // 本地日志：请求体去掉 goods 与订单，只在内存
    const ev = eventsOf(h.rt)[0];
    assert.equal(ev.has_goods, true);
    assert.equal(JSON.parse(ev.body).context.goods, undefined);
    assert.ok(!fs.readFileSync(path.join(h.dir, "journal.jsonl"), "utf8").includes("虚构挂钩"));
  });

  test("同一对话后续提交：商品引用不变（含后来出现同名有编号商品时卡片引用不变）", async () => {
    const fake = fakeBackend({ goods: true });
    const h = await shop(fake);
    h.mock.injectBuyerMessage({ conversation_id: "buyer-2", content: "商品卡片：虚构遮阳挡", kind: "card", card: CARD });
    await waitFor(() => fake.state.bodies.length === 1, "first");
    await settle(h.rt);
    const cardRef = fake.state.bodies[0].context.goods[0].goods_ref;
    h.mock.injectOrders("buyer-2", [ORDER]);
    h.mock.injectBuyerMessage({ conversation_id: "buyer-2", content: "这个有货吗" });
    await waitFor(() => fake.state.bodies.length === 2, "second");
    await settle(h.rt);
    const second = fake.state.bodies[1].context.goods;
    const cardEntry = second.find((g: any) => g.evidence.some((e: any) => e.source === "goods_card"));
    assert.equal(cardEntry.goods_ref, cardRef);
    assert.ok(second.filter((g: any) => g.title === "虚构遮阳挡").length === 2, "同名的编号商品与卡片是两个条目");
  });

  test("订单明细变化使对话版本递增；内容不变不递增", async () => {
    const fake = fakeBackend({ goods: false });
    const h = await shop(fake);
    h.mock.injectBuyerMessage({ conversation_id: "buyer-3", content: "你好" });
    await waitFor(() => eventsOf(h.rt).length > 0, "submitted");
    await settle(h.rt);
    const r0 = h.rt.journal.conversation("buyer-3").revision;
    h.mock.injectOrders("buyer-3", [ORDER]);
    h.mock.injectOrders("buyer-3", [ORDER]);
    assert.equal(h.rt.journal.conversation("buyer-3").revision, r0 + 1);
    h.mock.injectOrders("buyer-3", [{ ...ORDER, goods: ORDER.goods!.slice(0, 1) }]);
    assert.equal(h.rt.journal.conversation("buyer-3").revision, r0 + 2);
  });
});
