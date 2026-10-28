/**
 * 商品快照（契约“商品快照（1.2 草案）”）：把本次提交的订单明细与商品卡片消息归为 context.goods，并生成订单明细 items。
 *
 * - 身份：有平台商品编号按编号，没有编号按完全相同的标题；两种身份不合并（同名不代表同一件）。
 *   没有编号时只有与页面原标题逐字相同（未被清理、截断）的标题才作身份，否则该明细不归入商品条目。
 *   goods_ref 由调用方用店铺、对话与身份键做摘要，同一对话内不随版本变化；平台商品编号不进入输出。
 * - 来源只取本次实际提交的内容：订单前 5 条明细（解析时已限定）、本次上下文里的商品卡片消息。
 * - 规格、件数只放订单明细；evidence 只说明“哪笔订单 / 哪条卡片消息里有这件商品”。
 * - items 不因 goods 上限删减；商品没进 goods 时该明细不带 goods_ref。
 */
import type { ContextMessage, GoodsEvidence, GoodsSnapshot, OrderItem } from "./protocol.js";
import type { OrderGoods } from "./pddOrders.js";

export const MAX_GOODS = 10;
export const MAX_EVIDENCE = 5;
export const MAX_ORDER_ITEMS = 5;
const MAX_TITLE = 200;

/** 输入：本次提交的订单（已按买家归属）——对话内引用、读取时间与订单明细。 */
export type SnapshotOrder = { order_ref: string; observed_at: number; goods: OrderGoods[] };

const URL_RE = /https?:\/\/|www\./i;

/** 已规整的标题才收：不含网址、不超过 200 字、首尾无空白且无连续空白（与提交的卡片标题逐字相等）。 */
function exactTitle(v: unknown): string | null {
  if (typeof v !== "string" || !v || v.length > MAX_TITLE || URL_RE.test(v)) return null;
  return v === v.replace(/\s+/g, " ").trim() ? v : null;
}

function cleanText(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t && !URL_RE.test(t) ? t.slice(0, MAX_TITLE) : undefined;
}

/** 身份键（只在本机使用）：编号身份与标题身份分开，永不互相合并。 */
export function goodsIdentity(goodsId: string | null, title: string): string {
  return goodsId ? `id:${goodsId}` : `title:${title}`;
}

/** key 为 null：没有编号、标题又被清理或截断过，无法确定身份——明细照列，但不归入任何商品条目。 */
type Line = { key: string | null; title: string; sku?: string; quantity?: number };

function orderLines(o: SnapshotOrder): Line[] {
  const out: Line[] = [];
  for (const g of o.goods.slice(0, MAX_ORDER_ITEMS)) {
    const title = cleanText(g.title);
    if (!title) continue;
    // 标题身份只认与页面原标题逐字相同的标题（exact）；有损清理、截断后的显示标题不作身份。
    const key = g.goods_id ? goodsIdentity(g.goods_id, title) : g.exact === true && exactTitle(g.title) === title ? goodsIdentity(null, title) : null;
    const sku = cleanText(g.sku);
    const quantity = Number.isInteger(g.quantity) && (g.quantity as number) > 0 ? g.quantity : undefined;
    out.push({ key, title, ...(sku ? { sku } : {}), ...(quantity ? { quantity } : {}) });
  }
  return out;
}

export function buildGoodsSnapshot(input: { orders: SnapshotOrder[]; messages: ContextMessage[] }, makeRef: (identity: string) => string): { goods: GoodsSnapshot[]; items: Map<string, OrderItem[]> } {
  const groups = new Map<string, { title: string; titleAt: number; evidence: Map<string, GoodsEvidence> }>();
  const add = (key: string, title: string, ek: string, e: GoodsEvidence) => {
    const g = groups.get(key) ?? groups.set(key, { title, titleAt: -Infinity, evidence: new Map() }).get(key)!;
    if (e.observed_at > g.titleAt || (e.observed_at === g.titleAt && title < g.title)) [g.title, g.titleAt] = [title, e.observed_at];
    if (!g.evidence.has(ek)) g.evidence.set(ek, e);
  };
  const lines = new Map<string, Line[]>();
  for (const o of input.orders) {
    if (!Number.isFinite(o.observed_at)) continue;
    const ls = orderLines(o);
    if (!ls.length) continue;
    lines.set(o.order_ref, ls);
    for (const l of ls) if (l.key) add(l.key, l.title, `order:${o.order_ref}`, { source: "order", order_ref: o.order_ref, observed_at: o.observed_at });
  }
  for (const m of input.messages) {
    if (m.kind !== "card" || m.card?.type !== "goods" || !Number.isFinite(m.created_at)) continue;
    const title = exactTitle(m.card.title);
    if (!title) continue;
    const price = m.card.fields?.find((f) => f.label === "价格")?.value;
    const card_price = typeof price === "string" && price && price.length <= MAX_TITLE && !URL_RE.test(price) ? price : undefined;
    // 卡片来源暂无平台编号（契约“暂不提供”），一律按标题身份。
    add(goodsIdentity(null, title), title, `card:${m.id}`, { source: "goods_card", message_id: m.id, ...(card_price ? { card_price } : {}), observed_at: m.created_at });
  }
  const byTime = (a: { observed_at: number }, b: { observed_at: number }) => b.observed_at - a.observed_at;
  const ranked = [...groups.entries()]
    .map(([key, g]) => ({ key, title: g.title, evidence: [...g.evidence.entries()].sort(([ka, a], [kb, b]) => byTime(a, b) || (ka < kb ? -1 : ka > kb ? 1 : 0)).map(([, e]) => e).slice(0, MAX_EVIDENCE) }))
    // 时间相同按身份键排序，保证同样的输入得到同样的顺序（避免无意义的版本变化）。
    .sort((a, b) => byTime(a.evidence[0], b.evidence[0]) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, MAX_GOODS);
  const refs = new Map(ranked.map((g) => [g.key, makeRef(g.key)]));
  const goods: GoodsSnapshot[] = ranked.map((g) => ({ goods_ref: refs.get(g.key)!, title: g.title, evidence: g.evidence }));
  // 被 MAX_EVIDENCE 截掉的订单来源不影响 items：items 照常列出明细，goods_ref 只看商品是否进入 goods。
  const items = new Map<string, OrderItem[]>();
  for (const [orderRef, ls] of lines) {
    items.set(orderRef, ls.map((l) => ({ ...(l.key && refs.has(l.key) ? { goods_ref: refs.get(l.key)! } : {}), goods_title: l.title, ...(l.sku ? { sku: l.sku } : {}), ...(l.quantity ? { quantity: l.quantity } : {}) })));
  }
  return { goods, items };
}
