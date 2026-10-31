import type { MarkColor } from "./protocol.js";

/**
 * 契约“标星执行与成功判据”的纯判定部分（拼多多）。只在内存里比较；
 * 本地日志与回执只记结论与原因分类，不记买家编号、request_id 或响应原文。
 */

/** 颜色与平台 mark_conversation 请求 color 数值（店主在场逐个点选并确认，2026-10-31）。0 与大于 4 未观察，不用。 */
export const MARK_COLOR_VALUE: Readonly<Record<MarkColor, number>> = { orange: 1, red: 2, green: 3, blue: 4 };

/**
 * 一次标星的点击窗口。open：点击前一刻打开；closed：确认截止（或结束）后关闭。
 * 窗口外（未打开或已关闭）页面请求一律放行，不受影响。
 */
export type MarkWatch = {
  buyer: string;
  color: number;
  epoch: number;
  open: boolean;
  closed: boolean;
  /** 窗口内放行的唯一一条请求：浏览器请求编号（CDP Network requestId）与请求体 data.request_id。 */
  allowed: { networkId: string; requestId: number } | null;
  blocked: number;
  /** 放行请求自己的响应结论：ok 满足成功判据；bad 不满足；failed 加载失败。先到的结论为准。 */
  outcome: "ok" | "bad" | "failed" | null;
};

export function newMarkWatch(buyer: string, color: number, epoch: number): MarkWatch {
  return { buyer, color, epoch, open: false, closed: false, allowed: null, blocked: 0, outcome: null };
}

const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parse(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export type MarkRequestVerdict = { allow: true; networkId: string; requestId: number } | { allow: false };

/**
 * 窗口内页面发出的标星 / 取消收藏请求的放行判定（契约“请求核对”）。只放行窗口内第一条 mark 请求，且：
 * 页面代次与点击时相同；data.uid 与本事件买家字符串严格相等；data.color 与决定颜色的数值严格相等；
 * data.request_id 为有限数字；浏览器请求编号可用（否则无法按编号取它自己的响应）。其余一律拦截，包括任何 unmark。
 */
export function markRequestVerdict(w: MarkWatch, kind: "mark" | "unmark", epoch: number, networkId: unknown, postData: unknown): MarkRequestVerdict {
  if (kind !== "mark" || w.allowed || epoch !== w.epoch || typeof networkId !== "string" || !networkId) return { allow: false };
  const body = parse(postData);
  const data = plain(body) && plain(body.data) ? body.data : null;
  if (!data || typeof data.uid !== "string" || data.uid !== w.buyer) return { allow: false };
  if (typeof data.color !== "number" || data.color !== w.color) return { allow: false };
  if (!finite(data.request_id)) return { allow: false };
  return { allow: true, networkId, requestId: data.request_id };
}

/**
 * 成功判据第 3 条：响应是 JSON 对象；外层 success === true；result 是对象且 result.success === true；
 * result.result === "ok"；result.request_id 为有限数字且与放行请求的 data.request_id 严格相等。
 */
export function markResponseOk(requestId: number, body: string | null): boolean {
  const top = parse(body);
  if (!plain(top) || top.success !== true) return false;
  const result = top.result;
  if (!plain(result) || result.success !== true || result.result !== "ok") return false;
  return finite(result.request_id) && result.request_id === requestId;
}

/** 窗口关闭时的结论：只有放行的那条请求按自己的编号取到满足判据的响应才成功；其余都是 unknown 并给出原因分类。 */
export function judgeMark(w: MarkWatch): { ok: true } | { ok: false; reason: string } {
  if (w.allowed && w.outcome === "ok") return { ok: true };
  if (!w.allowed) return { ok: false, reason: w.blocked ? "mark_request_blocked" : "mark_request_not_observed" };
  if (w.outcome === "bad") return { ok: false, reason: "mark_response_not_ok" };
  if (w.outcome === "failed") return { ok: false, reason: "mark_request_failed" };
  return { ok: false, reason: "mark_response_timeout" };
}
