// 拼多多商家后台订单/物流/备注响应的被动解析（契约“订单、物流与备注（1.0 补充，只读）”）。
// 只读页面自己加载的数据；平台订单号只在本机用作键，不进入提交内容。

import type { OrderSummary, OrderLogistics } from "./protocol.js";

/**
 * 本机订单记录：key 是平台订单号，只在本机用于去重与生成引用。
 * goods：订单内各商品（最多 MAX_ORDER_GOODS 项，平台商品编号只在本机用于合并同一商品），供商品快照（契约 1.2 草案）使用；
 * 草案生效前不提交。
 */
export type PlatformOrder = { key: string; summary: OrderSummary; goods?: OrderGoods[] };
export type OrderGoods = { goods_id: string | null; title: string; sku?: string; quantity?: number };
export const MAX_ORDER_GOODS = 5;

export const MAX_ORDERS = 10;
const MAX_TRACES = 5;
const HIDDEN = "[已隐去]";

const NUM = "[0-9零〇一二三四五六七八九十百两]";

/** 自由文本清理：手机号、身份证号、长数字编号、地址片段替换为“[已隐去]”。宁可多隐去，不漏地址。 */
export function redactText(text: string): string {
  return text
    .replace(/(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/g, HIDDEN)
    .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}(?!\d)/g, HIDDEN)
    .replace(/\d{8,}/g, HIDDEN)
    .replace(/((?:收货|收件|寄送|配送|邮寄|详细|新)?地址\s*[:：]\s*)[^，,。；;！!？?\n]+/g, `$1${HIDDEN}`)
    .replace(/[\u4e00-\u9fa5]{1,10}(?:省|自治区|市)[\u4e00-\u9fa5]{1,10}(?:市|区|县|旗|州)[\u4e00-\u9fa5A-Za-z0-9-]*/g, HIDDEN)
    .replace(new RegExp(`[\\u4e00-\\u9fa5A-Za-z0-9]{0,20}(?:路|街|巷|弄|大道|小区|花园|公寓|大厦|村)[\\u4e00-\\u9fa5A-Za-z0-9-]{0,20}?${NUM}+\\s*(?:号楼|号|栋|幢|单元|室|楼|层)[\\u4e00-\\u9fa5A-Za-z0-9-]*`, "g"), HIDDEN);
}

function clip(text: unknown, max: number, redact = true): string | undefined {
  if (typeof text !== "string") return undefined;
  const t = (redact ? redactText(text) : text).replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
}

/** 平台时间：秒、毫秒或“YYYY-MM-DD HH:mm(:ss)”（按北京时间）。无效或 0 返回 undefined。 */
export function toUnixSeconds(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v > 1e12 ? v / 1000 : v);
  if (typeof v !== "string") return undefined;
  if (/^\d+$/.test(v)) return toUnixSeconds(Number(v));
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v.trim());
  if (!m) return undefined;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] ?? 0));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/** 平台金额单位为分。 */
function yuan(v: unknown): string | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? (v / 100).toFixed(2) : undefined;
}

function traces(list: unknown): { time: number; info: string }[] {
  if (!Array.isArray(list)) return [];
  const out: { time: number; info: string }[] = [];
  for (const t of list) {
    const time = toUnixSeconds((t as { time?: unknown })?.time);
    const info = clip((t as { info?: unknown })?.info, 200);
    if (time !== undefined && info) out.push({ time, info });
  }
  return out.sort((a, b) => b.time - a.time).slice(0, MAX_TRACES);
}

/** 平台轨迹数组顺序不保证；状态、快递公司取时间最新的一条。 */
function newest(list: unknown): Record<string, any> | undefined {
  if (!Array.isArray(list)) return undefined;
  let best: Record<string, any> | undefined;
  let bestTime = -Infinity;
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const time = toUnixSeconds((t as { time?: unknown }).time) ?? -Infinity;
    if (!best || time > bestTime) [best, bestTime] = [t as Record<string, any>, time];
  }
  return best;
}

/** 平台只给售后单编号和数字状态码（含义未公开），不送编号和状态码，只标明有售后及已退金额。 */
function afterSale(o: Record<string, any>): string | undefined {
  const info = o.afterSalesInfo;
  const has = !!info && typeof info === "object" && (info.afterSalesId || info.afterSalesStatus !== undefined);
  const refunded = typeof o.refundedAmount === "number" && o.refundedAmount > 0 ? yuan(o.refundedAmount) : undefined;
  if (refunded) return has ? `有售后记录，已退款 ${refunded} 元` : `已退款 ${refunded} 元`;
  return has ? "有售后记录" : undefined;
}

