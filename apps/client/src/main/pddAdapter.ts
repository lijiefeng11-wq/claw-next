import { session } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { AdapterEvent, HistoryLoad, HistoryResult, ImageFetchResult, PlatformAdapter, PlatformNav, PlatformNavAction, PlatformStatus, SendItemRequest, SendRequest, SendResult } from "../core/adapter.js";
import { buyerFromListKey, decideOutgoing, parseChatList, parseCustomServiceInfo, parseRealtimeUserInfo, parseSendRequest, parseSendResponse } from "../core/pddParse.js";
import { PddOrderBook } from "../core/pddOrders.js";
import { PddSessionTracker } from "../core/pddSession.js";
import { PageHealth } from "../core/pageHealth.js";
import { GOODS_CARD_SEND_PATH, INSTRUCT_PATH, INSTRUCT_SEND_PATH, instructMatches, instructRequestAllowed, instructResponseOk, instructTarget, PddSendOptionBook, RECOMMEND_GOODS_PATH, goodsRequestAllowed, goodsResponseOk, parseRecommendGoods, planGoodsClick, verifyGoodsTarget, type GoodsRow, VIDEO_LIST_PATH, libraryResponseOk, verifyVideoTarget, judgeItemReceipt, libraryRequestAllowed, parseSyncMessages, parseVideoRows, planVideoClick, type SeenMessage, type VideoRow } from "../core/pddSendItems.js";
import { isAllowedImageUrl, isAllowedPlatformUrl, partitionFor, sniffImage } from "../core/security.js";
import { MAX_IMAGE_BYTES } from "../core/protocol.js";
import type { PlatformPage } from "./platformWorkspace.js";
import { dispatchPageClick, type PageClickResult } from "./pddClick.js";
import { PddMessageWatcher } from "./pddMessageWatcher.js";
import { popupSweepScript, type PopupSweepMode, type PopupSweepResult } from "./pddPopups.js";

const LOGIN_URL = "https://mms.pinduoduo.com/chat-merchant/index.html";

const SCHEMA_PATHS = [
  /^\/janus\/api\/new\/userinfo$/,
  /^\/earth\/api\/mallInfo\/commonMallInfo$/,
  /^\/janus\/api\/customService\/queryCustomServiceInfo$/,
  /^\/chats\//,
  /^\/plateau\/(chat|sync|message|file)\//,
  // 聊天页其他发送操作（说明书、商品卡片、图片/视频库）：只记字段结构，用于起草接口约定。
  /^\/latitude\/(goodsInstruct|goods|user\/file)\//,
  /^\/tornado\/instruct\//,
];

/** 订单、物流相关接口：只在诊断模式下记录字段结构，用于确认页面从哪里加载订单列表与快递信息。 */
const ORDER_HINT = /order|logistic|express|track|waybill|shipping|delivery/i;

function probePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.hostname !== "mms.pinduoduo.com") return null;
    return SCHEMA_PATHS.some((r) => r.test(url.pathname)) || ORDER_HINT.test(url.pathname) ? url.pathname : null;
  } catch {
    return null;
  }
}

/** 会话操作（转移、收藏、标星等）候选接口：仅诊断模式记录字段结构，不参与任何收发处理。 */
const ACTION_HINT = /transfer|assign|move|star|mark|collect|favou?r|follow|tag|label/i;

/**
 * 诊断记录可保留的单个词（路径段、界面类名须整段等于其中一个词，或符合下方固定组合规则）。其余一律匿名，
 * 不按“是否含数字”或“能否拆成已知词”判断：全字母或常用词拼成的买家/账号标识同样不得写入诊断文件。
 */
const PROBE_WORDS = new Set(
  (
    "api new common query get set list info detail update add remove delete del save batch check status config setting settings " +
    "user users userinfo mall shop custom service chat chats conv conversation session message messages msg send sync file files " +
    "library image video goods instruct order orders logistic logistics express track trace waybill shipping delivery " +
    "transfer assign move star mark collect collection favor favorite favourite follow tag tags label labels remark note top pin " +
    "read unread block group agent agents staff online offline janus plateau latitude tornado earth merchant index html js json " +
    "login auth token report log stat stats data page home search recommend card coupon refund after sale sales aftersale record " +
    "history count notice notify push ws websocket heartbeat ping by to from of and or with for all cancel " +
    "el ant dialog modal popover drawer title header footer body content wrapper wrap container panel right left side bar item items " +
    "box active selected select current cur on off disabled hover icon btn button tool tools toolbar menu tab tabs reply input " +
    "textarea editor avatar nickname name op ops operate operation action actions more close confirm ok primary default small mini " +
    "large text link inner outer main view tip tips tooltip badge dot second first last mask overlay popup layer scroll row col cell " +
    "table form radio checkbox switch option options dropdown trigger arrow up down img pic red yellow green blue gray grey orange " +
    "purple color camera is has " +
    "id ids uid uids ts time timestamp code success result error errors err total size type value values key keys extra ext " +
    "req resp request response target source busy available max min limit num number nick avatar mobile phone desc reason " +
    "start end begin expire expired create created modify modified enable enabled flag level priority sort seq version"
  ).split(" "),
);
const PROBE_WORDS_JSON = JSON.stringify([...PROBE_WORDS]);
/** 代码中已使用的平台固定类名（组合形式），诊断时可原样保留。 */
const SAFE_CLASSES_JSON = JSON.stringify([
  "chat-list", "chat-item", "chat-item-box", "msg-list", "reply-box", "reply-input", "reply-header", "right-panel", "bar-box",
  "bar-item", "bar-select", "order-panel-header", "order-panel-header-second", "order-panel-second-bar", "video-list-box",
  "send-video-btn", "chat-icon-camera",
]);

let staticSegments: Set<string> | null = null;

/** 已确认的静态接口路径中出现的段（含驼峰/下划线组合段），只认这些完整段。 */
function knownSegments(): Set<string> {
  staticSegments ??= new Set(
    [
      "/janus/api/new/userinfo",
      "/earth/api/mallInfo/commonMallInfo",
      "/janus/api/customService/queryCustomServiceInfo",
      "/chat-merchant/index.html",
      "/chats/shippingDetail",
      SEND_PATH,
      SYNC_PATH,
      LIBRARY_SEND_PATH,
      GOODS_CARD_SEND_PATH,
      INSTRUCT_PATH,
      INSTRUCT_SEND_PATH,
      RECOMMEND_GOODS_PATH,
      VIDEO_LIST_PATH,
    ].flatMap((p) => p.split("/").filter(Boolean)),
  );
  return staticSegments;
}

/**
 * 路径段只保留两类：已确认静态接口中的完整段，或单个小写已知词（如 transfer、star）。
 * 由已知词拼接的段（如 redGreen、online_staff）可能是买家/客服标识，与编号、编码段一样替换为 :id。
 */
export function maskPath(pathname: string): string {
  return pathname
    .split("/")
    .map((s) => (s === "" || knownSegments().has(s) || PROBE_WORDS.has(s) || /^v\d{1,2}$/.test(s) ? s : ":id"))
    .join("/");
}

export function actionProbePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.hostname !== "mms.pinduoduo.com" || !ACTION_HINT.test(url.pathname)) return null;
    return maskPath(url.pathname);
  } catch {
    return null;
  }
}

const ENUM_KEYS = new Set(["role", "type", "status", "cmd", "is_aut", "manual_reply", "source_id", "template_name"]);
const SHAPE_KEYS = new Set(["ts", "msg_id", "uid", "mall_id", "pre_msg_id"]);

/** 只收集类别标签字段的取值，以及时间戳/编号的“位数形态”（不含具体值）。 */
export function enumsOf(text: string | null): Record<string, string[]> {
  if (!text) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  const out: Record<string, Set<string>> = {};
  const add = (k: string, v: string) => (out[k] ??= new Set()).add(v);
  const walk = (v: unknown, parent: string, depth: number) => {
    if (depth > 8 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, parent, depth + 1));
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const name = parent === "from" || parent === "to" ? `${parent}.${k}` : k;
      if (ENUM_KEYS.has(k) && (typeof x === "string" || typeof x === "number") && String(x).length <= 32) add(name, String(x));
      else if (SHAPE_KEYS.has(k) && (typeof x === "string" || typeof x === "number")) add(`${k}:shape`, `${typeof x}:${String(x).replace(/[0-9]/g, "9").replace(/[a-z]/gi, "a")}`);
      else walk(x, k, depth + 1);
    }
  };
  walk(value, "", 0);
  return Object.fromEntries(Object.entries(out).map(([k, s]) => [k, [...s].slice(0, 30)]));
}

/** 把 JSON 文本转成“字段名 → 类型”的结构描述；不保留任何值。 */
export function schemaOf(text: string | null): unknown {
  if (text === null) return "non_text";
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "non_json";
  }
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null) return "null";
    if (Array.isArray(v)) return v.length ? [walk(v[0], depth + 1)] : [];
    if (typeof v === "object") {
      if (depth > 7) return "obj";
      const out: Record<string, unknown> = {};
      const keys = Object.keys(v as object);
      // 以数字/长编号作键的对象（按 ID 索引）只保留一个样例结构，键名替换为占位符。
      if (keys.length && keys.every((k) => /^[0-9a-f-]{6,}$/i.test(k))) return { "<id>": walk((v as Record<string, unknown>)[keys[0]], depth + 1) };
      for (const k of keys.slice(0, 80)) out[k] = walk((v as Record<string, unknown>)[k], depth + 1);
      return out;
    }
    return typeof v === "string" ? "str" : typeof v === "number" ? "num" : typeof v === "boolean" ? "bool" : typeof v;
  };
  return walk(value, 0);
}

/**
 * 会话操作接口可原样输出的完整字段名（逐字比对，不按分词组合判断：由常用词拼成的串也可能是账号标识）。
 */
const ACTION_FIELDS = new Set(
  (
    "success result data code msg message error error_code error_msg errorCode errorMsg list total status type target " +
    "target_id targetId target_uid targetUid uid cs_uid csUid mall_id mallId id ids online busy available reason " +
    "star star_type starType is_star isStar color mark mark_type markType is_mark isMark collect is_collect isCollect " +
    "collected favorite is_favorite isFavorite transfer transfer_type transferType server_time serverTime ts timestamp"
  ).split(" "),
);
const ACTION_SCHEMA_DEPTH = 8;
const ACTION_SCHEMA_NODES = 2000;

/**
 * 会话操作候选接口的字段结构：只保留 ACTION_FIELDS 中的完整字段名；其余键（可能是买家/客服标识）合并为一个 "<key>" 样例，
 * 另记匿名键个数 "<keys>"。不保留任何值。层数与节点数有上限，超出时以 "deep"/"truncated" 结束；任何异常返回 "error"。
 */
export function actionSchemaOf(text: string | null): unknown {
  if (text === null) return "non_text";
  try {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return "non_json";
    }
    let nodes = 0;
    const walk = (v: unknown, depth: number): unknown => {
      if (depth > ACTION_SCHEMA_DEPTH) return "deep";
      if (++nodes > ACTION_SCHEMA_NODES) return "truncated";
      if (v === null) return "null";
      if (Array.isArray(v)) return v.length ? [walk(v[0], depth + 1)] : [];
      if (typeof v === "object") {
        const out: Record<string, unknown> = {};
        let unknown = 0;
        for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 80)) {
          if (ACTION_FIELDS.has(k)) out[k] = walk(x, depth + 1);
          else if (unknown++ === 0) out["<key>"] = walk(x, depth + 1);
        }
        if (unknown) out["<keys>"] = unknown;
        return out;
      }
      return typeof v === "string" ? "str" : typeof v === "number" ? "num" : typeof v === "boolean" ? "bool" : typeof v;
    };
    return walk(value, 0);
  } catch {
    return "error";
  }
}

/**
 * 页面结构诊断（在隔离环境执行，页面脚本不可见）：只收集元素标签、类名、data-* 属性名、
 * 可编辑区域，以及不超过 6 个字的按钮文字（界面标签，如“发送”）。不收集昵称、消息正文等内容。
 */
const DOM_PROBE = `(() => {
  const KEY = /chat|conv|session|unread|badge|dot|count|msg|input|editor|send|reply|list|item|active|select|current/i;
  const sig = (el) => el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).join(".") : "");
  const chain = (el) => { const out = []; for (let e = el, i = 0; e && e !== document.body && i < 4; e = e.parentElement, i++) out.unshift(sig(e)); return out.join(" > "); };
  const classes = {};
  const editables = [];
  const buttons = [];
  for (const el of document.querySelectorAll("*")) {
    const cls = typeof el.className === "string" ? el.className : "";
    if (KEY.test(cls)) {
      const s = chain(el);
      const rec = (classes[s] ??= { count: 0, data: new Set() });
      rec.count++;
      for (const a of el.getAttributeNames()) if (a.startsWith("data-")) rec.data.add(a + ":" + String(el.getAttribute(a)).replace(/[0-9]/g, "9").replace(/[^9]/g, "a").slice(0, 16));
    }
    if (el.isContentEditable && !el.parentElement?.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /text|search/.test(el.type))) editables.push({ chain: chain(el), placeholder: el.getAttribute("placeholder") });
    if (el.tagName === "BUTTON" || el.getAttribute("role") === "button" || /btn|button|send/i.test(cls)) {
      const t = (el.textContent || "").trim();
      if (t.length <= 6) buttons.push({ chain: chain(el), text: t });
    }
  }
  const top = Object.entries(classes).filter(([, r]) => r.count >= 1).slice(0, 400).map(([chain, r]) => ({ chain, count: r.count, data: [...r.data].slice(0, 10) }));
  return { url: location.pathname + location.hash.replace(/[0-9]{5,}/g, "<id>"), classes: top, editables, buttons: buttons.slice(0, 80) };
})()`;

/**
 * 界面操作记录（隔离环境，页面脚本不可见）：人工每点一次可点击元素，记下它的界面标签（title/aria-label/
 * 不超过 8 字的文字）、图标类名与结构链，以及点击后新出现的弹窗标题。消息区、输入框内的点击不记录；
 * 会话列表内只记录不含文字的图标控件（标签只取 title/aria-label 中完整的操作词），选会话、点昵称不记录。
 * 类名只保留由已知词（PROBE_WORDS）组成的前 4 个，避免带出动态标识。不点击任何东西。另在开启时列出当前页面所有可点击控件，作为“按钮地图”。
 */
