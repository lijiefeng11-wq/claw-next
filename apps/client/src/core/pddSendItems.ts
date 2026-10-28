// 拼多多页面附加发送的候选与回执识别（契约“聊天页附加发送”）。
// 只读页面自己加载的数据：视频库列表、订单商品、说明书查询结果；平台编号只作本机私有 key，不进入提交内容。
// 字段依据：用户测试店铺诊断（只核对字段结构与“是否一致”，未记录任何值）：
// - 聊天记录视频消息 info.file_id = 视频库列表 id；
// - 说明书消息 info.data.goods_info.goods_id / book_info.book_id = 订单商品 goodsId / 说明书模板 templateId；
// - 商品卡片消息 info.goodsID = 发送的商品编号。

import type { PlatformSendOption } from "./adapter.js";
import { ORDER_LIST_PATHS } from "./pddOrders.js";

export const VIDEO_LIST_PATH = "/latitude/user/file/list";
export const INSTRUCT_PATH = "/tornado/instruct/getGoodsInstruct";
export const RECOMMEND_GOODS_PATH = "/latitude/goods/recommendGoods";

type Json = Record<string, any>;

function id(v: unknown): string | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v === "string" && /^[0-9]{1,32}$/.test(v)) return v;
  return null;
}

function label(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t && !/https?:\/\/|www\./i.test(t) ? t.slice(0, 200) : null;
}

/** 页面请求的视频库列表（只取审核通过、未删除的视频；状态 2 为页面自身请求的审核通过筛选）。 */
export function parseVideoLibrary(request: unknown, response: unknown, observedAt: number): PlatformSendOption[] | null {
  const req = (request ?? {}) as Json;
  const res = (response ?? {}) as Json;
  const list = res.result?.file_with_check_dtolist;
  if (res.success !== true || req.file_type_desc !== "video" || !Array.isArray(list)) return null;
  // 带搜索词或翻页的列表不完整，不作为候选全集。
  if ((typeof req.file_name === "string" && req.file_name.trim()) || (req.page !== undefined && req.page !== 1)) return null;
  const out: PlatformSendOption[] = [];
  for (const f of list as Json[]) {
    const fid = id(f?.id);
    const name = label(f?.name);
    if (!fid || !name || f.check_status !== 2 || f.is_deleted !== 0 || f.file_type !== "video") continue;
    const d = f.extra_info?.duration;
    out.push({ type: "video", key: `video:${fid}`, name, ...(typeof d === "number" && d >= 1 ? { duration: Math.round(d) } : {}), observed_at: observedAt });
  }
  return out;
}

/** 说明书查询（点“发送说明书”时页面加载）：key 含商品、模板编号与版本，任一变化即视为另一份说明书。 */
export function parseGoodsInstruct(request: unknown, response: unknown, observedAt: number): { goods: string; option: PlatformSendOption | null } | null {
  const req = (request ?? {}) as Json;
  const res = (response ?? {}) as Json;
  const goods = id(req.goodsId);
  if (!goods || res.success !== true) return null;
  const t = res.result?.templateVO;
  const g = res.result?.goodsVO;
  const tpl = id(t?.templateId);
  const version = id(t?.version) ?? (t?.version === 0 ? "0" : null);
  const name = label(t?.templateName);
  const title = label(g?.goodsName);
  if (id(g?.goodsId) !== goods || res.result?.instructStatus !== 1 || !tpl || version === null || !name || !title) return { goods, option: null };
  return { goods, option: { type: "instruction", key: `instruction:${goods}:${tpl}:${version}`, goods_title: title, name, observed_at: observedAt } };
}

export const INSTRUCT_SEND_PATH = "/latitude/goodsInstruct/sendToUser";

/** 点订单上“发送说明书”后页面加载的说明书（即对话框所示）是否就是该候选：商品、模板编号与版本都一致。 */
export function instructMatches(option: PlatformSendOption, request: unknown, response: unknown): boolean {
  return option.type === "instruction" && parseGoodsInstruct(request, response, 0)?.option?.key === option.key;
}

