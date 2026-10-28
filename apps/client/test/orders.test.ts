import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PddOrderBook, parseOrderList, parseShippingDetail, redactText, toUnixSeconds, type PlatformOrder } from "../src/core/pddOrders.js";

// 全部为虚构数据，字段结构取自诊断记录（只有字段名与类型）。
const ORDER = (over: Record<string, unknown> = {}) => ({
  uid: 9001,
  orderSn: "241024-000000000000001",
  orderStatusStr: "已发货，待收货",
  orderAmount: 1990,
  orderTime: 1790000000,
  shippingTime: 1790003600,
  receiveTime: 0,
  note: "买家要求周末送，电话13812345678",
  trackingNumber: "YT0000000001",
  orderGoodsList: { goodsName: "虚构商品", spec: "红色 L", goodsNumber: 2 },
  traceInfoList: [
    { status: "运输中", info: "快件已到达【虚构市转运中心】", shippingName: "虚构快递", time: "2026-09-21 10:00:00" },
    { status: "已揽收", info: "快递员已揽件", shippingName: "虚构快递", time: "2026-09-20 18:00:00" },
  ],
  ...over,
});
const LIST = (orders: unknown[]) => ({ success: true, result: { total: orders.length, orders } });

describe("订单解析", () => {
  test("订单列表：字段映射、金额按分、时间统一为秒、空时间不传", () => {
    const r = parseOrderList({ uid: "9001", pageNo: 1 }, LIST([ORDER()]), 1790010000);
    assert.ok(r);
    assert.equal(r.buyer, "9001");
    const s = r.orders[0].summary;
    assert.equal(r.orders[0].key, "241024-000000000000001");
    assert.equal(s.status, "已发货，待收货");
    assert.equal(s.goods_title, "虚构商品");
    assert.equal(s.sku, "红色 L");
    assert.equal(s.quantity, 2);
    assert.equal(s.amount, "19.90");
    assert.equal(s.order_time, 1790000000);
    assert.equal(s.receive_time, undefined);
    assert.equal(s.note, "买家要求周末送，电话[已隐去]");
    assert.equal(s.logistics?.tracking_number, "YT0000000001");
    assert.equal(s.logistics?.company, "虚构快递");
    assert.deepEqual(s.logistics?.traces.map((t) => t.time), [toUnixSeconds("2026-09-21 10:00:00"), toUnixSeconds("2026-09-20 18:00:00")]);
    assert.equal(s.observed_at, 1790010000);
    assert.equal(s.logistics?.observed_at, 1790010000);
    assert.ok(!JSON.stringify(s).includes("241024"));
  });

  test("订单 uid 与请求买家不一致的丢弃；失败响应不解析", () => {
    assert.equal(parseOrderList({ uid: "9001" }, LIST([ORDER({ uid: 9002 })]), 1)?.orders.length, 0);
    assert.equal(parseOrderList({ uid: "9001" }, { success: false, result: null }, 1), null);
    assert.equal(parseOrderList({}, LIST([ORDER()]), 1), null);
  });

  test("北京时间字符串换算为 Unix 秒", () => {
    assert.equal(toUnixSeconds("2026-01-01 08:00:00"), Date.UTC(2026, 0, 1) / 1000);
    assert.equal(toUnixSeconds(1790000000123), 1790000000);
    assert.equal(toUnixSeconds(0), undefined);
  });

  test("自由文本清理：手机号、身份证、长编号、门牌地址", () => {
    const t = redactText("联系138-1234-5678，身份证11010519491231002X，订单241024123456789，送到幸福路88号3栋，杭州市转运中心");
    assert.ok(!/138|1101|241024|88号/.test(t), t);
    assert.ok(t.includes("杭州市转运中心"));
  });

  test("地址清理：中文数字门牌、标注“地址：”的街道地址、省市区连写", () => {
    const cases = [
      ["改寄北京市朝阳区望京小区三号楼二单元", /望京|三号楼|朝阳/],
      ["收货地址：浙江省杭州市西湖区文三路，周末送", /文三路|西湖/],
      ["送到幸福花园十二栋", /幸福花园|十二栋/],
      ["新地址: 虚构县光明村", /光明村/],
    ] as const;
    for (const [input, leak] of cases) assert.ok(!leak.test(redactText(input)), redactText(input));
    assert.equal(redactText("收货地址：浙江省杭州市西湖区文三路，周末送"), "收货地址：[已隐去]，周末送");
    assert.equal(redactText("尺码偏小，换大一号"), "尺码偏小，换大一号");
  });

  test("物流详情：轨迹倒序、最多 5 条", () => {
    const traces = Array.from({ length: 7 }, (_, i) => ({ info: `轨迹${i}`, time: `2026-09-2${i} 10:00:00`, status: "运输中" }));
    const lg = parseShippingDetail({ success: true, result: { shipping_name: "虚构快递", tracking_number: "YT1", traces } }, 5);
    assert.equal(lg?.traces.length, 5);
    assert.equal(lg?.traces[0].info, "轨迹6");
    assert.equal(lg?.observed_at, 5);
  });
});