export const UI_RECORDER = `(() => {
  if (window.__clawUi) return true;
  const SKIP = "ul.msg-list, textarea, [contenteditable=true]";
  const LIST = "li.chat-item, .chat-list";
  const ICONISH = "i, svg, img, button, [role=button], [title], [aria-label], [class*=icon], [class*=star], [class*=collect], [class*=fav], [class*=mark], [class*=tag]";
  const short = (s) => { const t = (s || "").replace(/\\s+/g, " ").trim(); return t && t.length <= 8 && !/[0-9０-９¥￥@]/.test(t) ? t : null; };
  const actionWord = (s) => { const t = short(s); return t && /^(取消|已|标为|设为)?(收藏|标星|星标|标记|转移|转移会话|转接|置顶|关注|已读|未读|删除|移除|屏蔽)$/.test(t) ? t : null; };
  const btnish = (el) => el.matches("button, [role=button], [class*=btn], [class*=tab], [class*=menu]");
  const WORDS = new Set(${PROBE_WORDS_JSON});
  const SAFE = new Set(${SAFE_CLASSES_JSON});
  const known = (c) => {
    if (WORDS.has(c) || SAFE.has(c)) return true;
    const m = /^(el|ant|icon|btn|chat-icon)-([a-z]+)(?:__([a-z]+))?$/.exec(c);
    return !!m && WORDS.has(m[2]) && (!m[3] || WORDS.has(m[3]));
  };
  const cls = (el) => (typeof el.className === "string" ? el.className : el.getAttribute("class") || "").trim().split(/\\s+/).filter((c) => c && c.length <= 32 && known(c)).slice(0, 4);
  const sig = (el) => [el.tagName.toLowerCase(), ...cls(el)].join(".");
  const chain = (el) => { const out = []; for (let e = el, i = 0; e && e !== document.body && i < 5; e = e.parentElement, i++) out.unshift(sig(e)); return out.join(" > "); };
  const clickable = (el) => el.closest("button, a, [role=button], [title], [class*=btn], [class*=icon], [class*=tool], [class*=menu], [class*=tab], [class*=item]");
  const describe = (el) => {
    const icon = el.querySelector("i[class], svg[class], img[class]");
    return {
      label: short(el.getAttribute("title")) ?? short(el.getAttribute("aria-label")) ?? short(el.getAttribute("data-tip")) ?? (btnish(el) ? short(el.textContent) : null),
      icon: icon ? sig(icon) : null,
      chain: chain(el),
    };
  };
  const listIcon = (t) => {
    const el = t.closest(ICONISH);
    if (!el || !el.closest(LIST) || (el.textContent || "").trim()) return null;
    let label = null;
    for (let e = el, i = 0; !label && e && i < 3 && e.closest(LIST) && !(e.textContent || "").trim(); e = e.parentElement, i++) label = actionWord(e.getAttribute("title")) ?? actionWord(e.getAttribute("aria-label"));
    const icon = el.matches("i, svg, img") ? el : el.querySelector("i, svg, img");
    return { label, icon: icon ? sig(icon) : null, chain: chain(el), area: "chat_list" };
  };
  // 会话列表里点出的浮层可能以买家昵称为标题：此时标题只保留操作类词语。
  const dialogs = (fromList) => [...document.querySelectorAll("[class*=dialog], [class*=modal], [class*=popover], [class*=drawer], [role=dialog]")]
    .filter((d) => d.getBoundingClientRect().width > 0)
    .map((d) => (fromList ? actionWord : short)(d.querySelector("[class*=title], [class*=header], h1, h2, h3")?.textContent) ?? sig(d));
  const ui = (window.__clawUi = { queue: [] });
  document.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t || t.closest(SKIP)) return;
    const info = t.closest(LIST) ? listIcon(t) : describe(clickable(t) ?? t);
    if (!info) return;
    const fromList = info.area === "chat_list";
    const before = new Set(dialogs(fromList));
    const rec = { at: Date.now(), ...info, trusted: ev.isTrusted, opened: [] };
    ui.queue.push(rec);
    setTimeout(() => { rec.opened = dialogs(fromList).filter((d) => !before.has(d)).slice(0, 5); }, 800);
  }, true);
  return true;
})()`;

export const UI_MAP = `(() => {
  const SKIP = "ul.msg-list";
  const LIST = "li.chat-item, .chat-list";
  const short = (s) => { const t = (s || "").replace(/\\s+/g, " ").trim(); return t && t.length <= 8 && !/[0-9０-９¥￥@]/.test(t) ? t : null; };
  const actionWord = (s) => { const t = short(s); return t && /^(取消|已|标为|设为)?(收藏|标星|星标|标记|转移|转移会话|转接|置顶|关注|已读|未读|删除|移除|屏蔽)$/.test(t) ? t : null; };
  const btnish = (el) => el.matches("button, [role=button], [class*=btn], [class*=tab], [class*=menu]");
  const WORDS = new Set(${PROBE_WORDS_JSON});
  const SAFE = new Set(${SAFE_CLASSES_JSON});
  const known = (c) => {
    if (WORDS.has(c) || SAFE.has(c)) return true;
    const m = /^(el|ant|icon|btn|chat-icon)-([a-z]+)(?:__([a-z]+))?$/.exec(c);
    return !!m && WORDS.has(m[2]) && (!m[3] || WORDS.has(m[3]));
  };
  const cls = (el) => (typeof el.className === "string" ? el.className : el.getAttribute("class") || "").trim().split(/\\s+/).filter((c) => c && c.length <= 32 && known(c)).slice(0, 4);
  const sig = (el) => [el.tagName.toLowerCase(), ...cls(el)].join(".");
  const chain = (el) => { const out = []; for (let e = el, i = 0; e && e !== document.body && i < 5; e = e.parentElement, i++) out.unshift(sig(e)); return out.join(" > "); };
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll("button, a, [role=button], [title], [class*=btn], [class*=icon], [class*=tool]")) {
    if (el.closest(SKIP)) continue;
    const inList = !!el.closest(LIST);
    if (inList && (el.textContent || "").trim()) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const icon = el.querySelector("i[class], svg[class], img[class]");
    const label = inList ? (actionWord(el.getAttribute("title")) ?? actionWord(el.getAttribute("aria-label"))) : (short(el.getAttribute("title")) ?? short(el.getAttribute("aria-label")) ?? (btnish(el) ? short(el.textContent) : null));
    const rec = { label, icon: icon ? sig(icon) : null, chain: chain(el), area: inList ? "chat_list" : el.closest(".reply-box") ? "reply_box" : el.closest("[class*=side], [class*=right]") ? "side" : "other" };
    const key = rec.chain + "|" + rec.label;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  const tabText = (el) => { const t = (el.textContent || "").replace(/[0-9０-９()（）]/g, "").replace(/\\s+/g, " ").trim(); return t && t.length <= 8 && !/[¥￥@]/.test(t) ? t : null; };
  for (const el of document.querySelectorAll("div.right-panel div.bar-box li, ul.order-panel-header > li, ul.order-panel-header-second > li")) {
    out.push({ label: tabText(el), icon: null, chain: chain(el), area: "order_tabs", active: /(^|\\s)(active|selected|on|cur|current)(\\s|$)/.test(String(el.className)) });
  }
  return out.slice(0, 340);
})()`;

const UI_DRAIN = `(() => { const ui = window.__clawUi; if (!ui) return null; const done = ui.queue.filter((r) => Date.now() - r.at > 3000); ui.queue = ui.queue.filter((r) => Date.now() - r.at <= 3000); return done; })()`;

type UiClick = { at: number; label: string | null; icon: string | null; chain: string; area?: string; trusted: boolean; opened: string[] };

const SEND_PATH = "/plateau/chat/send_message";
const WORLD = 1001;
const ITEM = "li.chat-item .chat-item-box[data-random]";

/** 订单区两级只读标签：右侧“最新订单”，其下“个人订单”。返回 clicked | already | not_active | no_tab。 */
function orderTabsScript(uid: string): string {
  return `(async () => {
    const active = document.querySelector(${JSON.stringify(ITEM)} + ".active") ?? document.querySelector("li.chat-item.active .chat-item-box[data-random]");
    if (!active || !(active.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "not_active";
    const text = (el) => (el.textContent || "").replace(/[0-9０-９()（）\\s]/g, "");
    const find = (sel, label) => [...document.querySelectorAll(sel)].find((el) => text(el) === label);
    const press = (el) => {
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      for (const t of ["mousedown", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(t, opts));
    };
    let clicked = false;
    const top = find("div.right-panel div.bar-box li.bar-item", "最新订单");
    if (!top) return "no_tab";
    if (!top.classList.contains("bar-select")) {
      press(top);
      clicked = true;
      await new Promise((r) => setTimeout(r, 400));
    }
    const mine = find("ul.order-panel-header > li.order-panel-second-bar", "个人订单");
    if (!mine) return clicked ? "clicked" : "no_tab";
    if (!mine.classList.contains("bar-select")) {
      press(mine);
      clicked = true;
    }
    return clicked ? "clicked" : "already";
  })()`;
}
const TEXTAREA = "div.reply-box div.reply-input textarea";
const CAMERA = "div.reply-box div.reply-header i.chat-icon.chat-icon-camera";
const VIDEO_ROWS = "ul.video-list-box > li";
const VIDEO_BTN = "button.send-video-btn";
const LIBRARY_SEND_PATH = "/plateau/message/library_file/send";
const SYNC_PATH = "/plateau/sync/message";
/** 已实现页面执行与回执确认的附加类型；其余类型的候选暂不上报。 */
const SENDABLE_ITEMS = new Set(["video", "goods_card", "instruction"]);
const INSTRUCT_BTN = "div.order-item-list div.order-item div.order-btn span.order-btn-item";
const INSTRUCT_DIALOG = "div.el-dialog.goods-desc-modal-part-dialog";

/** 当前对话订单区可见的“发送说明书”按钮个数；已有说明书对话框打开时返回原因。 */
function instructButtonsScript(uid: string): string {
  return `(() => {
    const act = document.querySelector(${JSON.stringify(ITEM.replace("[data-random]", ".active[data-random]"))});
    if (!act || !(act.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "pdd_conversation_changed";
    if ([...document.querySelectorAll(${JSON.stringify(INSTRUCT_DIALOG)})].some((d) => d.getClientRects().length > 0)) return "pdd_instruct_dialog_already_open";
    return [...document.querySelectorAll(${JSON.stringify(INSTRUCT_BTN)})].filter((b) => b.getClientRects().length > 0 && (b.textContent || "").trim() === "发送说明书").length;
  })()`;
}

/** 当前对话订单区每个可见“发送说明书”按钮所在订单项的内容指纹（去空白、截 300 字）；取不到或页面上重复的为 null。 */
function instructButtonKeysScript(uid: string): string {
  return `(() => {
    const act = document.querySelector(${JSON.stringify(ITEM.replace("[data-random]", ".active[data-random]"))});
    if (!act || !(act.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "pdd_conversation_changed";
    if ([...document.querySelectorAll(${JSON.stringify(INSTRUCT_DIALOG)})].some((d) => d.getClientRects().length > 0)) return "pdd_instruct_dialog_already_open";
    const btns = [...document.querySelectorAll(${JSON.stringify(INSTRUCT_BTN)})].filter((b) => b.getClientRects().length > 0 && (b.textContent || "").trim() === "发送说明书");
    const keys = btns.map((b) => { const item = b.closest("div.order-item"); return item ? "k:" + (item.textContent || "").replace(/\\s+/g, "").slice(0, 300) : null; });
    return keys.map((k) => (k && keys.filter((x) => x === k).length === 1 ? k : null));
  })()`;
}

/** 点开第 index 个“发送说明书”按钮（只打开对话框，页面随之加载该商品的说明书）。 */
function instructOpenScript(uid: string, index: number): string {
  return `(() => {
    const act = document.querySelector(${JSON.stringify(ITEM.replace("[data-random]", ".active[data-random]"))});
    if (!act || !(act.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "pdd_conversation_changed";
    const btn = [...document.querySelectorAll(${JSON.stringify(INSTRUCT_BTN)})].filter((b) => b.getClientRects().length > 0 && (b.textContent || "").trim() === "发送说明书")[${index}];
    if (!btn) return "pdd_instruct_button_missing";
    btn.scrollIntoView({ block: "nearest" });
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    for (const t of ["mousedown", "mouseup", "click"]) btn.dispatchEvent(new MouseEvent(t, opts));
    return "clicked";
  })()`;
}

/** 唯一可见的说明书对话框须显示该说明书名称，返回其“发送说明书”按钮中心点或原因。 */
function instructDialogScript(uid: string, name: string): string {
  return `(() => {
    const act = document.querySelector(${JSON.stringify(ITEM.replace("[data-random]", ".active[data-random]"))});
    if (!act || !(act.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "pdd_conversation_changed";
    const dialogs = [...document.querySelectorAll(${JSON.stringify(INSTRUCT_DIALOG)})].filter((d) => d.getClientRects().length > 0);
    if (dialogs.length !== 1) return dialogs.length ? "pdd_instruct_dialog_not_unique" : "pdd_instruct_dialog_missing";
    if (!(dialogs[0].textContent || "").includes(${JSON.stringify(name)})) return "pdd_instruct_dialog_name_mismatch";
    const btns = [...dialogs[0].querySelectorAll("div.bottom-btn button.el-button--primary")].filter((b) => (b.textContent || "").trim() === "发送说明书");
    if (btns.length !== 1) return "pdd_instruct_send_button_missing";
    const r = btns[0].getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return "pdd_instruct_send_button_hidden";
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(x, y);
    if (top?.closest("button") !== btns[0]) return "pdd_instruct_send_button_covered:" + (top ? [top.tagName.toLowerCase(), ...[...top.classList].slice(0, 3)].join(".") : "none");
    return { x, y };
  })()`;
}