/** 候选 key `instruction:商品:模板:版本` → 发送请求应带的商品编号与 bookId（即模板编号）。 */
export function instructTarget(option: PlatformSendOption): { goodsId: string; bookId: string } | null {
  const [kind, goodsId, bookId, version] = option.key.split(":");
  return option.type === "instruction" && kind === "instruction" && goodsId && bookId && version !== undefined ? { goodsId, bookId } : null;
}

/** 页面发出的说明书发送请求：仅当已点击、是第一条、买家、商品编号与 bookId 都与本次候选一致时放行。 */
export function instructRequestAllowed(watch: { buyer: string; goodsId: string | null; bookId: string | null; clicked: boolean; requests: number }, body: unknown): boolean {
  const b = (body ?? {}) as Json;
  return watch.clicked && watch.requests === 0 && !!watch.goodsId && !!watch.bookId && String(b.uid ?? "") === watch.buyer && String(b.goodsId ?? "") === watch.goodsId && String(b.bookId ?? "") === watch.bookId;
}

/** 说明书发送接口的成功判定（result 恒为 null）：success 为 true，error_code 为成功码或缺省。 */
export function instructResponseOk(response: unknown): boolean {
  const r = (response ?? {}) as Json;
  return r.success === true && (r.error_code === undefined || r.error_code === null || r.error_code === 0 || r.error_code === 1000000);
}

/** 订单列表里的商品（按请求 uid 归属买家）。 */
export function parseOrderGoods(request: unknown, response: unknown): { buyer: string; goods: { goods: string; title: string }[] } | null {
  const uid = id((request as Json | null)?.uid);
  const res = (response ?? {}) as Json;
  if (!uid || res.success !== true) return null;
  const goods: { goods: string; title: string }[] = [];
  for (const o of Array.isArray(res.result?.orders) ? res.result.orders : []) {
    if (o?.uid !== undefined && String(o.uid) !== uid) continue;
    for (const g of Array.isArray(o?.orderGoodsList) ? o.orderGoodsList : [o?.orderGoodsList]) {
      const gid = id(g?.goodsId);
      const title = label(g?.goodsName);
      if (gid && title && !goods.some((x) => x.goods === gid)) goods.push({ goods: gid, title });
    }
  }
  return { buyer: uid, goods };
}

/** 聊天记录中客服发出的附加内容消息 → 与候选 key 可比的对象身份（说明书不含版本）。 */
export function sentItemIdentity(m: unknown): { type: PlatformSendOption["type"]; identity: string } | null {
  const msg = (m ?? {}) as Json;
  if (msg.from?.role !== "mall_cs") return null;
  const info = msg.info ?? {};
  if (msg.template_name === "library_video" && msg.type === 14) {
    const fid = id(info.file_id);
    return fid ? { type: "video", identity: `video:${fid}` } : null;
  }
  if (msg.template_name === "mall_after_sales_service_product_manual_card") {
    const goods = id(info.data?.goods_info?.goods_id);
    const book = id(info.data?.book_info?.book_id);
    return goods && book ? { type: "instruction", identity: `instruction:${goods}:${book}` } : null;
  }
  if (msg.template_name === "goods_info_card") {
    const goods = id(info.goodsID);
    return goods ? { type: "goods_card", identity: `goods:${goods}` } : null;
  }
  return null;
}

/** 候选 key → 与 sentItemIdentity 可比的身份。 */
export function optionIdentity(option: PlatformSendOption): string {
  return option.type === "instruction" ? option.key.split(":").slice(0, 3).join(":") : option.key;
}

/**
 * 按买家归集候选：视频库与说明书是店铺级（说明书只给订单里有该商品的买家），商品来自该买家订单。
 * 内容不变时沿用首次读到的时间，避免页面重新加载（包括前台自己执行发送时打开列表）使上下文版本无谓递增。
 */