function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** 订单列表接口（全部/未完成/待收货/待发货/已收货/退款）。买家以请求里的 uid 为准，订单 uid 不一致的丢弃。 */
export const ORDER_LIST_PATHS = new Set([
  "/latitude/order/userAllOrder",
  "/latitude/order/userUnfinishedOrder",
  "/latitude/order/userNotReceivedOrder",
  "/latitude/order/userUnshippedOrder",
  "/latitude/order/userReceivedOrder",
  "/latitude/order/userRefundOrder",
]);

export function parseOrderList(request: unknown, response: unknown, observedAt: number): { buyer: string; orders: PlatformOrder[] } | null {
  const uid = (request as { uid?: unknown })?.uid;
  const buyer = typeof uid === "string" || typeof uid === "number" ? String(uid) : null;
  const r = response as { success?: unknown; result?: { orders?: unknown } };
  if (!buyer || r?.success !== true) return null;
  const raw = Array.isArray(r.result?.orders) ? r.result.orders : [];
  const orders: PlatformOrder[] = [];
  for (const o of raw as Record<string, any>[]) {
    if (!o || typeof o !== "object") continue;
    if (o.uid !== undefined && String(o.uid) !== buyer) continue;
    const key = typeof o.orderSn === "string" && o.orderSn ? o.orderSn : null;
    if (!key) continue;
    const goods = Array.isArray(o.orderGoodsList) ? o.orderGoodsList[0] : o.orderGoodsList;
    const qty = goods?.goodsNumber;
    const items = orderGoods(o.orderGoodsList);
    const t = traces(o.traceInfoList);
    const tracking = clip(o.trackingNumber, 200, false);
    const latest = newest(o.traceInfoList);
    const company = clip(latest?.shippingName, 200);
    const state = clip(latest?.status, 200);
    const logistics = tracking || t.length ? compact({ company, tracking_number: tracking, state, traces: t, observed_at: observedAt }) : undefined;
    orders.push({
      key,
      summary: compact({
        status: clip(o.orderStatusStr, 200),
        goods_title: clip(goods?.goodsName, 200),
        sku: clip(goods?.spec, 200),
        quantity: Number.isInteger(qty) && qty > 0 ? qty : undefined,
        amount: yuan(o.orderAmount),
        order_time: toUnixSeconds(o.orderTime),
        shipping_time: toUnixSeconds(o.shippingTime),
        receive_time: toUnixSeconds(o.receiveTime),
        note: clip(o.note, 500),
        after_sale: afterSale(o),
        logistics,
        observed_at: observedAt,
      }),
      ...(items.length ? { goods: items } : {}),
    });
  }
  return { buyer, orders };
}

/** 订单内各商品：标题必须有（不含网址），编号只认纯数字；最多 MAX_ORDER_GOODS 项，保持平台顺序。 */
function orderGoods(list: unknown): OrderGoods[] {
  const out: OrderGoods[] = [];
  for (const g of (Array.isArray(list) ? list : [list]) as Record<string, any>[]) {
    if (out.length >= MAX_ORDER_GOODS) break;
    if (!g || typeof g !== "object") continue;
    const title = clip(g.goodsName, 200);
    if (!title || /https?:\/\/|www\./i.test(title)) continue;
    const rawId = g.goodsId;
    const goods_id = (typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId > 0) || (typeof rawId === "string" && /^[0-9]{1,32}$/.test(rawId)) ? String(rawId) : null;
    const qty = g.goodsNumber;
    out.push(compact({ goods_id, title, sku: clip(g.spec, 200), quantity: Number.isInteger(qty) && qty > 0 ? qty : undefined }));
  }
  return out;
}

/** 物流详情（chats/shippingDetail）：按快递单号对应到已读到的订单。 */
export function parseShippingDetail(response: unknown, observedAt: number): OrderLogistics | null {
  const r = response as { success?: unknown; result?: Record<string, any> };
  if (r?.success !== true || !r.result) return null;
  const tracking = clip(r.result.tracking_number, 200, false);
  if (!tracking) return null;
  const t = traces(r.result.traces);
  return compact({
    company: clip(r.result.shipping_name, 200),
    tracking_number: tracking,
    state: clip(newest(r.result.traces)?.status, 200),
    traces: t,
    observed_at: observedAt,
  });
}

/** 订单备注查询（pizza/order/noteTag/query、note/query）：按请求里的订单号对应。 */
export const NOTE_PATHS = new Set(["/pizza/order/noteTag/query", "/pizza/order/note/query"]);

export function parseNoteQuery(request: unknown, response: unknown): { key: string; note: string | null } | null {
  const key = (request as { orderSn?: unknown })?.orderSn;
  const r = response as { success?: unknown; result?: unknown };
  if (typeof key !== "string" || !key || r?.success !== true) return null;
  const result = r.result;
  const raw = typeof result === "string" ? result : (result as { note?: unknown } | null)?.note;
  return { key, note: clip(raw, 500) ?? null };
}