/** 关闭可见的说明书对话框（点右上角 ×）。 */
const INSTRUCT_CLOSE = `(() => {
  const dialogs = [...document.querySelectorAll(${JSON.stringify(INSTRUCT_DIALOG)})].filter((d) => d.getClientRects().length > 0);
  for (const d of dialogs) d.querySelector("button.el-dialog__headerbtn")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, button: 0 }));
  return dialogs.length ? "closed" : "none";
})()`;
const GOODS_ROW = "div.goodsRecommendItem";
/** 推荐商品列表变化慢，且发送商品卡片时会重新加载并核对；提交前每买家 5 分钟切一次页签即可，减少订单重读与界面打扰。 */
const GOODS_TAB_REFRESH_MS = 300_000;
const GOODS_BTN = "span.goods-btns-item.goods-btns-blue";
/** 准备阶段推荐商品最多等这么久（毫秒），并给切回订单页签、读订单留出 PREP_ORDERS_RESERVE_MS。 */
const PREP_GOODS_WAIT_MS = 1200;
const PREP_ORDERS_RESERVE_MS = 600;
/** 准备阶段剩余时间不足这么多（毫秒）就不在准备中打开说明书对话框，留给预热。 */
const PREP_INSTRUCT_MIN_MS = 1000;
/** 预热各步的上限（毫秒）；预热随时可被发送与准备抢占。 */
const WARM_GOODS_WAIT_MS = 1500;
const WARM_ORDERS_WAIT_MS = 3000;
const WARM_INSTRUCT_MS = 6000;

/** 预热前确认没人在用这个页面：该买家对话为当前对话、页面没有焦点、输入框为空、没有打开的说明书对话框。 */
function warmIdleScript(uid: string): string {
  return `(() => {
    const act = document.querySelector(${JSON.stringify(ITEM.replace("[data-random]", ".active[data-random]"))});
    if (!act || !(act.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "not_active";
    if (document.hasFocus()) return "page_focused";
    const ta = document.querySelector(${JSON.stringify(TEXTAREA)});
    if (ta && ta.value.trim()) return "input_not_empty";
    if ([...document.querySelectorAll(${JSON.stringify(INSTRUCT_DIALOG)})].some((d) => d.getClientRects().length > 0)) return "dialog_open";
    return "idle";
  })()`;
}

/** 等 p 完成，或预热被抢占时立即返回。 */
function unlessAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return Promise.race([p, new Promise<undefined>((r) => signal.addEventListener("abort", () => r(undefined), { once: true }))]);
}

/** 切到右侧“商品推荐”页签（名称含“商品”且唯一）；仅在该买家对话为当前对话时。返回 clicked | already | not_active | no_tab | ambiguous。 */
function goodsTabScript(uid: string): string {
  return `(() => {
    const active = document.querySelector(${JSON.stringify(ITEM)} + ".active") ?? document.querySelector("li.chat-item.active .chat-item-box[data-random]");
    if (!active || !(active.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "not_active";
    const hits = [...document.querySelectorAll("div.right-panel div.bar-box li.bar-item")].filter((t) => (t.textContent || "").includes("商品"));
    if (hits.length !== 1) return hits.length ? "ambiguous" : "no_tab";
    if (hits[0].classList.contains("bar-select")) return "already";
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    for (const t of ["mousedown", "mouseup", "click"]) hits[0].dispatchEvent(new MouseEvent(t, opts));
    return "clicked";
  })()`;
}

/** “商品推荐”页签各行的地址属性与是否带“发送商品”按钮。 */
const GOODS_ROWS = `(() => {
  const rows = [...document.querySelectorAll(${JSON.stringify(GOODS_ROW)})].filter((el) => el.getClientRects().length > 0);
  if (!rows.length) return "pdd_goods_rows_missing";
  return {
    srcs: rows.map((r) => [...r.querySelectorAll("*")].flatMap((e) => [...e.attributes].map((a) => a.value).filter((v) => v.startsWith("https://")))),
    hasBtn: rows.map((r) => [...r.querySelectorAll(${JSON.stringify(GOODS_BTN)})].some((b) => (b.textContent || "").trim() === "发送商品")),
  };
})()`;

/** 第 index 行（须仍带该商品缩略图）的“发送商品”按钮中心点。 */
function goodsButtonScript(uid: string, index: number, thumb: string): string {
  return `(() => {
    const act = document.querySelector(${JSON.stringify(ITEM.replace("[data-random]", ".active[data-random]"))});
    if (!act || !(act.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "pdd_conversation_changed";
    const row = [...document.querySelectorAll(${JSON.stringify(GOODS_ROW)})].filter((el) => el.getClientRects().length > 0)[${index}];
    if (!row) return "pdd_goods_rows_changed";
    if (![...row.querySelectorAll("*")].some((e) => [...e.attributes].some((a) => a.value === ${JSON.stringify(thumb)}))) return "pdd_goods_row_identity_changed";
    const btn = [...row.querySelectorAll(${JSON.stringify(GOODS_BTN)})].find((b) => (b.textContent || "").trim() === "发送商品");
    if (!btn) return "pdd_goods_button_missing";
    btn.scrollIntoView({ block: "nearest" });
    const r = btn.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return "pdd_goods_button_hidden";
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    if (document.elementFromPoint(x, y)?.closest(${JSON.stringify(GOODS_BTN)}) !== btn) return "pdd_goods_button_covered";
    return { x, y };
  })()`;
}

/** 视频弹窗是否已展开并列出视频；未展开时返回相机图标中心点。 */
const VIDEO_PANEL = `(() => {
  const rows = [...document.querySelectorAll(${JSON.stringify(VIDEO_ROWS)})].filter((li) => li.getClientRects().length > 0);
  if (rows.length) return "open";
  const cam = document.querySelector(${JSON.stringify(CAMERA)});
  if (!cam) return "pdd_video_entry_missing";
  const r = cam.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return "pdd_video_entry_hidden";
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  if (document.elementFromPoint(x, y)?.closest(${JSON.stringify(CAMERA)}) !== cam) return "pdd_video_entry_covered";
  return { x, y };
})()`;

/** 当前对话视频弹窗各行的文字，以及第 index 行发送按钮的中心点。 */
function videoRowsScript(uid: string, index: number): string {
  return `(() => {
    const act = document.querySelector(${JSON.stringify(ITEM.replace("[data-random]", ".active[data-random]"))});
    if (!act || !(act.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "pdd_conversation_changed";
    const rows = [...document.querySelectorAll(${JSON.stringify(VIDEO_ROWS)})].filter((li) => li.getClientRects().length > 0);
    if (!rows.length) return "pdd_video_panel_closed";
    const texts = rows.map((li) => li.querySelector("div.video-item-info")?.textContent || "");
    const srcs = rows.map((li) => [...li.querySelectorAll("*")].flatMap((e) => [...e.attributes].map((a) => a.value).filter((v) => v.startsWith("https://"))));
    const row = rows[${index}];
    const btn = row?.querySelector(${JSON.stringify(VIDEO_BTN)});
    if (!btn || btn.disabled) return "pdd_video_button_missing";
    btn.scrollIntoView({ block: "nearest" });
    const r = btn.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return "pdd_video_button_hidden";
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    if (document.elementFromPoint(x, y)?.closest(${JSON.stringify(VIDEO_BTN)}) !== btn) return "pdd_video_button_covered";
    return { texts, srcs, x, y };
  })()`;
}
const SEND_BTN = "div.reply-box div.reply-footer div.send-btn";

/** 列表与当前对话状态；__clawSeen 是隔离环境里的标记，页面脚本看不到。 */
const SCAN = `(() => {
  const items = [...document.querySelectorAll(${JSON.stringify(ITEM)})].map((e) => ({ key: e.getAttribute("data-random"), unread: e.classList.contains("un-watch"), active: e.classList.contains("active") }));
  const msgs = document.querySelectorAll("ul.msg-list > li.onemsg");
  const last = msgs[msgs.length - 1];
  const fresh = !!last && !last.__clawSeen;
  if (last) last.__clawSeen = true;
  return { items, freshBuyer: fresh && !!last.querySelector(".buyer-item") };
})()`;

type Scan = { items: { key: string; unread: boolean; active: boolean }[]; freshBuyer: boolean };

export type StarColor = "red" | "orange" | "blue" | "green";
type StarOption = { color: StarColor | "other"; checked: boolean; x: number; y: number };
type StarState = { star: { x: number; y: number; active: boolean }; options: StarOption[] };

/** 对话工具栏的“收藏该用户”星标：返回中心坐标与是否已收藏（active）。 */
const STAR_ICON = `(() => {
  const els = [...document.querySelectorAll('[title="收藏该用户"]')].filter((e) => e.getClientRects().length > 0);
  if (els.length !== 1) return els.length ? "star_not_unique" : "star_missing";
  const icon = els[0].matches("i") ? els[0] : els[0].querySelector("i") ?? els[0];
  const r = icon.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), active: icon.classList.contains("active") || els[0].classList.contains("active") };
})()`;