export class PddSendOptionBook {
  private videos: PlatformSendOption[] = [];
  private readonly instructions = new Map<string, PlatformSendOption | null>();
  private readonly instructAt = new Map<string, number>();
  private readonly buyerGoods = new Map<string, { goods: string; title: string }[]>();
  private readonly recommend = new Map<string, GoodsRow[]>();
  private readonly firstSeen = new Map<string, { sig: string; at: number }>();
  epoch = 0;

  constructor(private readonly onChange: (buyer: string, options: PlatformSendOption[]) => void) {}

  reset() {
    this.epoch += 1;
    this.videos = [];
    this.instructions.clear();
    this.instructAt.clear();
    this.buyerGoods.clear();
    this.recommend.clear();
    this.firstSeen.clear();
  }

  static watches(path: string): boolean {
    return path === VIDEO_LIST_PATH || path === INSTRUCT_PATH || path === RECOMMEND_GOODS_PATH || ORDER_LIST_PATHS.has(path);
  }

  response(path: string, request: unknown, response: unknown, now: number) {
    if (path === VIDEO_LIST_PATH) {
      const list = parseVideoLibrary(request, response, now);
      if (!list) return;
      this.videos = list;
      for (const buyer of this.buyerGoods.keys()) this.emit(buyer);
    } else if (path === INSTRUCT_PATH) {
      const r = parseGoodsInstruct(request, response, now);
      if (!r) return;
      this.instructions.set(r.goods, r.option);
      this.instructAt.set(r.goods, now);
      for (const [buyer, goods] of this.buyerGoods) if (goods.some((g) => g.goods === r.goods)) this.emit(buyer);
    } else if (path === RECOMMEND_GOODS_PATH) {
      const r = parseRecommendGoods(request, response);
      if (!r) return;
      this.recommend.set(r.buyer, r.rows);
      if (!this.buyerGoods.has(r.buyer)) this.buyerGoods.set(r.buyer, []);
      this.emit(r.buyer);
    } else if (ORDER_LIST_PATHS.has(path)) {
      const r = parseOrderGoods(request, response);
      if (!r || !r.goods.length) return;
      const cur = this.buyerGoods.get(r.buyer) ?? [];
      for (const g of r.goods) if (!cur.some((x) => x.goods === g.goods)) cur.push(g);
      this.buyerGoods.set(r.buyer, cur);
      this.emit(r.buyer);
    }
  }

  /** 已出现过的买家对话（含没有订单的）：视频库候选对其同样可用。 */
  touch(buyer: string) {
    if (this.buyerGoods.has(buyer)) return;
    this.buyerGoods.set(buyer, []);
    if (this.videos.length) this.emit(buyer);
  }

  /** 该买家订单中尚未读到说明书、或读到已超过 maxAge 秒的商品。 */
  instructStale(buyer: string, now: number, maxAge: number): string[] {
    return (this.buyerGoods.get(buyer) ?? []).map((g) => g.goods).filter((g) => now - (this.instructAt.get(g) ?? -Infinity) > maxAge);
  }

  options(buyer: string): PlatformSendOption[] {
    const goods = this.buyerGoods.get(buyer) ?? [];
    const now = Date.now() / 1000;
    const raw: PlatformSendOption[] = [
      ...goods.flatMap((g) => {
        const ins = this.instructions.get(g.goods);
        return ins ? [ins] : [];
      }),
      ...this.goodsCards(buyer, goods, now),
      ...this.videos,
    ];
    return raw.map((o) => {
      const { observed_at, ...rest } = o;
      const sig = JSON.stringify(rest);
      const prev = this.firstSeen.get(o.key);
      if (prev && prev.sig === sig) return { ...o, observed_at: prev.at };
      this.firstSeen.set(o.key, { sig, at: observed_at });
      return o;
    });
  }

