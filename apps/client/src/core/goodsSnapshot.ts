/**
 * 商品快照（契约“商品快照（1.2 草案）”）：把本对话已读到的订单商品与商品卡片归并为 context.goods，
 * 并给订单生成 items。只用页面自身已加载、已归属到本对话的数据；草案双方审查通过、能力协商确认前不提交。
 *
 * 同一商品：有平台商品编号时按编号合并；没有编号的来源按完全相同的标题并入唯一同名的编号组，
 * 同名编号组不止一个时不合并（无法确定是哪件）。平台商品编号只在本机使用，不进入输出。
 */
import type { ContextMessage } from "./protocol.js";
import type { OrderGoods } from "./pddOrders.js";

export const MAX_GOODS = 10;
export const MAX_EVIDENCE = 5;
export const MAX_ORDER_ITEMS = 5;

export type GoodsEvidence =
  | { source: "order"; order_ref: string; sku?: string; quantity?: number; observed_at: number }
  | { source: "goods_card"; message_id: string; card_price?: string; observed_at: number };
export type GoodsSnapshot = { goods_ref: string; title: string; evidence: GoodsEvidence[] };
export type OrderItem = { goods_ref: string; goods_title: string; sku?: string; quantity?: number };

/** 输入：本对话的订单（已按买家归属），每单带对话内引用、读取时间与订单内商品。 */
export type SnapshotOrder = { order_ref: string; observed_at: number; goods: OrderGoods[] };

type Source = { goods_id: string | null; title: string; evidence: GoodsEvidence };

const URL_RE = /https?:\/\/|www\./i;

function cleanTitle(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t && !URL_RE.test(t) ? t.slice(0, 200) : null;
}

function evidenceKey(e: GoodsEvidence): string {
  return e.source === "order" ? `order:${e.order_ref}` : `card:${e.message_id}`;
}

/** 本对话消息里的商品卡片（kind=card、card.type=goods、有标题）。价格取卡片“价格”字段的文字。 */
function cardSources(messages: ContextMessage[]): Source[] {
  const out: Source[] = [];
  for (const m of messages) {
    if (m.kind !== "card" || m.card?.type !== "goods") continue;
    const title = cleanTitle(m.card.title);
    if (!title || !Number.isFinite(m.created_at)) continue;
    const price = m.card.fields?.find((f) => f.label === "价格")?.value;
    const card_price = typeof price === "string" && price.trim() && !URL_RE.test(price) ? price.trim().slice(0, 200) : undefined;
    out.push({ goods_id: null, title, evidence: { source: "goods_card", message_id: m.id, ...(card_price ? { card_price } : {}), observed_at: m.created_at } });
  }
  return out;
}

function orderSources(orders: SnapshotOrder[]): Source[] {
  const out: Source[] = [];
  for (const o of orders) {
    if (!Number.isFinite(o.observed_at)) continue;
    for (const g of o.goods.slice(0, MAX_ORDER_ITEMS)) {
      const title = cleanTitle(g.title);
      if (!title) continue;
      const sku = cleanTitle(g.sku) ?? undefined;
      const quantity = Number.isInteger(g.quantity) && (g.quantity as number) > 0 ? g.quantity : undefined;
      out.push({ goods_id: g.goods_id, title, evidence: { source: "order", order_ref: o.order_ref, ...(sku ? { sku } : {}), ...(quantity ? { quantity } : {}), observed_at: o.observed_at } });
    }
  }
  return out;
}

/**
 * 归并商品快照。makeRef(本机合并键) 生成对话内不透明引用（调用方用店铺、对话与合并键做摘要，不含平台编号原文）。
 * 返回 goods（≤10，按最新来源时间倒序；每项来源 ≤5，按时间倒序、同一来源只留最新）与各订单的 items。
 */
export function buildGoodsSnapshot(input: { orders: SnapshotOrder[]; messages: ContextMessage[] }, makeRef: (key: string) => string): { goods: GoodsSnapshot[]; items: Map<string, OrderItem[]> } {
  const sources = [...orderSources(input.orders), ...cardSources(input.messages)];
  // 合并键：有编号用编号；无编号先按标题，若恰有一个同名编号组则并入。
  const titleToIds = new Map<string, Set<string>>();
  for (const s of sources) if (s.goods_id) (titleToIds.get(s.title) ?? titleToIds.set(s.title, new Set()).get(s.title)!).add(s.goods_id);
  const keyOf = (s: { goods_id: string | null; title: string }) => {
    if (s.goods_id) return `id:${s.goods_id}`;
    const ids = titleToIds.get(s.title);
    return ids && ids.size === 1 ? `id:${[...ids][0]}` : `title:${s.title}`;
  };
  const groups = new Map<string, { title: string; titleAt: number; evidence: Map<string, GoodsEvidence> }>();
  for (const s of sources) {
    const key = keyOf(s);
    const g = groups.get(key) ?? groups.set(key, { title: s.title, titleAt: -Infinity, evidence: new Map() }).get(key)!;
    if (s.evidence.observed_at > g.titleAt) [g.title, g.titleAt] = [s.title, s.evidence.observed_at];
    const ek = evidenceKey(s.evidence);
    const prev = g.evidence.get(ek);
    if (!prev || s.evidence.observed_at > prev.observed_at) g.evidence.set(ek, s.evidence);
  }
  const ranked = [...groups.entries()]
    .map(([key, g]) => ({ key, title: g.title, evidence: [...g.evidence.values()].sort((a, b) => b.observed_at - a.observed_at).slice(0, MAX_EVIDENCE) }))
    .sort((a, b) => b.evidence[0].observed_at - a.evidence[0].observed_at)
    .slice(0, MAX_GOODS);
  const refs = new Map(ranked.map((g) => [g.key, makeRef(g.key)]));
  const goods = ranked.map((g) => ({ goods_ref: refs.get(g.key)!, title: g.title, evidence: g.evidence }));
  // 订单 items：只带商品进入了 goods 的项，保持订单内顺序。
  const items = new Map<string, OrderItem[]>();
  for (const o of input.orders) {
    const list: OrderItem[] = [];
    for (const g of o.goods.slice(0, MAX_ORDER_ITEMS)) {
      const title = cleanTitle(g.title);
      if (!title) continue;
      const ref = refs.get(keyOf({ goods_id: g.goods_id, title }));
      if (!ref) continue;
      const sku = cleanTitle(g.sku) ?? undefined;
      const quantity = Number.isInteger(g.quantity) && (g.quantity as number) > 0 ? g.quantity : undefined;
      list.push({ goods_ref: ref, goods_title: title, ...(sku ? { sku } : {}), ...(quantity ? { quantity } : {}) });
    }
    if (list.length) items.set(o.order_ref, list);
  }
  return { goods, items };
}