const SHIPPING_PATH = "/chats/shippingDetail";

/**
 * 按买家归集页面读到的订单。归属只看读取请求本身（订单列表请求的 uid、
 * 物流单号/订单号对应到已归属的订单），与当前选中的对话无关；对应不上的直接丢弃。
 */
export class PddOrderBook {
  private readonly books = new Map<string, Map<string, OrderSummary>>();
  private readonly owner = new Map<string, string>();
  private readonly tracking = new Map<string, string>();
  private readonly inflight = new Map<string, number>();
  private readonly lastStarted = new Map<string, number>();
  /** 平台会话（登录店铺）每变化一次加一；请求开始时记下，响应回来时不一致即丢弃。 */
  epoch = 0;

  constructor(private readonly onChange: (buyer: string, orders: PlatformOrder[]) => void) {}

  reset() {
    this.epoch += 1;
    this.books.clear();
    this.owner.clear();
    this.tracking.clear();
    this.lastStarted.clear();
  }

  static watches(path: string): boolean {
    return ORDER_LIST_PATHS.has(path) || NOTE_PATHS.has(path) || path === SHIPPING_PATH;
  }

  /** 订单列表请求开始：记下该买家有读取进行中。返回买家编号用于结束时配对。 */
  started(path: string, request: unknown): string | null {
    if (!ORDER_LIST_PATHS.has(path)) return null;
    const uid = (request as { uid?: unknown })?.uid;
    if (typeof uid !== "string" && typeof uid !== "number") return null;
    const buyer = String(uid);
    this.inflight.set(buyer, (this.inflight.get(buyer) ?? 0) + 1);
    this.lastStarted.set(buyer, Date.now());
    return buyer;
  }

  finished(buyer: string | null) {
    if (!buyer) return;
    const n = (this.inflight.get(buyer) ?? 1) - 1;
    if (n > 0) this.inflight.set(buyer, n);
    else this.inflight.delete(buyer);
  }

  /** 页面在 since 之后是否开始读取过该买家的订单列表；最多等 timeoutMs。 */
  async startedSince(buyer: string, since: number, timeoutMs: number, poll = 100): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if ((this.lastStarted.get(buyer) ?? 0) >= since) return true;
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, poll));
    }
  }

  async settled(buyer: string, timeoutMs: number, poll = 100) {
    const until = Date.now() + timeoutMs;
    while (this.inflight.has(buyer) && Date.now() < until) await new Promise((r) => setTimeout(r, poll));
  }

  response(path: string, request: unknown, response: unknown, now: number) {
    if (ORDER_LIST_PATHS.has(path)) {
      const list = parseOrderList(request, response, now);
      if (!list || !list.orders.length) return;
      const book = this.book(list.buyer);
      for (const o of list.orders) {
        const prevOwner = this.owner.get(o.key);
        if (prevOwner && prevOwner !== list.buyer) continue;
        this.owner.set(o.key, list.buyer);
        book.set(o.key, o.summary);
        if (o.summary.logistics?.tracking_number) this.tracking.set(o.summary.logistics.tracking_number, o.key);
      }
      this.emit(list.buyer);
    } else if (path === SHIPPING_PATH) {
      const lg = parseShippingDetail(response, now);
      const key = lg?.tracking_number ? this.tracking.get(lg.tracking_number) : undefined;
      const buyer = key ? this.owner.get(key) : undefined;
      if (!lg || !key || !buyer) return;
      const book = this.book(buyer);
      const cur = book.get(key);
      if (!cur) return;
      book.set(key, { ...cur, logistics: lg });
      this.emit(buyer);
    } else if (NOTE_PATHS.has(path)) {
      const n = parseNoteQuery(request, response);
      const buyer = n ? this.owner.get(n.key) : undefined;
      const cur = n && buyer ? this.books.get(buyer)?.get(n.key) : undefined;
      if (!n || !buyer || !cur) return;
      const next = { ...cur };
      if (n.note) next.note = n.note;
      else delete next.note;
      this.books.get(buyer)!.set(n.key, next);
      this.emit(buyer);
    }
  }

  private book(buyer: string) {
    let b = this.books.get(buyer);
    if (!b) this.books.set(buyer, (b = new Map()));
    return b;
  }

  private emit(buyer: string) {
    const orders = [...(this.books.get(buyer) ?? new Map<string, OrderSummary>()).entries()]
      .map(([key, summary]) => ({ key, summary }))
      .sort((a, b) => (b.summary.order_time ?? 0) - (a.summary.order_time ?? 0))
      .slice(0, MAX_ORDERS);
    this.onChange(buyer, orders);
  }
}