  /** 商品卡片候选：该买家“商品推荐”页签中列出的商品（只有列出的才点得到），订单中的商品排在前面。 */
  private goodsCards(buyer: string, ordered: { goods: string; title: string }[], now: number): PlatformSendOption[] {
    const listed = this.recommend.get(buyer) ?? [];
    const out = new Map<string, string>();
    for (const g of ordered) if (listed.some((r) => r.goods_id === g.goods)) out.set(g.goods, g.title);
    for (const r of listed) if (!out.has(r.goods_id) && r.name) out.set(r.goods_id, r.name);
    return [...out].map(([goods, title]): PlatformSendOption => ({ type: "goods_card", key: `goods:${goods}`, goods_title: title, observed_at: now }));
  }

  private emit(buyer: string) {
    this.onChange(buyer, this.options(buyer));
  }
}

/** 同步消息（plateau/sync/message）中的单条消息：只取编号、所属买家与原始结构（仅本机内存）。 */
export type SeenMessage = { msg_id: string; buyer: string; raw: Json };

export function parseSyncMessages(response: unknown): SeenMessage[] {
  const res = (response ?? {}) as Json;
  const out: SeenMessage[] = [];
  if (res.success !== true || !Array.isArray(res.result?.sync_data)) return out;
  for (const s of res.result.sync_data) {
    for (const d of Array.isArray(s?.data) ? s.data : []) {
      const m = d?.message;
      const msgId = id(m?.msg_id);
      const buyer = m?.to?.role === "user" ? id(m.to.uid) : m?.from?.role === "user" ? id(m.from.uid) : null;
      if (msgId && buyer) out.push({ msg_id: msgId, buyer, raw: m });
    }
  }
  return out;
}

export type ItemReceipt = { status: "confirmed"; platform_message_id: string } | { status: "unknown"; reason: string } | null;

/**
 * 附加发送回执判断（契约第 5–6 步）：平台接口明确成功，且相对点击前基线恰好新增一条本店客服发给该买家、
 * 同类型且对象一致的消息，才算 confirmed。返回 null 表示继续等待（截止后由调用方按 unknown 处理）。
 */
export function judgeItemReceipt(input: { apiOk: boolean | null; option: PlatformSendOption; buyer: string; baseline: Set<string>; seen: SeenMessage[] }): ItemReceipt {
  if (input.apiOk === false) return { status: "unknown", reason: "platform_send_failed" };
  const fresh = new Map<string, Json>();
  for (const m of input.seen) {
    if (m.buyer !== input.buyer || input.baseline.has(m.msg_id) || m.raw?.from?.role !== "mall_cs") continue;
    fresh.set(m.msg_id, m.raw);
  }
  const same = [...fresh.entries()].filter(([, raw]) => itemType(raw) === input.option.type);
  if (same.length > 1) return { status: "unknown", reason: "receipt_ambiguous" };
  if (input.apiOk !== true || same.length === 0) return null;
  const [msgId, raw] = same[0];
  const ident = sentItemIdentity(raw);
  if (!ident) return null;
  return ident.identity === optionIdentity(input.option) ? { status: "confirmed", platform_message_id: msgId } : { status: "unknown", reason: "receipt_object_mismatch" };
}

/** 消息所属的附加内容类型（不要求带对象编号）。 */
function itemType(raw: Json): PlatformSendOption["type"] | null {
  if (raw?.template_name === "library_video" || raw?.type === 14) return "video";
  if (raw?.template_name === "mall_after_sales_service_product_manual_card") return "instruction";
  if (raw?.template_name === "goods_info_card") return "goods_card";
  return null;
}

/** 视频库列表的一行（按页面返回顺序，含不可发送项），url 只留在本机内存用于核对页面发出的请求。 */
export type VideoRow = { key: string | null; name: string; url: string | null; cover: string | null };

