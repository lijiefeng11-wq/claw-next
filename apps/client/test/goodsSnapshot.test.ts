import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { buildGoodsSnapshot, MAX_EVIDENCE, MAX_GOODS, type SnapshotOrder } from "../src/core/goodsSnapshot.js";
import { parseOrderList, MAX_ORDER_GOODS } from "../src/core/pddOrders.js";
import type { ContextMessage } from "../src/core/protocol.js";

// 契约“商品快照（1.2 草案）”。全部为虚构数据。
const ref = (identity: string) => "g-" + createHash("sha256").update("shop-x|conv-1|" + identity).digest("hex").slice(0, 12);
const card = (id: string, title: string, at: number, price?: string): ContextMessage => ({
  id, role: "buyer", kind: "card", content: `商品卡片：${title}`, created_at: at,
  card: { type: "goods", title, ...(price ? { fields: [{ label: "价格", value: price }] } : {}) },
});
const text = (id: string, at: number): ContextMessage => ({ id, role: "buyer", kind: "text", content: "在吗", created_at: at });
const order = (order_ref: string, observed_at: number, goods: SnapshotOrder["goods"]): SnapshotOrder => ({ order_ref, observed_at, goods });

describe("订单明细解析", () => {
  test("只看页面前 5 条明细（不用后面的补位）；其中无效标题跳过；原摘要仍取第一条", () => {
    const goodsList = [
      { goodsId: 501, goodsName: "虚构商品甲", spec: "红色 L", goodsNumber: 2 },
      { goodsId: "502", goodsName: "虚构商品乙", goodsNumber: 1 },
      { goodsId: 503, goodsName: "https://example.invalid/x" },
      { goodsId: 504, goodsName: "虚构商品丁" },
      { goodsId: 505, goodsName: "虚构商品戊" },
      { goodsId: 506, goodsName: "第六条（不应出现）" },
    ];
    const r = parseOrderList({ uid: "9001" }, { success: true, result: { orders: [{ uid: 9001, orderSn: "sn-1", orderGoodsList: goodsList }] } }, 1790010000);
    const o = r!.orders[0];
    assert.equal(o.summary.goods_title, "虚构商品甲");
    assert.deepEqual(o.goods!.map((g) => g.title), ["虚构商品甲", "虚构商品乙", "虚构商品丁", "虚构商品戊"]);
    assert.ok(o.goods!.length <= MAX_ORDER_GOODS);
    assert.deepEqual(o.goods![0], { goods_id: "501", title: "虚构商品甲", sku: "红色 L", quantity: 2 });
    const single = parseOrderList({ uid: "9001" }, { success: true, result: { orders: [{ uid: 9001, orderSn: "sn-2", orderGoodsList: { goodsId: "x1", goodsName: "虚构商品丙" } }] } }, 1);
    assert.deepEqual(single!.orders[0].goods, [{ goods_id: null, title: "虚构商品丙" }]);
  });
});

