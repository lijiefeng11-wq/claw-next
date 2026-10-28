import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { buildGoodsSnapshot, MAX_EVIDENCE, MAX_GOODS, type SnapshotOrder } from "../src/core/goodsSnapshot.js";
import { parseOrderList, MAX_ORDER_GOODS } from "../src/core/pddOrders.js";
import type { ContextMessage } from "../src/core/protocol.js";

// 全部为虚构数据。商品快照是契约 1.2 草案，尚未接入提交；这里只验证解析与归并。
const ref = (key: string) => "g-" + createHash("sha256").update("shop-x|conv-1|" + key).digest("hex").slice(0, 12);
const card = (id: string, title: string, at: number, price?: string): ContextMessage => ({
  id, role: "buyer", kind: "card", content: `商品卡片：${title}`, created_at: at,
  card: { type: "goods", title, ...(price ? { fields: [{ label: "价格", value: price }] } : {}) },
});
const text = (id: string, at: number): ContextMessage => ({ id, role: "buyer", kind: "text", content: "在吗", created_at: at });

describe("订单内商品解析", () => {
  test("多商品订单保留各商品（最多 5 项）；原摘要仍取第一项；无效标题跳过", () => {
    const goodsList = [
      { goodsId: 501, goodsName: "虚构商品甲", spec: "红色 L", goodsNumber: 2 },
      { goodsId: "502", goodsName: "虚构商品乙", goodsNumber: 1 },
      { goodsId: 503, goodsName: "https://example.invalid/x" },
      ...Array.from({ length: 6 }, (_, i) => ({ goodsId: 600 + i, goodsName: `虚构商品${i}` })),
    ];
    const r = parseOrderList({ uid: "9001" }, { success: true, result: { orders: [{ uid: 9001, orderSn: "sn-1", orderGoodsList: goodsList }] } }, 1790010000);
    const o = r!.orders[0];
    assert.equal(o.summary.goods_title, "虚构商品甲");
    assert.equal(o.goods!.length, MAX_ORDER_GOODS);
    assert.deepEqual(o.goods!.slice(0, 2), [
      { goods_id: "501", title: "虚构商品甲", sku: "红色 L", quantity: 2 },
      { goods_id: "502", title: "虚构商品乙", quantity: 1 },
    ]);
    assert.ok(!o.goods!.some((g) => g.title.includes("http")));
    // 单个对象形式、编号无效时编号为空
    const single = parseOrderList({ uid: "9001" }, { success: true, result: { orders: [{ uid: 9001, orderSn: "sn-2", orderGoodsList: { goodsId: "x1", goodsName: "虚构商品丙" } }] } }, 1);
    assert.deepEqual(single!.orders[0].goods, [{ goods_id: null, title: "虚构商品丙" }]);
  });
});