export function parseVideoRows(request: unknown, response: unknown): VideoRow[] | null {
  const req = (request ?? {}) as Json;
  const res = (response ?? {}) as Json;
  const list = res.result?.file_with_check_dtolist;
  if (res.success !== true || req.file_type_desc !== "video" || !Array.isArray(list)) return null;
  if ((typeof req.file_name === "string" && req.file_name.trim()) || (req.page !== undefined && req.page !== 1)) return null;
  return (list as Json[]).map((f) => {
    const fid = id(f?.id);
    const https = (v: unknown) => (typeof v === "string" && v.startsWith("https://") ? v : null);
    return { key: fid ? `video:${fid}` : null, name: label(f?.name) ?? "", url: https(f?.url), cover: https(f?.extra_info?.video_cover_url) };
  });
}

/** 由本次候选的文件编号定位页面列表中的行；编号不唯一、名称已变或缺地址则不点击。 */
export function planVideoClick(rows: VideoRow[] | null, option: PlatformSendOption): { index: number; url: string; cover: string | null } | string {
  if (option.type !== "video") return "pdd_item_type_unsupported";
  if (!rows) return "pdd_video_library_not_loaded";
  const hits = rows.flatMap((r, i) => (r.key === option.key ? [i] : []));
  if (hits.length !== 1) return hits.length ? "pdd_video_file_not_unique" : "pdd_video_file_missing";
  const row = rows[hits[0]];
  if (row.name !== option.name) return "pdd_video_option_changed";
  if (!row.url) return "pdd_video_file_url_missing";
  return { index: hits[0], url: row.url, cover: row.cover };
}

/** 页面视频行快照：每行文字与行内元素的地址属性（仅本机内存）。 */
export type VideoDom = { texts: string[]; srcs: string[][] };

/**
 * 点击前核对页面第 index 行就是本次候选文件：行数与逐行名称须与列表一致，且该行自身带有能唯一映射回该文件的地址——
 * 文件地址，或在列表中独有的封面地址——且别的行没有。缺少或矛盾的身份一律不点击（不以名称推定）。
 */
export function verifyVideoTarget(rows: VideoRow[], index: number, dom: VideoDom): { basis: "url" | "cover" } | string {
  if (dom.texts.length !== rows.length || dom.srcs.length !== rows.length) return "pdd_video_rows_mismatch";
  if (!dom.texts.every((t, i) => !!rows[i].name && t.includes(rows[i].name))) return "pdd_video_rows_mismatch";
  const { url, cover } = rows[index];
  const ids: [string | null, "url" | "cover"][] = [[url, "url"], [cover && rows.filter((r) => r.cover === cover).length === 1 ? cover : null, "cover"]];
  for (const [v, basis] of ids) {
    if (!v) continue;
    if (dom.srcs.some((s, i) => i !== index && s.includes(v))) return "pdd_video_row_identity_mismatch";
    if (dom.srcs[index].includes(v)) return { basis };
  }
  return "pdd_video_row_identity_missing";
}

/** 页面发出的视频发送请求：仅当已点击、是第一条、买家与文件地址都与本次候选一致时放行。 */
export function libraryRequestAllowed(watch: { buyer: string; url: string | null; clicked: boolean; requests: number }, body: unknown): boolean {
  const b = (body ?? {}) as Json;
  return watch.clicked && watch.requests === 0 && !!watch.url && String(b.uid ?? "") === watch.buyer && b.url === watch.url;
}

/** 视频发送接口的成功判定：success 为 true 且 error_code 为成功码（实测成功时为 1000000）或缺省。 */
export function libraryResponseOk(response: unknown): boolean {
  const r = (response ?? {}) as Json;
  return r.success === true && (r.error_code === undefined || r.error_code === null || r.error_code === 0 || r.error_code === 1000000);
}


/** 右侧“商品”页签的推荐商品（按接口分组顺序展开；同一商品可出现在多个分组）。 */
export type GoodsRow = { goods_id: string; name: string; thumb: string | null; section: string };