describe("商品快照归并", () => {
  test("编号身份与标题身份分开；evidence 只指向订单 / 卡片消息；规格件数只在 items", () => {
    const orders = [
      order("o-1", 300, [{ goods_id: "501", title: "虚构遮阳挡", sku: "红色", quantity: 1 }, { goods_id: "502", title: "虚构商品乙" }]),
      order("o-2", 200, [{ goods_id: "501", title: "虚构遮阳挡", sku: "蓝色", quantity: 2 }]),
    ];
    const messages = [text("m-1", 100), card("m-2", "虚构遮阳挡", 150, "¥19.90")];
    const { goods, items } = buildGoodsSnapshot({ orders, messages }, ref);
    // 同名的卡片（无编号）与编号 501 不合并
    assert.deepEqual(goods.map((g) => [g.goods_ref, g.title]), [
      [ref("id:501"), "虚构遮阳挡"],
      [ref("id:502"), "虚构商品乙"],
      [ref("title:虚构遮阳挡"), "虚构遮阳挡"],
    ]);
    assert.deepEqual(goods[0].evidence, [
      { source: "order", order_ref: "o-1", observed_at: 300 },
      { source: "order", order_ref: "o-2", observed_at: 200 },
    ]);
    assert.deepEqual(goods[2].evidence, [{ source: "goods_card", message_id: "m-2", card_price: "¥19.90", observed_at: 150 }]);
    assert.deepEqual(items.get("o-1"), [
      { goods_ref: ref("id:501"), goods_title: "虚构遮阳挡", sku: "红色", quantity: 1 },
      { goods_ref: ref("id:502"), goods_title: "虚构商品乙" },
    ]);
    // 平台编号不出现在输出（引用是摘要）
    const out = JSON.stringify({ goods, items: [...items] }).replace(/"g-[0-9a-f]{12}"/g, '"ref"');
    assert.ok(!/50[12]/.test(out));
  });

  test("同一订单同一商品的多个规格：items 各占一条且共用引用；evidence 只有一条订单来源；输入顺序不影响结果", () => {
    const lines = [{ goods_id: "601", title: "虚构座套", sku: "红色", quantity: 1 }, { goods_id: "601", title: "虚构座套", sku: "蓝色", quantity: 2 }];
    const a = buildGoodsSnapshot({ orders: [order("o-2", 100, lines)], messages: [] }, ref);
    const b = buildGoodsSnapshot({ orders: [order("o-2", 100, [...lines].reverse())], messages: [] }, ref);
    assert.deepEqual(a.goods, [{ goods_ref: ref("id:601"), title: "虚构座套", evidence: [{ source: "order", order_ref: "o-2", observed_at: 100 }] }]);
    assert.deepEqual(a.goods, b.goods);
    assert.deepEqual(a.items.get("o-2")!.map((i) => [i.goods_ref, i.sku, i.quantity]), [[ref("id:601"), "红色", 1], [ref("id:601"), "蓝色", 2]]);
  });

  test("引用跨提交稳定：后来出现同名的有编号商品、同编号改标题，引用都不变", () => {
    const first = buildGoodsSnapshot({ orders: [], messages: [card("m-1", "虚构遮阳挡", 100)] }, ref);
    const second = buildGoodsSnapshot({ orders: [order("o-1", 200, [{ goods_id: "501", title: "虚构遮阳挡" }])], messages: [card("m-1", "虚构遮阳挡", 100)] }, ref);
    const third = buildGoodsSnapshot({ orders: [order("o-1", 200, [{ goods_id: "501", title: "虚构遮阳挡" }]), order("o-2", 300, [{ goods_id: "777", title: "虚构遮阳挡" }])], messages: [card("m-1", "虚构遮阳挡", 100)] }, ref);
    const cardRef = (r: ReturnType<typeof buildGoodsSnapshot>) => r.goods.find((g) => g.evidence.some((e) => e.source === "goods_card"))!.goods_ref;
    assert.equal(cardRef(first), ref("title:虚构遮阳挡"));
    assert.equal(cardRef(second), cardRef(first));
    assert.equal(cardRef(third), cardRef(first));
    const renamed = buildGoodsSnapshot({ orders: [order("o-1", 100, [{ goods_id: "501", title: "旧名" }]), order("o-2", 300, [{ goods_id: "501", title: "新名" }])], messages: [] }, ref);
    assert.deepEqual(renamed.goods.map((g) => [g.goods_ref, g.title]), [[ref("id:501"), "新名"]]);
  });

  test("上限：goods 最多 10 项、evidence 最多 5 条；被挤出 goods 的商品在 items 里保留、只是没有引用", () => {
    const orders = [
      order("o-old", 10, [{ goods_id: "900", title: "虚构旧商品" }, { goods_id: "901", title: "虚构新商品" }]),
      ...Array.from({ length: 9 }, (_, i) => order(`o-${i}`, 1000 + i, [{ goods_id: String(700 + i), title: `虚构商品${i}` }])),
    ];
    const cards = [card("m-x", "虚构卡片商品", 5000), ...Array.from({ length: 7 }, (_, i) => card(`m-${i}`, "虚构商品0", 2000 + i))];
    const { goods, items } = buildGoodsSnapshot({ orders: [...orders, order("o-901", 3000, [{ goods_id: "901", title: "虚构新商品" }])], messages: cards }, ref);
    assert.equal(goods.length, MAX_GOODS);
    assert.ok(goods.every((g) => g.evidence.length <= MAX_EVIDENCE));
    assert.ok(!goods.some((g) => g.title === "虚构旧商品"));
    // 订单 o-old 的明细完整保留：首条没有引用（商品被挤出 goods），第二条有引用
    assert.deepEqual(items.get("o-old"), [{ goods_title: "虚构旧商品" }, { goods_ref: ref("id:901"), goods_title: "虚构新商品" }]);
  });

  test("evidence 的订单来源都能在该订单的 items 里找到引用本条目的明细", () => {
    const orders = Array.from({ length: 6 }, (_, i) => order(`o-${i}`, 100 + i, [{ goods_id: "501", title: "虚构商品" }, { goods_id: String(600 + i), title: `虚构配件${i}` }]));
    const { goods, items } = buildGoodsSnapshot({ orders, messages: [] }, ref);
    for (const g of goods) {
      for (const e of g.evidence) {
        if (e.source !== "order") continue;
        assert.ok(items.get(e.order_ref)?.some((i) => i.goods_ref === g.goods_ref), `${e.order_ref} 应有引用 ${g.goods_ref} 的明细`);
        assert.equal(e.observed_at, orders.find((o) => o.order_ref === e.order_ref)!.observed_at);
      }
    }
  });

  test("只收标题与提交内容逐字相等的商品卡片：其他卡片、无标题、含网址、超长、非有限时间都不收；含网址的价格不带", () => {
    const messages: ContextMessage[] = [
      { id: "m-1", role: "system", kind: "card", content: "平台来源卡片", created_at: 1, card: { type: "source", title: "来源" } },
      { id: "m-2", role: "buyer", kind: "card", content: "商品卡片", created_at: 2, card: { type: "goods" } },
      card("m-3", "https://example.invalid/goods", 3),
      card("m-4", "虚构商品", Number.NaN),
      card("m-6", "长".repeat(201), 6),
      card("m-5", "虚构商品戊", 5, "https://example.invalid/price"),
    ];
    const { goods } = buildGoodsSnapshot({ orders: [], messages }, ref);
    assert.deepEqual(goods, [{ goods_ref: ref("title:虚构商品戊"), title: "虚构商品戊", evidence: [{ source: "goods_card", message_id: "m-5", observed_at: 5 }] }]);
  });

  test("时间相同按身份排序：同样的输入顺序不同，结果相同", () => {
    const a = [order("o-1", 100, [{ goods_id: "2", title: "乙" }]), order("o-2", 100, [{ goods_id: "1", title: "甲" }])];
    const r1 = buildGoodsSnapshot({ orders: a, messages: [] }, ref);
    const r2 = buildGoodsSnapshot({ orders: [...a].reverse(), messages: [] }, ref);
    assert.deepEqual(r1.goods, r2.goods);
  });
});