describe("商品快照归并", () => {
  test("订单按编号合并；卡片按标题并入唯一同名编号组；来源按时间倒序；输出不含平台编号", () => {
    const orders: SnapshotOrder[] = [
      { order_ref: "o-1", observed_at: 300, goods: [{ goods_id: "501", title: "虚构商品甲", sku: "红色 L", quantity: 2 }, { goods_id: "502", title: "虚构商品乙" }] },
      { order_ref: "o-2", observed_at: 200, goods: [{ goods_id: "501", title: "虚构商品甲", sku: "蓝色 M", quantity: 1 }] },
    ];
    const messages = [text("m-1", 100), card("m-2", "虚构商品甲", 150, "¥19.90"), card("m-3", "虚构商品丁", 400)];
    const { goods, items } = buildGoodsSnapshot({ orders, messages }, ref);
    assert.deepEqual(goods.map((g) => g.title), ["虚构商品丁", "虚构商品甲", "虚构商品乙"]);
    const jia = goods[1];
    assert.equal(jia.goods_ref, ref("id:501"));
    assert.deepEqual(jia.evidence, [
      { source: "order", order_ref: "o-1", sku: "红色 L", quantity: 2, observed_at: 300 },
      { source: "order", order_ref: "o-2", sku: "蓝色 M", quantity: 1, observed_at: 200 },
      { source: "goods_card", message_id: "m-2", card_price: "¥19.90", observed_at: 150 },
    ]);
    assert.deepEqual(goods[0].evidence, [{ source: "goods_card", message_id: "m-3", observed_at: 400 }]);
    assert.deepEqual(items.get("o-1"), [
      { goods_ref: ref("id:501"), goods_title: "虚构商品甲", sku: "红色 L", quantity: 2 },
      { goods_ref: ref("id:502"), goods_title: "虚构商品乙" },
    ]);
    assert.deepEqual(items.get("o-2"), [{ goods_ref: ref("id:501"), goods_title: "虚构商品甲", sku: "蓝色 M", quantity: 1 }]);
    // 引用是摘要（不含编号原文）；去掉引用后的其余内容里也没有平台商品编号。
    assert.ok(goods.every((g) => /^g-[0-9a-f]{12}$/.test(g.goods_ref)));
    const out = JSON.stringify({ goods, items: [...items] }).replace(/"g-[0-9a-f]{12}"/g, '"ref"');
    assert.ok(!/50[12]/.test(out), "不含平台商品编号");
    // 价格只出现在卡片来源上
    assert.ok(goods.every((g) => g.evidence.every((e) => e.source === "goods_card" || !("card_price" in e))));
  });

  test("同名编号组不止一个时卡片不合并；同一来源只留最新一次", () => {
    const orders: SnapshotOrder[] = [
      { order_ref: "o-1", observed_at: 100, goods: [{ goods_id: "501", title: "同名商品" }] },
      { order_ref: "o-2", observed_at: 100, goods: [{ goods_id: "502", title: "同名商品" }] },
    ];
    const { goods } = buildGoodsSnapshot({ orders, messages: [card("m-1", "同名商品", 50)] }, ref);
    assert.equal(goods.length, 3);
    assert.ok(goods.some((g) => g.goods_ref === ref("title:同名商品")));
    const again = buildGoodsSnapshot({ orders: [{ order_ref: "o-1", observed_at: 100, goods: [{ goods_id: "501", title: "甲" }] }, { order_ref: "o-1", observed_at: 300, goods: [{ goods_id: "501", title: "甲（新名）" }] }], messages: [] }, ref);
    assert.deepEqual(again.goods, [{ goods_ref: ref("id:501"), title: "甲（新名）", evidence: [{ source: "order", order_ref: "o-1", observed_at: 300 }] }]);
  });

  test("上限：商品 10 项、每项来源 5 条；没进入 goods 的商品不出现在订单 items 里", () => {
    const orders: SnapshotOrder[] = Array.from({ length: 12 }, (_, i) => ({ order_ref: `o-${i}`, observed_at: 1000 - i, goods: [{ goods_id: String(700 + i), title: `虚构商品${i}` }] }));
    const cards = Array.from({ length: 7 }, (_, i) => card(`m-${i}`, "虚构商品0", 2000 + i));
    const { goods, items } = buildGoodsSnapshot({ orders, messages: cards }, ref);
    assert.equal(goods.length, MAX_GOODS);
    assert.equal(goods[0].title, "虚构商品0");
    assert.equal(goods[0].evidence.length, MAX_EVIDENCE);
    assert.deepEqual(goods[0].evidence.map((e) => e.observed_at), [2006, 2005, 2004, 2003, 2002]);
    assert.ok(items.has("o-9"));
    assert.ok(!items.has("o-10") && !items.has("o-11"), "被上限挤出的商品不在 items 里");
  });

  test("只收商品卡片：其他卡片、无标题或含网址的标题、非有限时间都不收", () => {
    const messages: ContextMessage[] = [
      { id: "m-1", role: "system", kind: "card", content: "平台来源卡片", created_at: 1, card: { type: "source", title: "来源" } },
      { id: "m-2", role: "buyer", kind: "card", content: "商品卡片", created_at: 2, card: { type: "goods" } },
      card("m-3", "https://example.invalid/goods", 3),
      card("m-4", "虚构商品", Number.NaN),
      card("m-5", "虚构商品戊", 5, "https://example.invalid/price"),
    ];
    const { goods } = buildGoodsSnapshot({ orders: [], messages }, ref);
    assert.deepEqual(goods, [{ goods_ref: ref("title:虚构商品戊"), title: "虚构商品戊", evidence: [{ source: "goods_card", message_id: "m-5", observed_at: 5 }] }]);
  });
});
