/**
 * 诊断模式（CLAW_NEXT_PDD_PROBE=1）专用：核实收藏颜色数值与当前会话的对应关系。
 * 只认两个精确路由及其中已核实的字段位置；输出只含布尔、计数和封闭候选集内的整数，
 * 不输出买家/客服编号、会话键、完整 color_map 或任何请求/响应原文。
 */

export const MARK_REQUEST_PATH = "/plateau/chat/mark_conversation";
export const UNMARK_REQUEST_PATH = "/plateau/chat/unmark_conversation";
export const MARKED_LIST_PATH = "/plateau/chat/marked_lastest_conversations";

/** 颜色数值的封闭候选集：只有其中的整数才原样记录，其余按类型归类。不代表已核实的颜色映射。 */
const COLOR_CANDIDATES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

export type ColorValue = number | "out_of_set" | "not_integer" | "str" | "bool" | "null" | "obj" | "missing";

export function colorValue(v: unknown): ColorValue {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (typeof v === "number") {
    if (!Number.isInteger(v)) return "not_integer";
    return COLOR_CANDIDATES.has(v) ? v : "out_of_set";
  }
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  return "obj";
}

const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parse(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isActive = (uid: unknown, active: string | null) => active !== null && typeof uid === "string" && uid === active;

export type MarkProbeRecord = Record<string, boolean | number | string | null>;

/** 页面自己发出的标星/取消收藏请求：只记目标是否为当前会话、颜色数值分类。 */
export function markRequestProbe(path: string, postData: string | null, active: string | null): MarkProbeRecord | null {
  if (path !== MARK_REQUEST_PATH && path !== UNMARK_REQUEST_PATH) return null;
  const body = parse(postData);
  const data = plain(body) && plain(body.data) ? body.data : null;
  const rec: MarkProbeRecord = {
    kind: path === MARK_REQUEST_PATH ? "mark_request" : "unmark_request",
    parsed: data !== null,
    active_known: active !== null,
    target_is_active: data !== null && isActive(data.uid, active),
  };
  if (path === MARK_REQUEST_PATH) rec.color = data === null ? "missing" : colorValue(data.color);
  return rec;
}

/** 收藏列表响应：只看 result.color_map 与 result.marked_conversations[].from/to.uid 是否与当前会话相等。 */
export function markedListProbe(path: string, text: string | null, active: string | null, activeAtRequest: string | null): MarkProbeRecord | null {
  if (path !== MARKED_LIST_PATH) return null;
  const body = parse(text);
  const result = plain(body) && plain(body.result) ? body.result : null;
  const map = result && plain(result.color_map) ? result.color_map : null;
  const list = result && Array.isArray(result.marked_conversations) ? result.marked_conversations : null;
  const sideMatches = (side: "from" | "to") =>
    list ? list.filter((c) => plain(c) && plain(c[side]) && isActive((c[side] as Record<string, unknown>).uid, active)).length : 0;
  const inMap = map !== null && active !== null && Object.prototype.hasOwnProperty.call(map, active);
  return {
    kind: "marked_list",
    parsed: result !== null,
    active_known: active !== null,
    active_same_as_request: active !== null && active === activeAtRequest,
    map_present: map !== null,
    map_entries: map ? Object.keys(map).length : 0,
    active_in_map: inMap,
    active_value: inMap ? colorValue((map as Record<string, unknown>)[active as string]) : "missing",
    list_present: list !== null,
    list_count: list ? list.length : 0,
    from_uid_active: sideMatches("from"),
    to_uid_active: sideMatches("to"),
    has_more: result && typeof result.has_more === "boolean" ? result.has_more : null,
  };
}