export function parseRecommendGoods(request: unknown, response: unknown): { buyer: string; rows: GoodsRow[] } | null {
  const req = (request ?? {}) as Json;
  const res = (response ?? {}) as Json;
  const buyer = id(req.uid);
  if (!buyer || res.success !== true || !res.result || typeof res.result !== "object" || (req.pageNum !== undefined && req.pageNum !== 1)) return null;
  const out: GoodsRow[] = [];
  for (const [section, list] of Object.entries(res.result as Json)) {
    if (!Array.isArray(list)) continue;
    for (const g of list as Json[]) {
      const gid = id(g?.goodsId);
      if (!gid) continue;
      out.push({ goods_id: gid, name: label(g?.goodsName) ?? "", thumb: typeof g?.thumbUrl === "string" && g.thumbUrl.startsWith("https://") ? g.thumbUrl : null, section });
    }
  }
  return { buyer, rows: out };
}

/** 由候选商品编号在页面推荐列表中取其缩略图；缩略图须存在且只属于该商品。 */
export function planGoodsClick(rows: GoodsRow[] | null, option: PlatformSendOption): { goods_id: string; thumb: string } | string {
  if (option.type !== "goods_card") return "pdd_item_type_unsupported";
  if (!rows) return "pdd_goods_list_not_loaded";
  const goodsId = option.key.startsWith("goods:") ? option.key.slice(6) : "";
  const mine = rows.filter((r) => r.goods_id === goodsId);
  if (!goodsId || !mine.length) return "pdd_goods_not_in_list";
  const thumbs = new Set(mine.map((r) => r.thumb));
  if (thumbs.size !== 1 || !mine[0].thumb) return "pdd_goods_thumb_missing";
  const thumb = mine[0].thumb;
  if (rows.some((r) => r.goods_id !== goodsId && r.thumb === thumb)) return "pdd_goods_thumb_not_unique";
  return { goods_id: goodsId, thumb };
}

/**
 * 点击前核对页面推荐列表中哪一行是该商品：行数须与列表一致；所选行内图片须等于该商品缩略图，
 * 且该行不含其他商品的缩略图、带“发送商品”按钮。返回行序号或原因。
 */
export function verifyGoodsTarget(rows: GoodsRow[], goodsId: string, dom: { srcs: string[][]; hasBtn: boolean[] }): number | string {
  if (dom.srcs.length !== rows.length || dom.hasBtn.length !== rows.length) return "pdd_goods_rows_mismatch";
  const thumbOf = new Map<string, string>();
  for (const r of rows) if (r.thumb) thumbOf.set(r.goods_id, r.thumb);
  const mine = thumbOf.get(goodsId);
  if (!mine) return "pdd_goods_thumb_missing";
  const others = [...thumbOf.entries()].filter(([g]) => g !== goodsId).map(([, t]) => t);
  const index = dom.srcs.findIndex((s, i) => s.includes(mine) && !s.some((v) => others.includes(v)) && dom.hasBtn[i]);
  return index >= 0 ? index : "pdd_goods_row_identity_missing";
}

export const GOODS_CARD_SEND_PATH = "/plateau/message/send/mallGoodsCard";

/** 页面发出的商品卡片发送请求：仅当已点击、是第一条、买家与商品编号都与本次候选一致时放行。 */
export function goodsRequestAllowed(watch: { buyer: string; goodsId: string | null; clicked: boolean; requests: number }, body: unknown): boolean {
  const b = (body ?? {}) as Json;
  return watch.clicked && watch.requests === 0 && !!watch.goodsId && String(b.uid ?? "") === watch.buyer && String(b.goods_id ?? "") === watch.goodsId;
}

/** 商品卡片发送接口的成功判定：success 与 result 均为 true，error_code 为成功码或缺省。 */
export function goodsResponseOk(response: unknown): boolean {
  const r = (response ?? {}) as Json;
  return r.success === true && r.result === true && (r.error_code === undefined || r.error_code === null || r.error_code === 0 || r.error_code === 1000000);
}