/** 星标悬停后弹出的颜色列表（离星标最近的可见 el-popover），按色点背景色识别颜色，带 chat-icon-check 的为当前颜色。 */
function starOptionsScript(star: { x: number; y: number }): string {
  return `(() => {
    const near = (p) => { const r = p.getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - ${star.x}) + Math.abs(r.top - ${star.y}); };
    const pops = [...document.querySelectorAll("div.el-popover")].filter((p) => p.getClientRects().length > 0 && p.querySelectorAll("ul > li").length >= 2).sort((a, b) => near(a) - near(b));
    if (!pops.length) return "popover_missing";
    const colorOf = (li) => {
      for (const el of [li, ...li.querySelectorAll("*")]) {
        const m = /rgba?\\((\\d+), (\\d+), (\\d+)(?:, ([\\d.]+))?\\)/.exec(getComputedStyle(el).backgroundColor);
        if (!m || m[4] === "0") continue;
        const [r, g, b] = [+m[1], +m[2], +m[3]];
        if (r > 200 && g > 200 && b > 200) continue;
        if (r > 200 && g < 130 && b < 130) return "red";
        if (r > 200 && g >= 130 && b < 120) return "orange";
        if (b > 170 && r < 160) return "blue";
        if (g > 140 && r < 160 && b < 160) return "green";
      }
      return "other";
    };
    return [...pops[0].querySelectorAll("ul > li")].map((li) => {
      const r = li.getBoundingClientRect();
      const check = li.querySelector("i.chat-icon-check");
      return { color: colorOf(li), checked: !!check && check.getClientRects().length > 0 && getComputedStyle(check).visibility !== "hidden", x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
  })()`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 自动清理平台引导弹窗的间隔。 */
export const POPUP_SWEEP_INTERVAL_MS = 2000;
/** 清理脚本须在提交后这么久内开始执行，每次点击前也核对；过了就不点击（页面忙时排队迟到的旧脚本不改变页面）。 */
export const POPUP_SWEEP_START_MS = 1500;
/** 清理脚本这么久仍未结束（页面卡住）：重新加载平台页面；旧文档销毁且已过点击时限后才解除与发送的互斥。 */
export const POPUP_SWEEP_STUCK_MS = 10_000;
/** 人工“清理弹窗”最多连清几轮（引导常一层接一层出现）。 */
const POPUP_MANUAL_ROUNDS = 5;

/** 被动解析的接口（仅 mms.pinduoduo.com）。 */
const PARSE_PATHS = new Set(["/chats/userinfo/realtime", "/janus/api/customService/queryCustomServiceInfo", "/plateau/chat/list"]);

function jsonOrNull(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 拼多多适配器：每店独立分区的平台窗口 + 被动读取页面自身请求的响应。
 * 不主动请求平台接口，不伪造风控参数，不解析二进制长连接。
 * 新消息：自动点开未读对话 / 当前对话出现新买家消息时刷新页面，让页面自己加载对话记录。
 * 发送：在页面输入框填入文字并点页面的发送按钮；页面发出的 send_message 在离开本机前经过核对，
 * 收件人或文字不一致即拦截；以页面发送响应中的平台消息编号确认。
 */
export class PddPageAdapter implements PlatformAdapter {
  readonly kind = "pdd" as const;
  readonly simulated = false;
  private window: PlatformPage | null = null;
  /** 当前平台页面的健康状态；每次新建页面重新开始。 */
  private health = new PageHealth();
  private healthKey = "";
  private readonly listeners: ((e: AdapterEvent) => void)[] = [];
  private readonly tracker = new PddSessionTracker((e) => this.emit(e));
  private probing = false;
  private outgoing: { to_uid: string; text: string; matched: string | null; blocked: number; resolve: (r: SendResult) => void } | null = null;
  private sendingValue = false;
  private messageWatcher: PddMessageWatcher | null = null;
  private watchEpoch = 0;
  private pendingFreshBuyer = false;
  private get sending() { return this.sendingValue; }
  private set sending(value: boolean) {
    this.sendingValue = value;
    if (!value) this.messageWatcher?.scheduler.resume();
  }
  private lastActiveUid: string | null = null;
  private clicked: { uid: string; at: number } | null = null;
  private readonly ordersRefreshAt = new Map<string, number>();
  private readonly sendOptions = new PddSendOptionBook((buyer, options) => {
    console.log(`[${this.shopId}] platform send options instructions=${options.filter((o) => o.type === "instruction").length} goods=${options.filter((o) => o.type === "goods_card").length} videos=${options.filter((o) => o.type === "video").length}`);
    this.emit({ type: "send_options", conversation_id: buyer, options: options.filter((o) => SENDABLE_ITEMS.has(o.type)) });
  });
  /** 附加发送进行中：收集该买家的新消息与页面发送请求结果（仅内存）。 */
  private itemWatch: { buyer: string; path: string; url: string | null; goodsId: string | null; bookId: string | null; seen: SeenMessage[]; clicked: boolean; requests: number; blocked: number; apiOk: boolean | null } | null = null;
  /** 各买家最近一次“商品推荐”列表（页面自己的请求），按接口分组顺序展开。 */
  private readonly goodsRows = new Map<string, { rows: GoodsRow[]; at: number }>();
  private readonly goodsTabAt = new Map<string, number>();
  private readonly instructTriedAt = new Map<string, number>();
  /**
   * 每买家一轮说明书收集的进度（只在内存）：已成功打开的按钮所在订单项的内容指纹，以及本轮已打开的次数。
   * 预算耗尽或被抢占时保留，下次（通常是预热）只跳过指纹完全相同、且在页面上唯一的按钮——按钮重排、插入、删除后仍能对上；
   * 指纹缺失、重复或内容变化的按钮一律重新打开，不按旧位置跳过。一轮最多打开 3 次，全部新鲜、试满或超过 10 分钟就开始新一轮。
   */
  private readonly instructRound = new Map<string, { done: Set<string>; opens: number; startedAt: number }>();
  /** 最近一次页面自己的说明书查询（点订单上“发送说明书”触发）。 */
  private lastInstruct: { request: unknown; response: unknown; at: number } | null = null;
  /** 最近一次完整视频库列表（第一页、无搜索），按页面顺序。 */
  private videoRows: VideoRow[] | null = null;
  private optionsPrepared = false;
  /** 进行中的预热；发送与准备开始前先让它在下一步之间停下（不以“忙”拒绝发送）。 */
  private warmRun: { ctrl: AbortController; done: Promise<void> } | null = null;
  /**
   * 进行中的弹窗清理。清理只在没有发送、准备、预热时开始；发送与准备开始前先等它结束，
   * 所以点击坐标规划期间页面不会因清理而变化。清理关掉了浮层时页面代次加一，未执行的点击按页面已变化放弃。
   * 占用页面的规则：等待（await）只是等，不算占用。多个等待者可能同时被唤醒，所以每个入口都要在最后一次 await
   * 返回后的同一同步段里复核“没有清理 / 预热 / 发送”并立即置 sending（或启动清理），中间不得再 await；
   * 复核不通过就继续等（do … while）。清理的启动（sweepPopupsOnce）同步设置 popupSweep。
   */
  private popupSweep: Promise<PopupSweepResult | null> | null = null;
  private readonly popupSeen = new Set<string>();
  private openFailures = new Map<string, { count: number; until: number }>();
  private reloadAt = 0;
  private offChatSince = 0;
  /** 最近一次通知界面的平台页面导航状态（noteNav 去重用）。 */
  private navKey = "";
  private lastSummary = "";
  private recentRequests: { at: number; req: string }[] = [];
  private readonly orders = new PddOrderBook((buyer, orders) => {
    console.log(`[${this.shopId}] platform orders count=${orders.length}`);
    this.emit({ type: "orders", conversation_id: buyer, orders });
  });

  /**
   * probeFile：只读诊断（CLAW_NEXT_PDD_PROBE=1），记录请求方法/域名/路径/状态码与指定接口的字段结构，
   * 不记录查询参数、请求/响应内容和 Cookie。
   */
  constructor(private readonly shopId: string, _title: string, private readonly probeFile: string | null = null, private readonly createPage?: () => PlatformPage) {}

  private attachNetwork(win: PlatformPage) {
    const schemaFile = this.probeFile?.replace(/requests\.jsonl$/, "schema.jsonl") ?? null;
    const write = (rec: Record<string, unknown>) => {
      if (schemaFile) fs.appendFile(schemaFile, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n", { mode: 0o600 }, () => undefined);
    };
    const dbg = win.webContents.debugger;
    // 监听只装一次；渲染进程崩溃会使调试通道断开，恢复时由 enableNetwork 重新附加并开启拦截。
    const pending = new Map<string, { path: string; postData: string | null; buyer: string | null; epoch: number; optionsEpoch: number }>();
    const discovered = new Map<string, string>();
    const seen = new Set<string>();
    const writeOnce = (kind: string, p: string, schema: unknown) => {
      const key = kind + p + JSON.stringify(schema);
      if (seen.has(key)) return;
      seen.add(key);
      write({ kind, path: p, schema });
    };
    dbg.on("message", (_e, method, params: any) => {
      if (method === "Network.requestWillBeSent") {
        const p = probePath(params.request?.url);
        const action = !p && schemaFile ? actionProbePath(params.request?.url) : null;
        if (action) {
          discovered.set(params.requestId, action);
          try {
            if (typeof params.request.postData === "string") writeOnce("action_request", action, actionSchemaOf(params.request.postData));
          } catch {
            // 诊断记录失败不得影响消息回调。
          }
          return;
        }
        if (!p) return;
        const postData = typeof params.request.postData === "string" ? params.request.postData : null;
        pending.set(params.requestId, { path: p, postData, buyer: this.orders.started(p, jsonOrNull(postData)), epoch: this.orders.epoch, optionsEpoch: this.sendOptions.epoch });
        if (postData && schemaFile) write({ kind: "request", path: p, schema: schemaOf(postData) });
      } else if (method === "Network.loadingFinished") {
        const action = discovered.get(params.requestId);
        if (action) {
          discovered.delete(params.requestId);
          dbg
            .sendCommand("Network.getResponseBody", { requestId: params.requestId })
            .then((r: any) => writeOnce("action_response", action, actionSchemaOf(r.base64Encoded ? null : (r.body as string))))
            .catch(() => undefined);
          return;
        }
        const req = pending.get(params.requestId);
        if (!req) return;
        pending.delete(params.requestId);
        dbg
          .sendCommand("Network.getResponseBody", { requestId: params.requestId })
          .finally(() => this.orders.finished(req.buyer))
          .then((r: any) => {
            const body = r.base64Encoded ? null : (r.body as string);
            if (req.path === SEND_PATH) this.onSendResponse(params.requestId, body);
            if (req.path === LIBRARY_SEND_PATH || req.path === GOODS_CARD_SEND_PATH || req.path === INSTRUCT_SEND_PATH || req.path === SYNC_PATH) this.onItemResponse(req.path, body);
            if (!PddOrderBook.watches(req.path) || req.epoch === this.orders.epoch) this.handleResponse(req.path, req.postData, body);
            if (req.path === VIDEO_LIST_PATH && req.optionsEpoch === this.sendOptions.epoch) {
              this.videoRows = parseVideoRows(jsonOrNull(req.postData), jsonOrNull(body)) ?? this.videoRows;
            }
            if (req.path === INSTRUCT_PATH && req.optionsEpoch === this.sendOptions.epoch) this.lastInstruct = { request: jsonOrNull(req.postData), response: jsonOrNull(body), at: Date.now() };
            if (req.path === RECOMMEND_GOODS_PATH && req.optionsEpoch === this.sendOptions.epoch) {
              const goods = parseRecommendGoods(jsonOrNull(req.postData), jsonOrNull(body));
              if (goods) this.goodsRows.set(goods.buyer, { rows: goods.rows, at: Date.now() });
            }
            if (PddSendOptionBook.watches(req.path) && req.optionsEpoch === this.sendOptions.epoch) this.sendOptions.response(req.path, jsonOrNull(req.postData), jsonOrNull(body), Math.floor(Date.now() / 1000));
            if (!schemaFile) return;
            const schema = schemaOf(body);
            const key = req.path + JSON.stringify(schema);
            if (seen.has(key)) return;
            seen.add(key);
            write({ kind: "response", path: req.path, schema });
          })
          .catch(() => undefined);
      } else if (method === "Network.loadingFailed") {
        discovered.delete(params.requestId);
        const failed = pending.get(params.requestId);
        this.orders.finished(failed?.buyer ?? null);
        pending.delete(params.requestId);
        if ((failed?.path === LIBRARY_SEND_PATH || failed?.path === GOODS_CARD_SEND_PATH || failed?.path === INSTRUCT_SEND_PATH) && this.itemWatch?.clicked) this.itemWatch.apiOk = false;
        const out = this.outgoing;
        if (out && out.matched === params.requestId) out.resolve({ status: "unknown", reason: "platform_request_failed" });
      } else if (method === "Fetch.requestPaused") {
        const paused = probePath(params.request?.url);
        if (paused === LIBRARY_SEND_PATH || paused === GOODS_CARD_SEND_PATH || paused === INSTRUCT_SEND_PATH) this.onItemSendPaused(dbg, params, paused);
        else this.onSendPaused(dbg, params);
      }
    });
    this.enableNetwork(win);
  }

  /** 附加调试通道（未附加时）并开启网络观察与发送拦截。返回调试通道是否已附加。 */
  private enableNetwork(win: PlatformPage): boolean {
    if (win.isDestroyed()) return false;
    const dbg = win.webContents.debugger;
    if (dbg.isAttached()) return true;
    try {
      dbg.attach("1.3");
    } catch {
      return false;
    }
    void dbg.sendCommand("Network.enable").catch(() => undefined);
    void dbg
      .sendCommand("Fetch.enable", {
        patterns: [SEND_PATH, LIBRARY_SEND_PATH, GOODS_CARD_SEND_PATH, INSTRUCT_SEND_PATH].map((p) => ({ urlPattern: "*://mms.pinduoduo.com" + p + "*", requestStage: "Request" })),
      })
      .catch(() => undefined);
    return true;
  }

  /** 页面发出的每个 send_message 都在此核对；有进行中的自动发送时，不一致即拦截，请求不会到达平台。 */
  private onSendPaused(dbg: Electron.Debugger, params: any) {
    const out = this.outgoing;
    const decision = out?.matched ? "block" : decideOutgoing(out, parseSendRequest(jsonOrNull(params.request?.postData)));
    console.log(`[${this.shopId}] platform send_message ${decision}`);
    if (decision === "block") {
      if (out) out.blocked += 1;
      void dbg.sendCommand("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
      return;
    }
    if (decision === "match" && out) out.matched = params.networkId ?? params.requestId;
    void dbg.sendCommand("Fetch.continueRequest", { requestId: params.requestId }).catch(() => undefined);
  }

  /** 附加发送期间页面发出的视频/商品卡片发送请求：仅放行本次点击发往目标买家、对象一致的第一条，其余在本机拦截。 */
  private onItemSendPaused(dbg: Electron.Debugger, params: any, p: string) {
    const watch = this.itemWatch;
    if (!watch) {
      void dbg.sendCommand("Fetch.continueRequest", { requestId: params.requestId }).catch(() => undefined);
      return;
    }
    const body = jsonOrNull(params.request?.postData);
    const ok = p !== watch.path ? false : p === LIBRARY_SEND_PATH ? libraryRequestAllowed(watch, body) : p === GOODS_CARD_SEND_PATH ? goodsRequestAllowed(watch, body) : instructRequestAllowed(watch, body);
    console.log(`[${this.shopId}] platform ${p === LIBRARY_SEND_PATH ? "library_file/send" : p === GOODS_CARD_SEND_PATH ? "mallGoodsCard" : "goodsInstruct/sendToUser"} ${ok ? "match" : "block"}`);
    if (!ok) {
      watch.blocked += 1;
      void dbg.sendCommand("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
      return;
    }
    watch.requests += 1;
    void dbg.sendCommand("Fetch.continueRequest", { requestId: params.requestId }).catch(() => undefined);
  }

  private onItemResponse(p: string, body: string | null) {
    const watch = this.itemWatch;
    if (!watch) return;
    const json = jsonOrNull(body) as { success?: unknown; error_code?: unknown } | null;
    if (p === LIBRARY_SEND_PATH) {
      if (watch.clicked) watch.apiOk = libraryResponseOk(json);
      console.log(`[${this.shopId}] platform library_file/send response success=${String(json?.success)} error_code=${typeof json?.error_code === "number" ? json.error_code : typeof json?.error_code}`);
    } else if (p === INSTRUCT_SEND_PATH) {
      if (watch.clicked) watch.apiOk = instructResponseOk(json);
      console.log(`[${this.shopId}] platform goodsInstruct/sendToUser response success=${String(json?.success)} error_code=${typeof json?.error_code === "number" ? json.error_code : typeof json?.error_code}`);
    } else if (p === GOODS_CARD_SEND_PATH) {
      if (watch.clicked) watch.apiOk = goodsResponseOk(json);
      console.log(`[${this.shopId}] platform mallGoodsCard response success=${String(json?.success)} result=${String((json as { result?: unknown } | null)?.result)} error_code=${typeof json?.error_code === "number" ? json.error_code : typeof json?.error_code}`);
    } else {
      watch.seen.push(...parseSyncMessages(json).filter((m) => m.buyer === watch.buyer));
    }
  }

  private onSendResponse(requestId: string, body: string | null) {
    const out = this.outgoing;
    if (!out || out.matched !== requestId) return;
    const r = parseSendResponse(jsonOrNull(body));
    out.resolve(r.confirmed ? { status: "confirmed", platform_message_id: r.msg_id } : { status: "unknown", reason: r.reason });
  }

  private run<T>(code: string): Promise<T> {
    const win = this.window;
    if (!win || win.isDestroyed()) return Promise.reject(new Error("platform_window_closed"));
    return win.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]) as Promise<T>;
  }

  private clickConversation(uid: string): Promise<boolean> {
    return this.run<boolean>(`(() => {
      const match = (e) => (e.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")});
      const el = [...document.querySelectorAll("div.all-chat-list " + ${JSON.stringify(ITEM)})].find(match) ?? [...document.querySelectorAll(${JSON.stringify(ITEM)})].find(match);
      if (!el) return false;
      if (el.classList.contains("active")) return true;
      const target = el.querySelector(".chat-detail") ?? el;
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      target.dispatchEvent(new MouseEvent("mousedown", opts));
      target.dispatchEvent(new MouseEvent("mouseup", opts));
      target.dispatchEvent(new MouseEvent("click", opts));
      return true;
    })()`);
  }

  /** 抢占预热：通知它停下并等它收尾（关闭已打开的对话框、释放页面）。 */
  private async yieldWarm(): Promise<void> {
    await this.popupIdle();
    const run = this.warmRun;
    if (!run) return;
    run.ctrl.abort();
    await run.done;
    await this.popupIdle();
  }

  /** 等进行中的弹窗清理结束。 */
  private async popupIdle(): Promise<void> {
    while (this.popupSweep) await this.popupSweep;
  }

  /**
   * 在当前页面执行一次弹窗清理；记录点过的按钮，跳过的浮层同一签名只记一次（只有结构与短标题）。
   * 互斥一直保持到脚本真正结束，或页面文档已销毁（导航、渲染进程退出、页面关闭）且已过脚本的点击时限——
   * 不按超时解除，所以未结束的清理不会与发送交错。脚本迟迟不结束时重新加载页面，由导航结束它。
   */
  private sweepPopupsOnce(win: PlatformPage, mode: PopupSweepMode): Promise<PopupSweepResult | null> {
    const wc = win.webContents;
    if (win.isDestroyed() || wc.isLoadingMainFrame()) return Promise.resolve(null);
    const deadline = Date.now() + POPUP_SWEEP_START_MS;
    // 文档已销毁或脚本被放弃（执行失败）：等过了点击时限再解除——脚本若因消息乱序落到新文档，开始时也已过时限、不会点击。
    const afterDeadline = () => new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, deadline + 200 - Date.now())));
    let gone = () => {};
    const pageGone = new Promise<null>((resolve) => (gone = () => void afterDeadline().then(resolve)));
    const events = ["did-navigate", "render-process-gone", "destroyed"] as const;
    for (const e of events) wc.on(e as "destroyed", gone);
    const stuck = setTimeout(() => {
      if (this.window !== win || win.isDestroyed()) return;
      console.log(`[${this.shopId}] platform popup sweep stuck: reload page`);
      this.reload("popup_sweep_stuck", true);
    }, POPUP_SWEEP_STUCK_MS);
    let script: Promise<unknown>;
    try {
      script = wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: popupSweepScript(mode, deadline) }]);
    } catch {
      script = Promise.resolve(null);
    }
    const run = Promise.race([script as Promise<PopupSweepResult>, pageGone])
      .catch(afterDeadline)
      .then((r) => {
        clearTimeout(stuck);
        for (const e of events) wc.removeListener(e as "destroyed", gone);
        if (!r || !Array.isArray(r.dismissed) || !Array.isArray(r.seen)) return null;
        if (r.expired) console.log(`[${this.shopId}] platform popup sweep expired: page busy, nothing clicked after deadline`);
        if (r.dismissed.length) this.watchEpoch++;
        for (const d of r.dismissed) console.log(`[${this.shopId}] platform popup dismissed mode=${mode} label=${d.label} layer=${d.layer}`);
        for (const v of r.seen) {
          const key = `${v.why}|${v.layer}|${v.title ?? ""}`;
          if (this.popupSeen.has(key) || this.popupSeen.size >= 50) continue;
          this.popupSeen.add(key);
          console.log(`[${this.shopId}] platform popup kept why=${v.why} layer=${v.layer} title=${v.title ?? "-"}`);
        }
        return r;
      });
    const tracked: Promise<PopupSweepResult | null> = run.finally(() => {
      if (this.popupSweep === tracked) this.popupSweep = null;
    });
    this.popupSweep = tracked;
    return tracked;
  }

  /** 定时自动清理：只在已登录的聊天页、没有发送/准备/预热、页面未在加载时进行。 */
  private autoPopups(win: PlatformPage) {
    if (this.window !== win || win.isDestroyed() || this.popupSweep || this.sending || this.outgoing || this.warmRun) return;
    if (!this.tracker.status(true).logged_in || win.webContents.isLoadingMainFrame() || !win.webContents.getURL().startsWith(LOGIN_URL)) return;
    void this.sweepPopupsOnce(win, "auto");
  }

  /**
   * 人工“清理弹窗”：连清最多 5 轮（每轮间隔 0.4 秒），另外处理浮层里的“关闭 / 取消”与任意浮层的关闭图标。
   * 发送进行中返回 pdd_send_busy；发送在两轮之间开始时就此停止。
   */
  async dismissPopups(): Promise<{ dismissed: number } | { blocked: string }> {
    const win = this.window;
    if (!win || win.isDestroyed()) return { blocked: "platform_window_closed" };
    if (this.sending || this.outgoing) return { blocked: "pdd_send_busy" };
    let dismissed = 0;
    for (let round = 0; round < POPUP_MANUAL_ROUNDS; round++) {
      do await this.popupIdle(); while (this.popupSweep);
      if (this.window !== win || win.isDestroyed() || this.sending || this.outgoing || this.warmRun) break;
      const r = await this.sweepPopupsOnce(win, "manual");
      if (!r?.dismissed.length) break;
      dismissed += r.dismissed.length;
      await sleep(400);
    }
    return { dismissed };
  }

  private reload(why: string, force = false) {
    const win = this.window;
    if (!win || win.isDestroyed() || (!force && Date.now() - this.reloadAt < 15_000)) return;
    this.reloadAt = Date.now();
    this.lastActiveUid = null;
    console.log(`[${this.shopId}] platform reload: ${why}`);
    win.webContents.reload();
  }

  /** 让页面加载有新消息的对话：点开未读对话；当前对话出现新买家消息则刷新页面。 */
  private async watch() {
    // 预热不挡新消息：有未读对话或当前对话出现新买家消息时先抢占预热，再照常处理。
    if (this.warmRun) {
      const pre = await this.run<Scan>(SCAN).catch(() => null);
      if (!pre || !(pre.freshBuyer || pre.items.some((i) => i.unread && !i.active))) return;
      if (pre.freshBuyer) this.pendingFreshBuyer = true;
      await this.yieldWarm();
    }
    if (this.sending || !this.tracker.status(true).logged_in) return;
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    const epoch = this.watchEpoch;
    // 离开聊天页就看不到新消息：停留超过 30 秒自动回到聊天页。
    if (!win.webContents.getURL().startsWith(LOGIN_URL)) {
      this.offChatSince ||= Date.now();
      if (Date.now() - this.offChatSince > 30_000) {
        this.offChatSince = 0;
        this.lastActiveUid = null;
        console.log(`[${this.shopId}] platform return to chat page`);
        void win.loadURL(LOGIN_URL).catch(() => undefined);
      }
      return;
    }
    this.offChatSince = 0;
    let scan: Scan;
    try {
      scan = await this.run<Scan>(SCAN);
    } catch {
      return;
    }
    if (this.window !== win || win.isDestroyed() || epoch !== this.watchEpoch) return;
    if (this.sending) {
      this.pendingFreshBuyer ||= scan.freshBuyer;
      this.messageWatcher?.scheduler.request();
      return;
    }
    scan.freshBuyer ||= this.pendingFreshBuyer;
    this.pendingFreshBuyer = false;
    const summary = `items=${scan.items.length} unread=${scan.items.filter((i) => i.unread).length} active=${scan.items.some((i) => i.active)} freshBuyer=${scan.freshBuyer}`;
    if (summary !== this.lastSummary) console.log(`[${this.shopId}] platform watch ${(this.lastSummary = summary)}`);
    const active = scan.items.find((i) => i.active);
    const activeUid = active ? buyerFromListKey(active.key) : null;
    const sameActive = activeUid !== null && activeUid === this.lastActiveUid;
    this.lastActiveUid = activeUid;
    const now = Date.now();
    if (this.clicked && now - this.clicked.at > 4000) {
      const { uid } = this.clicked;
      const loaded = this.tracker.lastLoadedAt(uid) * 1000 >= this.clicked.at;
      const isActive = activeUid === uid;
      console.log(`[${this.shopId}] platform auto-open loaded=${loaded} active=${isActive}`);
      this.clicked = null;
      if (loaded) this.openFailures.delete(uid);
      else {
        const f = this.openFailures.get(uid) ?? { count: 0, until: 0 };
        f.count += 1;
        if (f.count >= 2) {
          f.until = now + 5 * 60_000;
          f.count = 0;
          console.log(`[${this.shopId}] platform auto-open paused for a conversation (not loading)`);
        } else this.reload("conversation_not_loaded_after_open");
        this.openFailures.set(uid, f);
      }
    }
    if (sameActive && scan.freshBuyer) return this.reload("new_buyer_message_in_open_conversation");
    if (this.clicked) return;
    const unread = scan.items.find((i) => {
      const uid = i.unread && !i.active ? buyerFromListKey(i.key) : null;
      return uid !== null && (this.openFailures.get(uid)?.until ?? 0) < now;
    });
    if (!unread) return;
    const uid = buyerFromListKey(unread.key) as string;
    if (await this.clickConversation(uid).catch(() => false)) this.clicked = { uid, at: now };
  }

  private handleResponse(p: string, postData: string | null, body: string | null) {
    if (PddOrderBook.watches(p)) return this.orders.response(p, jsonOrNull(postData), jsonOrNull(body), Math.floor(Date.now() / 1000));
    if (!PARSE_PATHS.has(p)) return;
    const json = jsonOrNull(body);
    if (p === "/chats/userinfo/realtime") {
      const id = parseRealtimeUserInfo(json);
      if (id) this.tracker.identityFromRealtime(id);
    } else if (p === "/janus/api/customService/queryCustomServiceInfo") {
      const id = parseCustomServiceInfo(json);
      if (id) this.tracker.identityFromCsInfo(id);
    } else {
      const list = parseChatList(jsonOrNull(postData), json);
      console.log(`[${this.shopId}] platform chat/list ${list ? `messages=${list.messages.length} skipped=${list.skipped} has_more=${list.has_more}` : "unparsed"}`);
      if (list) {
        const watch = this.itemWatch;
        if (watch && watch.buyer === list.buyer_uid) {
          const raw = (json as { result?: { messages?: Record<string, unknown>[] } })?.result?.messages ?? [];
          for (const m of raw) if (typeof m?.msg_id === "string" || typeof m?.msg_id === "number") watch.seen.push({ msg_id: String(m.msg_id), buyer: list.buyer_uid, raw: m });
        }
        this.sendOptions.touch(list.buyer_uid);
        this.tracker.chatList(list);
      }
    }
  }

  private startProbe() {
    if (!this.probeFile || this.probing) return;
    this.probing = true;
    fs.mkdirSync(path.dirname(this.probeFile), { recursive: true, mode: 0o700 });
    const file = this.probeFile;
    session.fromPartition(partitionFor(this.shopId)).webRequest.onCompleted((d) => {
      if (!["mainFrame", "subFrame", "xhr", "webSocket", "other"].includes(d.resourceType)) return;
      let url: URL;
      try {
        url = new URL(d.url);
      } catch {
        return;
      }
      const masked = maskPath(url.pathname);
      const line = { at: new Date().toISOString(), type: d.resourceType, method: d.method, host: url.hostname, path: masked, status: d.statusCode };
      if (d.resourceType === "xhr" || d.resourceType === "other") {
        this.recentRequests.push({ at: Date.now(), req: `${d.method} ${url.hostname}${masked}` });
        if (this.recentRequests.length > 200) this.recentRequests.splice(0, this.recentRequests.length - 200);
      }
      fs.appendFile(file, JSON.stringify(line) + "\n", { mode: 0o600 }, () => undefined);
    });
  }

  /** 诊断模式：记录人工点了哪个按钮、随后弹出了什么、页面发出了哪些接口请求（只记方法与路径）。 */
  private startUiRecorder(win: PlatformPage, probeFile: string) {
    const actionsFile = probeFile.replace(/requests\.jsonl$/, "ui-actions.jsonl");
    const mapFile = probeFile.replace(/requests\.jsonl$/, "ui-map.json");
    let ticks = 0;
    const timer = setInterval(() => {
      if (win.isDestroyed()) return;
      const exec = <T>(code: string) => win.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]) as Promise<T>;
      void exec<boolean>(UI_RECORDER)
        .then(() => exec<UiClick[] | null>(UI_DRAIN))
        .then((done) => {
          for (const c of done ?? []) {
            const requests = [...new Set(this.recentRequests.filter((r) => r.at >= c.at - 200 && r.at <= c.at + 3000).map((r) => r.req))].slice(0, 20);
            const line = { at: new Date(c.at).toISOString(), label: c.label, icon: c.icon, chain: c.chain, area: c.area ?? null, trusted: c.trusted, opened: c.opened, requests };
            console.log(`[${this.shopId}] ui-click label=${c.label ?? "-"} opened=${c.opened.join("|") || "-"} requests=${requests.length}`);
            fs.appendFile(actionsFile, JSON.stringify(line) + "\n", { mode: 0o600 }, () => undefined);
          }
        })
        .catch(() => undefined);
      if (ticks++ % 15 === 0) {
        void exec<unknown[]>(UI_MAP)
          .then((controls) => fs.writeFile(mapFile, JSON.stringify({ at: new Date().toISOString(), controls }, null, 1), { mode: 0o600 }, () => undefined))
          .catch(() => undefined);
      }
    }, 2000);
    win.on("closed", () => clearInterval(timer));
  }

  status(): PlatformStatus {
    const base = this.tracker.status(this.window !== null);
    if (!this.window) return base;
    const page = this.health.view();
    // 页面异常时以页面状态为准，避免显示“等待登录”掩盖崩溃或无响应。
    const abnormal = page.gave_up || (page.state !== "ok" && page.state !== "loading");
    return { ...base, detail: abnormal ? page.detail : base.detail, page, nav: this.navState(this.window) };
  }

  /**
   * 平台页面是否停在会话页、能否后退（读不到时按“不在会话页、不能后退”处理）。
   * 只在离开会话页时允许后退，且上一条记录须是平台页面、不是登录页：退回登录页会被当成退出登录。
   */
  private navState(win: PlatformPage): PlatformNav {
    try {
      if (win.isDestroyed()) return { on_chat: false, can_go_back: false };
      const wc = win.webContents;
      const onChat = wc.getURL().startsWith(LOGIN_URL);
      if (onChat) return { on_chat: true, can_go_back: false };
      const history = wc.navigationHistory;
      const index = history.getActiveIndex();
      const prev = index > 0 ? (history.getEntryAtIndex(index - 1)?.url ?? "") : "";
      return { on_chat: false, can_go_back: isAllowedPlatformUrl(prev) && !isLoginPage(prev) };
    } catch {
      return { on_chat: false, can_go_back: false };
    }
  }

  /** 页面导航后：会话页 / 能否后退有变化时通知界面刷新“后退 / 回到会话”按钮；同一状态不重复通知。 */
  private noteNav(win: PlatformPage) {
    if (this.window !== win) return;
    const key = JSON.stringify(this.navState(win));
    if (key === this.navKey) return;
    this.navKey = key;
    this.emit({ type: "status" });
  }

  /**
   * 人工导航平台页面：back 后退一步（不满足 navState 的后退条件时拒绝），chat 回到会话页（已在会话页时不重载）。
   * 发送或待确认发送进行中（sending / outgoing）拒绝；导航使页面代次失效，未执行的点击按页面已变化放弃。
   */
  navigatePlatform(action: PlatformNavAction): string | null {
    const win = this.window;
    if (!win || win.isDestroyed()) return "platform_window_closed";
    if (this.sending || this.outgoing) return "pdd_send_busy";
    const nav = this.navState(win);
    if (action === "back" && !nav.can_go_back) return "platform_no_history";
    if (action === "chat" && nav.on_chat) return null;
    this.watchEpoch++;
    this.lastActiveUid = null;
    this.offChatSince = 0;
    console.log(`[${this.shopId}] platform navigate: ${action}`);
    this.enableNetwork(win);
    if (action === "back") win.webContents.navigationHistory.goBack();
    else void win.loadURL(LOGIN_URL).catch(() => undefined);
    return null;
  }

  /**
   * 定时检查页面健康并自动恢复。只在页面生命周期异常时动作；正在发送时先等待（有上限）。
   * 恢复会使页面代次失效：旧页面上尚未点击的操作按未发送放弃，已点击的保持原有不确定判定，不重发。
   */
  private healthTick(win: PlatformPage) {
    const health = this.health;
    if (this.window !== win || win.isDestroyed()) return;
    const action = health.decide(this.sending || !!this.outgoing);
    if (action === "reload" || action === "kill") {
      health.acted(action);
      this.watchEpoch++;
      this.lastActiveUid = null;
      if (action === "kill") {
        console.log(`[${this.shopId}] platform page unresponsive: ending renderer`);
        win.webContents.forcefullyCrashRenderer();
      } else {
        console.log(`[${this.shopId}] platform page recovery: reload (recent=${health.view().reloads})`);
        this.enableNetwork(win);
        void win.loadURL(LOGIN_URL).catch(() => undefined);
      }
    }
    const v = health.view();
    const key = `${v.state}|${v.gave_up}|${v.detail}|${v.session_lost}`;
    if (key !== this.healthKey) {
      if (v.gave_up && this.healthKey.split("|")[1] !== "true") console.log(`[${this.shopId}] platform page recovery: gave up`);
      this.healthKey = key;
      this.emit({ type: "status" });
    }
  }

  /** 人工“重新加载平台页”：清除放弃状态并重新打开聊天页。返回阻止原因，成功为 null。 */
  reloadPage(): string | null {
    const win = this.window;
    if (!win || win.isDestroyed()) return "platform_window_closed";
    if (this.sending || this.outgoing) return "pdd_send_busy";
    this.health.resetGiveUp();
    this.watchEpoch++;
    this.lastActiveUid = null;
    console.log(`[${this.shopId}] platform page reload: manual`);
    this.enableNetwork(win);
    void win.loadURL(LOGIN_URL).catch(() => undefined);
    return null;
  }

  async login() {
    if (this.window && !this.window.isDestroyed()) return;
    if (!this.createPage) throw new Error("platform_workspace_unavailable");
    this.startProbe();
    const win = this.createPage();
    this.health = new PageHealth();
    this.healthKey = "";
    // 只处理当前页面的事件；先更新健康状态，再立即检查是否需要恢复与提醒。
    const onPage = (update: (health: PageHealth) => void) => {
      if (this.window !== win) return;
      update(this.health);
      this.healthTick(win);
    };
    win.webContents.on("did-finish-load", () => onPage((h) => h.loadFinished()));
    win.webContents.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
      // -3（ERR_ABORTED）是被新导航中止，不算失败。
      if (!isMainFrame || code === -3) return;
      onPage((h) => h.loadFailed());
    });
    win.webContents.on("render-process-gone", (_e, details) =>
      onPage((h) => {
        console.log(`[${this.shopId}] platform page gone reason=${details.reason}`);
        h.crashed();
        this.watchEpoch++;
        this.lastActiveUid = null;
        this.tracker.end("platform_page_crashed");
      }),
    );
    win.webContents.on("unresponsive", () => onPage((h) => h.unresponsive()));
    win.webContents.on("responsive", () => onPage((h) => h.responsive()));
    const healthTimer = setInterval(() => this.healthTick(win), 1000);
    win.on("closed", () => clearInterval(healthTimer));
    const popupTimer = setInterval(() => this.autoPopups(win), POPUP_SWEEP_INTERVAL_MS);
    win.on("closed", () => clearInterval(popupTimer));
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedPlatformUrl(url)) void win.loadURL(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedPlatformUrl(url)) event.preventDefault();
    });
    win.webContents.on("will-redirect", (event, url) => {
      if (!isAllowedPlatformUrl(url)) event.preventDefault();
    });
    win.webContents.on("did-start-loading", () => {
      this.lastActiveUid = null;
      // 崩溃后调试通道会断开；新页面开始加载时补附加，确保能观察页面请求并拦截发送。
      this.enableNetwork(win);
    });
    const onNavigate = (_e: unknown, url: string) => {
      if (isLoginPage(url)) this.tracker.end("platform_logged_out");
      this.noteNav(win);
    };
    win.webContents.on("did-navigate", onNavigate);
    win.webContents.on("did-navigate-in-page", onNavigate);
    win.on("resized", () => { this.watchEpoch++; });
    this.attachNetwork(win);
    if (this.probeFile) {
      const domFile = this.probeFile.replace(/requests\.jsonl$/, "dom.json");
      const timer = setInterval(() => {
        win.webContents
          .executeJavaScriptInIsolatedWorld(1001, [{ code: DOM_PROBE }])
          .then(async (r) => {
            const randoms: string[] = await win.webContents.executeJavaScriptInIsolatedWorld(1001, [
              { code: `[...document.querySelectorAll("li.chat-item .chat-item-box[data-random]")].map((e) => e.getAttribute("data-random"))` },
            ]);
            const known = new Set(this.tracker.knownConversations());
            const items = randoms.map((v) => ({ prefix_is_known_buyer: known.has((/^[0-9]+/.exec(v) ?? [""])[0]), shape: v.replace(/[0-9]/g, "9").replace(/[^9]/g, (c) => (c === "-" || c === "_" ? c : "a")) }));
            fs.writeFile(domFile, JSON.stringify({ at: new Date().toISOString(), items, ...r }, null, 1), { mode: 0o600 }, () => undefined);
          })
          .catch(() => undefined);
      }, 10_000);
      win.on("closed", () => clearInterval(timer));
      this.startUiRecorder(win, this.probeFile);
    }
    this.messageWatcher = new PddMessageWatcher(win.webContents, () => this.watch(), () => (this.sending && !this.warmRun) || !!this.outgoing, () => { this.watchEpoch++; this.pendingFreshBuyer = false; });
    const watcher = this.messageWatcher;
    win.on("closed", () => {
      watcher.close();
      if (this.messageWatcher === watcher) this.messageWatcher = null;
      if (this.window !== win) return;
      this.window = null;
      this.tracker.end("platform_window_closed");
      this.emit({ type: "status" });
    });
    this.window = win;
    this.navKey = "";
    this.emit({ type: "status" });
    await win.loadURL(LOGIN_URL).catch(() => undefined);
  }

  async logout() {
    this.window?.close();
  }

  async fetchHistory(conversationId: string): Promise<HistoryResult> {
    return this.tracker.history(conversationId);
  }

  historyLoadedAt(conversationId: string): number {
    return this.tracker.lastLoadedAt(conversationId) * 1000;
  }

  historyLoads(conversationId: string): HistoryLoad[] {
    return this.tracker.historyLoads(conversationId);
  }

  /**
   * 提交前让页面读一次该买家的订单：只在该对话正打开时，确保选中“最新订单”与“个人订单”两个只读标签（未选中才点）。
   * 同一买家 30 秒内只点一次；找不到标签或对话未打开就跳过，不重试。
   */
  async ordersSettled(conversationId: string, timeoutMs: number): Promise<void> {
    await this.yieldWarm();
    const deadline = Date.now() + timeoutMs;
    const last = this.ordersRefreshAt.get(conversationId) ?? 0;
    if (!this.sending && Date.now() - last >= 30_000) {
      this.ordersRefreshAt.set(conversationId, Date.now());
      const since = Date.now();
      const result = await this.run<string>(orderTabsScript(conversationId)).catch(() => "error");
      const loaded = result === "clicked" ? await this.orders.startedSince(conversationId, since, Math.min(1500, Math.max(0, deadline - Date.now()))) : false;
      console.log(`[${this.shopId}] platform orders refresh result=${result}${result === "clicked" ? ` loaded=${loaded}` : ""}`);
    }
    return this.orders.settled(conversationId, Math.max(0, deadline - Date.now()));
  }

  async fetchImage(ref: string): Promise<ImageFetchResult> {
    if (!isAllowedImageUrl(ref)) {
      let host = "invalid";
      try {
        host = new URL(ref).hostname;
      } catch {
        // 保持 invalid
      }
      return { ok: false, reason: `image_host_not_allowed:${host}` };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await session.fromPartition(partitionFor(this.shopId)).fetch(ref, { signal: ctrl.signal, redirect: "error" });
      if (!res.ok) return { ok: false, reason: `image_http_${res.status}` };
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > MAX_IMAGE_BYTES) return { ok: false, reason: "image_too_large" };
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: "image_too_large" };
      const mime = sniffImage(bytes);
      return mime ? { ok: true, mime, bytes } : { ok: false, reason: "image_type_unsupported" };
    } catch {
      return { ok: false, reason: ctrl.signal.aborted ? "image_fetch_timeout" : "image_fetch_failed" };
    } finally {
      clearTimeout(timer);
    }
  }

  async send(request: SendRequest): Promise<SendResult> {
    const notSent = (reason: string): SendResult => ({ status: "not_sent", reason });
    // 占用页面：等清理与预热结束后，在 await 返回的同一同步段里复核并置 sending（见 popupSweep 说明）。
    do await this.yieldWarm(); while (this.popupSweep || this.warmRun);
    if (!this.window || this.window.isDestroyed()) return notSent("platform_window_closed");
    if (!this.tracker.status(true).logged_in) return notSent("platform_logged_out");
    if (this.sending || this.outgoing) return notSent("pdd_send_busy");
    if (!/^[0-9]{1,32}$/.test(request.conversation_id) || !request.text.trim()) return notSent("pdd_send_invalid_request");
    const uid = request.conversation_id;
    const text = request.text;
    const page = this.window, epoch = this.watchEpoch;
    this.sending = true;
    try {
      // 第一阶段：打开对话、检查输入框。失败均未触碰发送按钮。
      const notOpened = await this.openConversation(uid);
      if (notOpened) return notSent(notOpened);
      const guard = `const act = document.querySelector(${JSON.stringify(ITEM.replace("[data-random]", ".active[data-random]"))});
        if (!act || !(act.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "pdd_conversation_changed";
        const ta = document.querySelector(${JSON.stringify(TEXTAREA)});
        const btn = document.querySelector(${JSON.stringify(SEND_BTN)});
        if (!ta || !btn) return "pdd_input_missing";`;
      const filled = await this.run<string>(`(() => { ${guard}
        if (ta.value.trim()) return "pdd_input_not_empty";
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return "filled"; })()`).catch(() => "pdd_page_script_failed");
      if (filled !== "filled") return notSent(filled);
      await sleep(200);
      const left = () => (request.deadline ?? Infinity) - Date.now() / 1000;
      if (left() < 1.5) {
        await this.clearInput(text);
        return notSent("claim_expiring");
      }
      const result = new Promise<SendResult>((resolve) => {
        this.outgoing = { to_uid: uid, text, matched: null, blocked: 0, resolve };
      });
      // CDP 使用页面视口 CSS 坐标，不依赖桌面焦点或页面缩放。
      const located = await this.run<string | { x: number; y: number }>(`(() => { ${guard}
        if (ta.value !== ${JSON.stringify(text)}) return "pdd_input_mismatch";
        const r = btn.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return "pdd_send_button_hidden";
        const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
        if (document.elementFromPoint(x, y)?.closest(${JSON.stringify(SEND_BTN)}) !== btn) return "pdd_send_button_covered";
        return { x, y }; })()`).catch(() => "pdd_page_script_failed");
      const win = this.window;
      if (typeof located === "string" || !win || win.isDestroyed()) {
        this.outgoing = null;
        await this.clearInput(text);
        return notSent(typeof located === "string" ? located : "platform_window_closed");
      }
      const click = await dispatchPageClick(win.webContents, located, () => {
        if (this.window !== page || this.watchEpoch !== epoch) return "pdd_page_changed";
        return request.recheck?.() ?? (left() < 1.5 ? "claim_expiring" : null);
      });
      if (click.status !== "dispatched") {
        if (click.status === "not_sent") await this.clearInput(text);
        return click;
      }
      // 第二阶段：已点发送；此后除平台确认外一律不确定。
      const r = await Promise.race([result, sleep(Math.max(500, Math.min(8000, left() * 1000))).then(() => null)]);
      const out = this.outgoing as { matched: string | null; blocked: number } | null;
      this.outgoing = null;
      if (r) return r;
      if (!out?.matched) await this.clearInput(text);
      if (out && !out.matched && out.blocked > 0) return { status: "unknown", reason: "pdd_send_blocked_mismatch" };
      return { status: "unknown", reason: out?.matched ? "send_timeout" : "pdd_send_request_not_observed" };
    } finally {
      this.outgoing = null;
      this.sending = false;
    }
  }

  /** 点开该买家对话并等它成为当前对话；返回失败原因，成功为 null。 */
  private async openConversation(uid: string): Promise<string | null> {
    if (!(await this.clickConversation(uid).catch(() => false))) return "pdd_conversation_not_in_list";
    for (let i = 0; i < 25; i++) {
      const scan = await this.run<Scan>(SCAN).catch(() => null);
      if (scan?.items.some((it) => it.active && buyerFromListKey(it.key) === uid)) return null;
      await sleep(200);
    }
    return "pdd_conversation_not_opened";
  }

  private nativeClick(pt: { x: number; y: number }, win: PlatformPage | null, epoch: number): Promise<PageClickResult> {
    if (!win || win.isDestroyed()) return Promise.resolve({ status: "not_sent", reason: "platform_window_closed" });
    return dispatchPageClick(win.webContents, pt, () => this.window !== win || this.watchEpoch !== epoch ? "pdd_page_changed" : null);
  }

  /** 展开视频弹窗（点页面的相机图标），等页面列出视频。返回 "opened" | "already" | 失败原因。 */
  private async openVideoPanel(): Promise<string> {
    const page = this.window, epoch = this.watchEpoch;
    const state = await this.run<string | { x: number; y: number }>(VIDEO_PANEL).catch(() => "pdd_page_script_failed");
    if (state === "open") return "already";
    if (typeof state === "string") return state;
    const click = await this.nativeClick(state, page, epoch);
    if (click.status !== "dispatched") return click.reason;
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      if ((await this.run<unknown>(VIDEO_PANEL).catch(() => null)) === "open") return "opened";
    }
    await this.closeVideoPanel();
    return "pdd_video_panel_not_opened";
  }

  /** 弹窗仍展开时再点一次相机图标收起。 */
  private async closeVideoPanel() {
    const page = this.window, epoch = this.watchEpoch;
    const state = await this.run<string | { x: number; y: number }>(`(() => {
      const rows = [...document.querySelectorAll(${JSON.stringify(VIDEO_ROWS)})].filter((li) => li.getClientRects().length > 0);
      const cam = document.querySelector(${JSON.stringify(CAMERA)});
      if (!rows.length || !cam) return "closed";
      const r = cam.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`).catch(() => "closed");
    if (typeof state !== "string") await this.nativeClick(state, page, epoch);
  }

  /**
   * 自动模式且附加发送能力已确认时，每个平台会话展开一次视频弹窗让页面加载视频库，随即收起。
   * 只在已打开某个对话时进行（相机图标在对话输入区）；不发送任何内容。
   */
  async prepareSendOptions(): Promise<void> {
    do await this.popupIdle(); while (this.popupSweep);
    if (this.optionsPrepared || this.sending || this.outgoing || !this.window || this.window.isDestroyed()) return;
    if (!this.tracker.status(true).logged_in) return;
    this.sending = true;
    try {
      const result = await this.openVideoPanel();
      if (result === "opened" || result === "already") this.optionsPrepared = true;
      if (result === "opened") {
        await sleep(800);
        await this.closeVideoPanel();
      }
      console.log(`[${this.shopId}] platform send options prepare result=${result}`);
    } finally {
      this.sending = false;
    }
  }

  /**
   * 附加发送（视频、商品卡片）：打开对话 → 展开视频弹窗 / 切到“商品推荐”页签 → 核对所选页面行的对象身份 → 点击前复核 → 原生点击页面的按钮。
   * 页面发出的发送请求在本机核对买家与对象；以平台接口成功且相对基线恰好新增一条同对象消息为确认。
   */
  async sendItem(request: SendItemRequest): Promise<SendResult> {
    const notSent = (reason: string): SendResult => ({ status: "not_sent", reason });
    // 占用页面：等清理与预热结束后，在 await 返回的同一同步段里复核并置 sending（见 popupSweep 说明）。
    do await this.yieldWarm(); while (this.popupSweep || this.warmRun);
    if (!this.window || this.window.isDestroyed()) return notSent("platform_window_closed");
    if (!this.tracker.status(true).logged_in) return notSent("platform_logged_out");
    if (this.sending || this.outgoing) return notSent("pdd_send_busy");
    if (!/^[0-9]{1,32}$/.test(request.conversation_id)) return notSent("pdd_send_invalid_request");
    if (!SENDABLE_ITEMS.has(request.option.type)) return notSent("pdd_item_type_unsupported");
    const uid = request.conversation_id;
    const option = request.option;
    const page = this.window, epoch = this.watchEpoch;
    this.sending = true;
    const watch: NonNullable<PddPageAdapter["itemWatch"]> = { buyer: uid, path: option.type === "instruction" ? INSTRUCT_SEND_PATH : option.type === "goods_card" ? GOODS_CARD_SEND_PATH : LIBRARY_SEND_PATH, url: null, goodsId: null, bookId: null, seen: [], clicked: false, requests: 0, blocked: 0, apiOk: null };
    this.itemWatch = watch;
    let opened = false;
    let dialog = false;
    try {
      // 第一阶段：打开对话与弹窗、定位按钮、复核。失败均未触碰发送按钮。
      const notOpened = await this.openConversation(uid);
      if (notOpened) return notSent(notOpened);
      let located: { x: number; y: number };
      if (option.type === "instruction") {
        dialog = true;
        const ins = await this.locateInstruction(uid, option, watch, request.deadline * 1000);
        if (typeof ins === "string") return notSent(ins);
        located = ins;
      } else if (option.type === "goods_card") {
        const goods = await this.locateGoods(uid, option, watch);
        if (typeof goods === "string") return notSent(goods);
        located = goods;
      } else {
      const before = this.videoRows;
      const panel = await this.openVideoPanel();
      if (panel !== "opened" && panel !== "already") return notSent(panel);
      opened = panel === "opened";
      for (let i = 0; opened && this.videoRows === before && i < 10; i++) await sleep(150);
      await sleep(300);
      // 以文件编号定位，点击前核对所选页面行的文件身份；请求放行时再核对文件地址。
      const rows = this.videoRows;
      const plan = planVideoClick(rows, option);
      if (typeof plan === "string" || !rows) return notSent(typeof plan === "string" ? plan : "pdd_video_library_not_loaded");
      const dom = await this.run<string | { texts: string[]; srcs: string[][]; x: number; y: number }>(videoRowsScript(uid, plan.index)).catch(() => "pdd_page_script_failed");
      if (typeof dom === "string") return notSent(dom);
      const target = verifyVideoTarget(rows, plan.index, dom);
      if (typeof target === "string") return notSent(target);
      console.log(`[${this.shopId}] platform video target identity=${target.basis}`);
      if (this.videoRows !== rows) return notSent("pdd_video_list_changed");
      watch.url = plan.url;
      located = { x: dom.x, y: dom.y };
      }
      const blocked = request.recheck();
      if (blocked) return notSent(blocked);
      if (request.deadline - Date.now() / 1000 < 1.5) return notSent("claim_expiring");
      if (watch.blocked) return notSent("pdd_item_concurrent_send");
      const baseline = new Set([...this.tracker.history(uid).messages.flatMap((m) => (m.platform_message_id ? [m.platform_message_id] : [])), ...watch.seen.map((m) => m.msg_id)]);
      const click = await dispatchPageClick(page.webContents, located, () => {
        if (this.window !== page || this.watchEpoch !== epoch) return "pdd_page_changed";
        return request.recheck() ?? (request.deadline - Date.now() / 1000 < 1.5 ? "claim_expiring" : watch.blocked ? "pdd_item_concurrent_send" : null);
      }, () => { watch.clicked = true; });
      if (click.status !== "dispatched") return click;
      // 第二阶段：已点发送；此后除平台确认外一律不确定。
      // 页面发送后的同步消息不带新消息（实测为空），接口成功后仍无回执就刷新一次页面，让页面重新加载该对话的聊天记录。
      let okAt = 0;
      let reloaded = false;
      while (Date.now() / 1000 < request.deadline) {
        if (watch.blocked) return { status: "unknown", reason: "pdd_item_blocked_mismatch" };
        const r = judgeItemReceipt({ apiOk: watch.apiOk, option, buyer: uid, baseline, seen: watch.seen });
        if (r) return r;
        if (watch.apiOk === true) okAt ||= Date.now();
        if (okAt && !reloaded && Date.now() - okAt > 1000) {
          reloaded = true;
          opened = false;
          this.reload("send_item_receipt", true);
        }
        await sleep(200);
      }
      if (!watch.requests) return { status: "unknown", reason: "pdd_item_request_not_observed" };
      return { status: "unknown", reason: watch.apiOk === true ? "receipt_not_observed" : "send_timeout" };
    } finally {
      this.itemWatch = null;
      if (dialog) void this.run(INSTRUCT_CLOSE).catch(() => undefined).finally(() => (this.sending = false));
      else if (opened) void this.closeVideoPanel().finally(() => (this.sending = false));
      else this.sending = false;
    }
  }

  /** 切到“商品推荐”页签，以缩略图核对所选行就是候选商品，返回其“发送商品”按钮中心点或原因。 */
  private async locateGoods(uid: string, option: SendItemRequest["option"], watch: NonNullable<PddPageAdapter["itemWatch"]>): Promise<{ x: number; y: number } | string> {
    const since = Date.now();
    const tab = await this.run<string>(goodsTabScript(uid)).catch(() => "pdd_page_script_failed");
    if (tab !== "clicked" && tab !== "already") return tab.startsWith("pdd_") ? tab : `pdd_goods_tab_${tab}`;
    for (let i = 0; tab === "clicked" && (this.goodsRows.get(uid)?.at ?? 0) < since && i < 20; i++) await sleep(150);
    await sleep(300);
    const entry = this.goodsRows.get(uid);
    const plan = planGoodsClick(entry?.rows ?? null, option);
    if (typeof plan === "string" || !entry) return typeof plan === "string" ? plan : "pdd_goods_list_not_loaded";
    const dom = await this.run<string | { srcs: string[][]; hasBtn: boolean[] }>(GOODS_ROWS).catch(() => "pdd_page_script_failed");
    if (typeof dom === "string") return dom;
    const index = verifyGoodsTarget(entry.rows, plan.goods_id, dom);
    if (typeof index === "string") return index;
    const point = await this.run<string | { x: number; y: number }>(goodsButtonScript(uid, index, plan.thumb)).catch(() => "pdd_page_script_failed");
    if (typeof point === "string") return point;
    if (this.goodsRows.get(uid) !== entry) return "pdd_goods_list_changed";
    console.log(`[${this.shopId}] platform goods target identity=thumb`);
    watch.goodsId = plan.goods_id;
    return point;
  }

  /** 点开第 index 个订单“发送说明书”按钮，等页面为此加载说明书并弹出对话框；返回该次加载的请求与响应。 */
  private async openInstructDialog(uid: string, index: number, waitMs: number, aborted: () => boolean = () => false): Promise<{ request: unknown; response: unknown } | string> {
    const since = Date.now();
    const clicked = await this.run<string>(instructOpenScript(uid, index)).catch(() => "pdd_page_script_failed");
    if (clicked !== "clicked") return clicked;
    while ((this.lastInstruct?.at ?? 0) < since && Date.now() - since < waitMs && !aborted()) await sleep(100);
    const got = this.lastInstruct;
    if (!got || got.at < since) return "pdd_instruct_not_loaded";
    await sleep(300);
    return got;
  }

  /**
   * 切到订单页签，逐个点开订单上的“发送说明书”，找到页面所加载的说明书（商品、模板、版本）与候选一致的那个对话框，
   * 核对对话框显示该说明书名称，返回其“发送说明书”按钮中心点；不一致的对话框随即关闭。
   */
  private async locateInstruction(uid: string, option: SendItemRequest["option"], watch: NonNullable<PddPageAdapter["itemWatch"]>, deadline: number): Promise<{ x: number; y: number } | string> {
    // 至少留 2.5 秒给点击与回执；时间不够就在点击前放弃（not_sent），不让外层超时记成不确定。
    const spare = () => deadline - Date.now() - 2500;
    const target = instructTarget(option);
    if (!target || option.type !== "instruction" || !option.name) return "pdd_instruct_option_invalid";
    const tab = await this.run<string>(orderTabsScript(uid)).catch(() => "pdd_page_script_failed");
    if (tab !== "clicked" && tab !== "already") return tab.startsWith("pdd_") ? tab : `pdd_order_tab_${tab}`;
    if (tab === "clicked") await sleep(800);
    const count = await this.run<string | number>(instructButtonsScript(uid)).catch(() => "pdd_page_script_failed");
    if (typeof count === "string") return count;
    for (let i = 0; i < Math.min(count, 5); i++) {
      if (spare() < 500) return "claim_expiring";
      const got = await this.openInstructDialog(uid, i, Math.min(1500, spare()));
      if (typeof got === "string") return got;
      if (!instructMatches(option, got.request, got.response)) {
        await this.run(INSTRUCT_CLOSE).catch(() => undefined);
        await sleep(300);
        continue;
      }
      // 对话框弹出有过渡动画，按钮未就绪（未出现、尺寸为 0、被遮挡）时短暂重试。
      let point: string | { x: number; y: number } = "pdd_instruct_dialog_missing";
      for (let k = 0; k < 10; k++) {
        point = await this.run<string | { x: number; y: number }>(instructDialogScript(uid, option.name)).catch(() => "pdd_page_script_failed");
        if (typeof point !== "string" || !/^pdd_instruct_(dialog_missing|send_button_hidden|send_button_covered)/.test(point) || spare() < 500) break;
        await sleep(150);
      }
      if (typeof point === "string") {
        console.log(`[${this.shopId}] platform instruction dialog not ready reason=${point}`);
        return point.split(":")[0];
      }
      if (this.lastInstruct !== got) return "pdd_instruct_changed";
      console.log(`[${this.shopId}] platform instruction target identity=template`);
      watch.goodsId = target.goodsId;
      watch.bookId = target.bookId;
      return point;
    }
    return count ? "pdd_instruct_not_found" : "pdd_instruct_button_missing";
  }

  /**
   * 提交前让页面加载该买家可发的说明书与推荐商品（自动模式且附加发送能力已确认时由运行时调用），只做界面操作，不发送。
   * timeoutMs 是准备阶段的剩余预算（默认合计 2 秒），本方法同时负责订单的确认，运行时不再另读一次订单：
   * 先切到“商品推荐”页签（每买家 5 分钟一次，最多等 1.2 秒）；再切回订单页签并等订单读完——订单每次重新读取都会使上下文版本变化，
   * 提交时停在订单页签，发送说明书时就不必再切页签；最后，剩余预算足够时才逐个点开订单上的“发送说明书”再关闭
   * （每买家 10 分钟一次、最多 3 个），不够的留给预热（warmConversation）。
   */
  async sendOptionsSettled(conversationId: string, timeoutMs: number): Promise<void> {
    await this.yieldWarm();
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    await this.goodsSettled(conversationId, Math.min(PREP_GOODS_WAIT_MS, Math.max(0, left() - PREP_ORDERS_RESERVE_MS)));
    if (this.sending || this.outgoing) return;
    const since = Date.now();
    const back = await this.run<string>(orderTabsScript(conversationId)).catch(() => "error");
    if (back === "clicked") {
      this.ordersRefreshAt.set(conversationId, since);
      await this.orders.startedSince(conversationId, since, Math.min(1500, left()));
    }
    await this.orders.settled(conversationId, left());
    if (left() >= PREP_INSTRUCT_MIN_MS) await this.instructionsSettled(conversationId, deadline);
    else if (this.instructDue(conversationId)) console.log(`[${this.shopId}] platform instruct collect deferred=warm`);
  }

  /** 该买家订单中有商品的说明书未读到或已过 10 分钟，且距上次收集已满限流间隔。 */
  private instructDue(uid: string): boolean {
    return Date.now() - (this.instructTriedAt.get(uid) ?? 0) >= 600_000 && this.sendOptions.instructStale(uid, Math.floor(Date.now() / 1000), 600).length > 0;
  }

  private async instructionsSettled(uid: string, deadline: number) {
    do await this.popupIdle(); while (this.popupSweep);
    if (this.sending || this.outgoing || !this.instructDue(uid)) return;
    this.sending = true;
    try {
      await this.collectInstructions(uid, deadline, () => false);
    } finally {
      this.sending = false;
    }
  }

  /**
   * 逐个点开订单上的“发送说明书”再关闭，让页面加载说明书；调用方持有页面（sending）。结束时按结果区分：
   * - complete：没有未新鲜的说明书了 → 10 分钟内不再收集；
   * - partial：预算耗尽或被抢占，还有没试的按钮 → 不限流，本轮已读按钮的指纹保留，下次只跳过能对上的；
   * - exhausted：页面上每个按钮都能对上本轮已读的指纹，或本轮已打开 3 次，仍有未新鲜的 → 10 分钟后再来一轮；
   * - failed：一个对话框也没打开就失败（不在订单页签、没有按钮、脚本失败、加载失败）→ 30 秒后再试，本轮进度保留。
   */
  private async collectInstructions(uid: string, deadline: number, aborted: () => boolean) {
    const stale = () => this.sendOptions.instructStale(uid, Math.floor(Date.now() / 1000), 600).length > 0;
    let round = this.instructRound.get(uid);
    if (!round || Date.now() - round.startedAt >= 600_000) this.instructRound.set(uid, (round = { done: new Set(), opens: 0, startedAt: Date.now() }));
    let keys: string | (string | null)[] = "error";
    let opened = 0;
    let outcome: "complete" | "partial" | "exhausted" | "failed" = "failed";
    try {
      keys = await this.run<string | (string | null)[]>(instructButtonKeysScript(uid)).catch(() => "error");
      if (!Array.isArray(keys)) return opened;
      const current = keys;
      // 只按可核验的指纹跳过；本轮打开次数达上限后不再打开。
      const todo = () => (round!.opens >= 3 ? [] : current.flatMap((k, i) => (k !== null && round!.done.has(k) ? [] : [i])));
      const stopped = () => aborted() || deadline - Date.now() <= 500;
      for (const i of todo()) {
        if (!stale() || stopped() || round.opens >= 3) break;
        const got = await this.openInstructDialog(uid, i, Math.min(1500, deadline - Date.now()), aborted);
        await this.run(INSTRUCT_CLOSE).catch(() => undefined);
        await sleep(300);
        if (typeof got === "string") {
          // 等待中被抢占或到预算截止不算失败；真正加载失败才退避。
          outcome = stopped() ? "partial" : "failed";
          return opened;
        }
        round.opens++;
        const key = current[i];
        if (key !== null) round.done.add(key);
        opened++;
      }
      outcome = !stale() ? "complete" : todo().length && stopped() ? "partial" : !todo().length && round.opens ? "exhausted" : "failed";
      return opened;
    } finally {
      if (outcome === "complete" || outcome === "exhausted") {
        this.instructTriedAt.set(uid, Date.now());
        this.instructRound.delete(uid);
      } else if (outcome === "partial") this.instructTriedAt.delete(uid);
      else this.instructTriedAt.set(uid, Date.now() - 570_000);
      console.log(`[${this.shopId}] platform instruct collect buttons=${Array.isArray(keys) ? keys.length : keys} loaded=${opened} outcome=${outcome}`);
    }
  }

  private async goodsSettled(conversationId: string, timeoutMs: number): Promise<void> {
    if (this.sending || this.outgoing || Date.now() - (this.goodsTabAt.get(conversationId) ?? 0) < GOODS_TAB_REFRESH_MS) return;
    await this.collectGoods(conversationId, timeoutMs, () => false);
  }

  private async collectGoods(conversationId: string, timeoutMs: number, aborted: () => boolean): Promise<void> {
    this.goodsTabAt.set(conversationId, Date.now());
    const since = Date.now();
    const result = await this.run<string>(goodsTabScript(conversationId)).catch(() => "error");
    let loaded = false;
    for (let i = 0; result === "clicked" && !loaded && Date.now() - since < timeoutMs && !aborted(); i++) {
      await sleep(100);
      loaded = (this.goodsRows.get(conversationId)?.at ?? 0) >= since;
    }
    console.log(`[${this.shopId}] platform goods tab result=${result}${result === "clicked" ? ` loaded=${loaded}` : ""}`);
  }

  /**
   * 预热：该买家没有进行中的处理时（运行时调用），在后台补齐下一条消息要用的候选——过期的推荐商品、未读到或过期的说明书。
   * 只做界面操作，不发送；没人在用页面（无焦点、输入框为空、无对话框）且该买家对话仍是当前对话时才进行。
   * 持有页面期间发送与准备会先抢占它（在下一步之间停下、关闭对话框），所以不会让发送因“忙”被拒。
   */
  async warmConversation(conversationId: string): Promise<void> {
    if (this.warmRun || this.popupSweep || this.sending || this.outgoing || !this.window || this.window.isDestroyed()) return;
    if (!/^[0-9]{1,32}$/.test(conversationId) || !this.tracker.status(true).logged_in) return;
    const goodsDue = Date.now() - (this.goodsTabAt.get(conversationId) ?? 0) >= GOODS_TAB_REFRESH_MS;
    if (!goodsDue && !this.instructDue(conversationId)) return;
    const ctrl = new AbortController();
    let finish!: () => void;
    const run = { ctrl, done: new Promise<void>((r) => (finish = r)) };
    const page = this.window;
    const aborted = () => ctrl.signal.aborted || this.window !== page || page.isDestroyed();
    this.warmRun = run;
    this.sending = true;
    const started = Date.now();
    let result = "done";
    let instructLoaded = 0;
    try {
      const idle = await this.run<string>(warmIdleScript(conversationId)).catch(() => "error");
      if (idle !== "idle") {
        result = idle;
        return;
      }
      if (goodsDue) {
        await this.collectGoods(conversationId, WARM_GOODS_WAIT_MS, aborted);
        if (aborted()) return void (result = "preempted");
        const since = Date.now();
        const back = await this.run<string>(orderTabsScript(conversationId)).catch(() => "error");
        if (back === "clicked") {
          this.ordersRefreshAt.set(conversationId, since);
          await unlessAborted(this.orders.startedSince(conversationId, since, 1500), ctrl.signal);
        }
        await unlessAborted(this.orders.settled(conversationId, WARM_ORDERS_WAIT_MS), ctrl.signal);
        if (aborted()) return void (result = "preempted");
      }
      if (this.instructDue(conversationId)) instructLoaded = await this.collectInstructions(conversationId, Date.now() + WARM_INSTRUCT_MS, aborted);
      if (aborted()) result = "preempted";
    } finally {
      this.sending = false;
      this.warmRun = null;
      finish();
      console.log(`[${this.shopId}] platform warm result=${result} goods=${goodsDue} instruct_loaded=${instructLoaded} ms=${Date.now() - started}`);
    }
  }

  /** 发送未被确认时清掉自动填入的文字，避免人工误点发送。 */
  /**
   * 开发自检：验证原生点击能触发页面发送，但请求在本机即被拦截、不到达平台。
   * 设置一个不可能匹配的待发记录，使页面发出的 send_message 必然被 onSendPaused 拦截。
   * 仅在当前已打开的对话上进行，且需调用方确认该对话允许自检。
   */
  async clickProbe(allow: (uid: string) => boolean): Promise<string> {
    if (!this.window || this.window.isDestroyed() || !this.tracker.status(true).logged_in) return "not_ready";
    if (this.sending || this.outgoing || this.popupSweep) return "busy";
    const text = "测试点击（不会发出）";
    const page = this.window, epoch = this.watchEpoch;
    this.sending = true;
    try {
      const scan = await this.run<Scan>(SCAN).catch(() => null);
      const active = scan?.items.find((i) => i.active);
      const uid = active ? buyerFromListKey(active.key) : null;
      if (!uid || !allow(uid)) return "conversation_not_allowed";
      const filled = await this.run<string>(`(() => {
        const ta = document.querySelector(${JSON.stringify(TEXTAREA)});
        if (!ta) return "input_missing";
        if (ta.value.trim()) return "input_not_empty";
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return "filled"; })()`).catch(() => "script_failed");
      if (filled !== "filled") return filled;
      await sleep(300);
      let blocked = 0;
      this.outgoing = { to_uid: "probe-never-matches", text: "", matched: null, blocked: 0, resolve: () => undefined };
      const located = await this.run<string | { x: number; y: number }>(`(() => {
        const btn = document.querySelector(${JSON.stringify(SEND_BTN)});
        if (!btn) return "button_missing";
        const r = btn.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
        if (document.elementFromPoint(x, y)?.closest(${JSON.stringify(SEND_BTN)}) !== btn) return "button_covered";
        return { x, y }; })()`).catch(() => "script_failed");
      if (typeof located === "string") {
        this.outgoing = null;
        await this.clearInput(text);
        return located;
      }
      const click = await this.nativeClick(located, page, epoch);
      if (click.status !== "dispatched") return click.reason;
      for (let i = 0; i < 25 && !blocked; i++) {
        await sleep(200);
        blocked = this.outgoing?.blocked ?? 0;
      }
      // 拦截后页面可能把失败消息留在列表或输入框里；输入框残留时清掉。
      await sleep(1000);
      this.outgoing = null;
      await this.clearInput(text);
      return blocked ? "intercepted" : "no_send_request";
    } finally {
      this.outgoing = null;
      this.sending = false;
    }
  }

  /**
   * 诊断模式下的人工触发测试：在当前已打开的对话上把“收藏该用户”设为指定颜色（只点颜色项，不点星标本身，避免误取消）。
   * 点击前写本地尝试记录；结果只以页面状态判定（星标 active 且该颜色带勾），无平台回执；不重试。
   */
  async starTest(color: StarColor): Promise<string> {
    if (!this.probeFile) return "not_executed:probe_mode_required";
    if (!this.window || this.window.isDestroyed() || !this.tracker.status(true).logged_in) return "not_executed:not_ready";
    if (this.sending || this.outgoing || this.popupSweep) return "not_executed:busy";
    const page = this.window, epoch = this.watchEpoch;
    const log = (rec: Record<string, unknown>) => fs.appendFileSync(path.join(path.dirname(this.probeFile!), "star-test.jsonl"), JSON.stringify({ at: new Date().toISOString(), color, ...rec }) + "\n", { mode: 0o600 });
    const activeUid = async () => {
      const scan = await this.run<Scan>(SCAN).catch(() => null);
      const active = scan?.items.find((i) => i.active);
      return active ? buyerFromListKey(active.key) : null;
    };
    const hover = (pt: { x: number; y: number }) => page.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y }).catch(() => undefined);
    const read = async (): Promise<StarState | string> => {
      const star = await this.run<{ x: number; y: number; active: boolean } | string>(STAR_ICON).catch(() => "script_failed");
      if (typeof star === "string") return star;
      await hover(star);
      await sleep(500);
      const options = await this.run<StarOption[] | string>(starOptionsScript(star)).catch(() => "script_failed");
      if (typeof options === "string") return options;
      return { star, options };
    };
    this.sending = true;
    try {
      const uid = await activeUid();
      if (!uid) return "not_executed:no_active_conversation";
      const before = await read();
      if (typeof before === "string") return `not_executed:${before}`;
      const target = before.options.find((o) => o.color === color);
      if (!target) return `not_executed:color_missing(${before.options.map((o) => o.color).join(",")})`;
      if (before.star.active && target.checked) return "already";
      if ((await activeUid()) !== uid || this.watchEpoch !== epoch) return "not_executed:conversation_changed";
      log({ phase: "attempt", before: { active: before.star.active, checked: before.options.find((o) => o.checked)?.color ?? null } });
      const click = await this.nativeClick({ x: target.x, y: target.y }, page, epoch);
      if (click.status !== "dispatched") {
        log({ phase: click.status, reason: click.reason });
        return `${click.status}:${click.reason}`;
      }
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        if ((await activeUid()) !== uid) break;
        const after = await read();
        if (typeof after !== "string" && after.star.active && after.options.find((o) => o.color === color)?.checked) {
          log({ phase: "confirmed" });
          return "confirmed";
        }
      }
      log({ phase: "unknown", reason: "page_state_not_confirmed" });
      return "unknown:page_state_not_confirmed";
    } finally {
      await hover({ x: 1, y: 1 });
      this.sending = false;
    }
  }

  private async clearInput(text: string) {
    await this.run(`(() => {
      const ta = document.querySelector(${JSON.stringify(TEXTAREA)});
      if (!ta || ta.value !== ${JSON.stringify(text)}) return;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, "");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    })()`).catch(() => undefined);
  }

  onEvent(listener: (e: AdapterEvent) => void) {
    this.listeners.push(listener);
  }

  private emit(e: AdapterEvent) {
    if (e.type === "session_started") this.health.sessionStarted();
    if (e.type === "session_ended" && e.reason === "platform_logged_out") this.health.sessionEnded(false);
    if (e.type === "session_started" || e.type === "session_ended") {
      this.optionsPrepared = false;
      this.videoRows = null;
      this.goodsRows.clear();
      this.goodsTabAt.clear();
      this.instructTriedAt.clear();
      this.instructRound.clear();
      this.lastInstruct = null;
      this.orders.reset();
      this.sendOptions.reset();
    }
    for (const l of this.listeners) l(e);
  }

  dispose() {
    this.messageWatcher?.close();
    this.listeners.length = 0;
    if (this.window && !this.window.isDestroyed()) this.window.close();
  }
}

function isLoginPage(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.hostname === "mms.pinduoduo.com" && /^\/login/.test(url.pathname);
  } catch {
    return false;
  }
}