describe("订单归属", () => {
  const book = () => {
    const out: { buyer: string; orders: PlatformOrder[] }[] = [];
    return { out, b: new PddOrderBook((buyer, orders) => out.push({ buyer, orders })) };
  };

  test("物流与备注按单号/订单号挂到原买家，与当前选中对话无关；对不上的丢弃", () => {
    const { out, b } = book();
    b.response("/latitude/order/userAllOrder", { uid: "9001" }, LIST([ORDER()]), 100);
    b.response("/chats/shippingDetail", null, { success: true, result: { shipping_name: "虚构快递", tracking_number: "YT0000000001", traces: [{ info: "已签收", time: "2026-09-22 09:00:00", status: "已签收" }] } }, 200);
    b.response("/chats/shippingDetail", null, { success: true, result: { tracking_number: "UNKNOWN", traces: [] } }, 300);
    b.response("/pizza/order/noteTag/query", { orderSn: "241024-000000000000001" }, { success: true, result: { note: "新备注" } }, 400);
    b.response("/pizza/order/noteTag/query", { orderSn: "other" }, { success: true, result: { note: "x" } }, 500);
    assert.equal(out.length, 3);
    const last = out[2].orders[0].summary;
    assert.equal(out[2].buyer, "9001");
    assert.equal(last.logistics?.state, "已签收");
    assert.equal(last.logistics?.observed_at, 200);
    assert.equal(last.observed_at, 100);
    assert.equal(last.note, "新备注");
  });

  test("同一订单号不会被另一个买家的列表抢走", () => {
    const { out, b } = book();
    b.response("/latitude/order/userAllOrder", { uid: "9001" }, LIST([ORDER()]), 1);
    b.response("/latitude/order/userAllOrder", { uid: "9002" }, LIST([ORDER({ uid: 9002 })]), 2);
    assert.deepEqual(out.map((o) => [o.buyer, o.orders.length]), [["9001", 1], ["9002", 0]]);
  });

  test("读取进行中可等待；结束后立即返回", async () => {
    const { b } = book();
    const buyer = b.started("/latitude/order/userAllOrder", { uid: "9001" });
    const t0 = Date.now();
    setTimeout(() => b.finished(buyer), 150);
    await b.settled("9001", 2000, 20);
    assert.ok(Date.now() - t0 >= 140 && Date.now() - t0 < 1000);
  });
});

describe("订单修正", () => {
  test("轨迹升序返回时，物流状态取时间最新的一条", () => {
    const asc = [
      { status: "已揽收", info: "快递员已揽件", shippingName: "虚构快递", time: "2026-09-20 18:00:00" },
      { status: "已签收", info: "已签收", shippingName: "虚构快递", time: "2026-09-22 09:00:00" },
    ];
    const r = parseOrderList({ uid: 9001 }, LIST([ORDER({ traceInfoList: asc })]), 1790010000);
    assert.equal(r?.orders[0].summary.logistics?.state, "已签收");
    const lg = parseShippingDetail({ success: true, result: { shipping_name: "虚构快递", tracking_number: "YT0000000001", traces: asc } }, 1790010000);
    assert.equal(lg?.state, "已签收");
  });

  test("会话重置后清空已读订单，epoch 递增", () => {
    const seen: PlatformOrder[][] = [];
    const book = new PddOrderBook((_b, o) => seen.push(o));
    book.response("/latitude/order/userAllOrder", { uid: 9001 }, LIST([ORDER()]), 1790010000);
    const e0 = book.epoch;
    book.reset();
    assert.equal(book.epoch, e0 + 1);
    book.response("/pizza/order/note/query", { orderSn: "241024-000000000000001" }, { success: true, result: { note: "x" } }, 1790010001);
    assert.equal(seen.length, 1);
  });
});

test("各订单分类接口都按同一格式读取；分类为空（orders 为 null）不报错", () => {
  for (const p of ["/latitude/order/userUnshippedOrder", "/latitude/order/userReceivedOrder", "/latitude/order/userRefundOrder"]) {
    assert.ok(PddOrderBook.watches(p));
    assert.deepEqual(parseOrderList({ uid: 9001 }, { success: true, result: { total: 0, orders: null } }, 1)?.orders, []);
  }
});

test("售后：有售后单标注“有售后记录”，不送售后单编号和状态码；已退金额按分换算", () => {
  const r = parseOrderList({ uid: 9001 }, LIST([
    ORDER({ afterSalesInfo: { afterSalesId: "AS0000000001", afterSalesStatus: 3, afterSalesType: 1, expireTime: 1790000000 } }),
    ORDER({ orderSn: "241024-000000000000002", afterSalesInfo: null, refundedAmount: 1990 }),
    ORDER({ orderSn: "241024-000000000000003", afterSalesInfo: null, refundedAmount: null }),
  ]), 1);
  assert.deepEqual(r?.orders.map((o) => o.summary.after_sale), ["有售后记录", "已退款 19.90 元", undefined]);
  assert.ok(!JSON.stringify(r).includes("AS0000000001"));
});

test("startedSince：点标签后页面开始读该买家订单即返回 true；超时返回 false", async () => {
  const book = new PddOrderBook(() => undefined);
  const since = Date.now();
  setTimeout(() => book.started("/latitude/order/userAllOrder", { uid: 9001 }), 50);
  assert.equal(await book.startedSince("9001", since, 1000, 10), true);
  assert.equal(await book.startedSince("9002", Date.now(), 60, 10), false);
});

