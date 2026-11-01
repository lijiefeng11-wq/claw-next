/**
 * 诊断模式（CLAW_NEXT_PDD_PROBE=1）专用：为转人工（转移会话）取证（#18 / 契约 1.3“接收人”与转移成功判据）。
 * 核实两件事：
 *  1. 转移请求里的接收人编号 csid，与客服列表接口里哪个字段对应，以及该客服的“账号名”出现在哪个字段；
 *  2. 转移接口响应在成功与失败（如“已收藏不可转移”）时各字段的取值形态。
 * 输出只含布尔、计数和封闭候选集内的值；不输出客服/买家编号、账号名、昵称、错误原文或任何请求/响应原文。
 * 客服列表只在内存里用于比较，不写盘。本模块不参与任何收发或转移判定。
 * 客服列表接口的路径与结构都未核实：按前缀匹配、按字段名在整棵 JSON 里找到的对象一律只是“候选”，
 * 输出字段以 candidate 命名，只作取证观察，不能据此认定已核实的客服列表或接收人对应。
 */

export const MOVE_PATH = "/plateau/chat/move_conversation";
export const CLOSE_PATH = "/plateau/chat/close_conversation";
/** 客服列表接口：交接记录只知道前缀 /latitude/assign，具体子路径未核实，按前缀匹配。 */
export const ASSIGN_PREFIX = "/latitude/assign";

export type TransferProbePath = "move" | "close" | "assign";

/** 只看精确路径（不看查询参数）：转移、关闭会话、客服列表。 */
export function transferProbePath(raw: unknown): TransferProbePath | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.hostname !== "mms.pinduoduo.com") return null;
    if (url.pathname === MOVE_PATH) return "move";
    if (url.pathname === CLOSE_PATH) return "close";
    if (url.pathname === ASSIGN_PREFIX || url.pathname.startsWith(ASSIGN_PREFIX + "/")) return "assign";
    return null;
  } catch {
    return null;
  }
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

/** 客服列表候选里的一项：只保留比较需要的四个字段（内存中，不写盘）。 */
export type AssignEntry = { id: unknown; csid: unknown; username: unknown; nickname: unknown };
/** complete=false：层数、节点或项数预算耗尽，列表可能不全，不能据此判断“唯一”或“不存在”。 */
export type AssignCandidates = { entries: AssignEntry[]; complete: boolean };

const ASSIGN_MAX_DEPTH = 8;
const ASSIGN_MAX_NODES = 5000;
const ASSIGN_MAX_ENTRIES = 500;

const ID_KEYS = ["id", "csid", "cs_id", "csId"];
const NAME_KEYS = ["username", "user_name", "userName", "nickname", "nick_name", "nickName"];

/**
 * 从客服列表响应里找出候选对象：同时带编号字段（id/csid）与名称字段（username/nickname）。
 * 结构未核实，所以按字段名在整棵 JSON 里找；任一预算耗尽即记为不完整（不静默返回部分结果当作全部）。
 */
export function extractAssignEntries(text: string | null): AssignCandidates | null {
  const body = parse(text);
  if (body === undefined) return null;
  const out: AssignEntry[] = [];
  let nodes = 0;
  let complete = true;
  const walk = (v: unknown, depth: number) => {
    if (!complete) return;
    if (v === null || typeof v !== "object") return;
    if (depth > ASSIGN_MAX_DEPTH || ++nodes > ASSIGN_MAX_NODES) {
      complete = false;
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (!plain(v)) return;
    if (ID_KEYS.some((k) => k in v) && NAME_KEYS.some((k) => k in v)) {
      if (out.length >= ASSIGN_MAX_ENTRIES) {
        complete = false;
        return;
      }
      out.push({
        id: v.id,
        csid: v.csid ?? v.cs_id ?? v.csId,
        username: v.username ?? v.user_name ?? v.userName,
        nickname: v.nickname ?? v.nick_name ?? v.nickName,
      });
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(body, 0);
  return { entries: out, complete };
}

export type TransferProbeRecord = Record<string, boolean | number | string | null>;

const kindOf = (v: unknown): string => (v === undefined ? "missing" : v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
/** 严格相等：两边都须是非空字符串或有限数字，且类型相同。 */
const strictEq = (a: unknown, b: unknown) => (typeof a === "string" && a !== "" && a === b) || (typeof a === "number" && Number.isFinite(a) && a === b);
/** 宽松相等：转成字符串后相等（只作对照记录，不作为任何判据）。 */
const looseEq = (a: unknown, b: unknown) =>
  (typeof a === "string" || typeof a === "number") && (typeof b === "string" || typeof b === "number") && String(a) !== "" && String(a) === String(b);

/** 某个字段与目标名称完全相等（首尾去空白后）。 */
const nameIs = (v: unknown, target: string) => typeof v === "string" && v.trim() === target;

/** 找到即 true；没找到时只有列表完整才算 false，否则未知（null）。 */
const anyOrUnknown = (found: boolean, complete: boolean): boolean | null => (found ? true : complete ? false : null);

/**
 * 页面自己发出的转移请求：目标是否为当前会话；csid 与客服列表候选的对应关系。
 * target 为请求发出时已绑定的本次诊断转移的账号名（对话框第一列原文）；未绑定（店主手动转移、诊断已失效）为 null。
 * “唯一命中”类字段只在列表完整、且恰好命中一项时给出布尔，否则 null。
 */
export function moveRequestProbe(postData: string | null, active: string | null, target: string | null, assign: AssignCandidates | null): TransferProbeRecord {
  const body = parse(postData);
  const data = plain(body) && plain(body.data) ? body.data : null;
  const conv = data && plain(data.conversation) ? data.conversation : null;
  const csid = conv?.csid;
  const list = assign?.entries ?? [];
  const complete = assign?.complete === true;
  const byUser = target === null ? [] : list.filter((e) => nameIs(e.username, target));
  const byNick = target === null ? [] : list.filter((e) => nameIs(e.nickname, target));
  const one = (xs: AssignEntry[], f: (e: AssignEntry) => boolean): boolean | null => (complete && xs.length === 1 ? f(xs[0]) : null);
  const any = (f: (e: AssignEntry) => boolean): boolean | null => (assign === null ? null : anyOrUnknown(list.some(f), complete));
  return {
    kind: "move_request",
    parsed: conv !== null,
    active_known: active !== null,
    target_is_active: conv !== null && active !== null && typeof conv.uid === "string" && conv.uid === active,
    csid_kind: kindOf(csid),
    remark_kind: kindOf(conv?.remark),
    remark_empty: typeof conv?.remark === "string" ? conv.remark === "" : null,
    need_wx_kind: kindOf(conv?.need_wx),
    target_known: target !== null,
    candidates_known: assign !== null,
    candidates_complete: assign === null ? null : complete,
    candidates: list.length,
    candidate_name_eq_username: byUser.length,
    candidate_name_eq_nickname: byNick.length,
    csid_eq_candidate_id_any: any((e) => strictEq(csid, e.id)),
    csid_eq_candidate_csid_any: any((e) => strictEq(csid, e.csid)),
    csid_eq_candidate_username_any: any((e) => strictEq(csid, e.username)),
    csid_loose_eq_candidate_id_any: any((e) => looseEq(csid, e.id)),
    csid_eq_id_of_username_candidate: one(byUser, (e) => strictEq(csid, e.id)),
    csid_eq_csid_of_username_candidate: one(byUser, (e) => strictEq(csid, e.csid)),
    csid_loose_eq_id_of_username_candidate: one(byUser, (e) => looseEq(csid, e.id)),
    csid_eq_id_of_nickname_candidate: one(byNick, (e) => strictEq(csid, e.id)),
    csid_loose_eq_id_of_nickname_candidate: one(byNick, (e) => looseEq(csid, e.id)),
  };
}

/** 结果文字的封闭候选集：只有完全相等时原样记录，其余只记“other”与长度。不代表已核实的成功语义。 */
const RESULT_CANDIDATES = new Set(["", "ok", "OK", "success", "SUCCESS", "succeed", "0", "true", "false", "fail", "failed", "error"]);

/** 数字的封闭候选集：只有这几个值原样记录，其余一律 "num_other"（字段语义未核实，不按数值范围放行）。 */
const NUMBER_CANDIDATES = new Set([-1, 0, 1]);
/** 数字字符串的封闭候选集。 */
const NUMERIC_STRING_CANDIDATES = new Set(["-1", "0", "1"]);

function valueOf(v: unknown): string | boolean | number {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return NUMBER_CANDIDATES.has(v) ? v : "num_other";
  if (typeof v === "string") return RESULT_CANDIDATES.has(v) ? v : "other";
  return kindOf(v);
}

/** 错误码：只记封闭候选值，其余只记类型；“已收藏”拒绝靠错误文字是否含“收藏”区分，不靠错误码数值。 */
function codeOf(v: unknown): string | number {
  if (typeof v === "number") return NUMBER_CANDIDATES.has(v) ? v : "num_other";
  if (typeof v === "string") return NUMERIC_STRING_CANDIDATES.has(v) ? `str:${v}` : "str_other";
  return kindOf(v);
}

/**
 * 转移 / 关闭会话的响应：外层 success、result（对象时看其 result / error_code / error_msg）的取值形态。
 * 错误文字只记是否存在、长度、是否含“收藏”（区分已收藏拒绝），不记原文。
 */
export function transferResponseProbe(kind: "move" | "close", text: string | null): TransferProbeRecord {
  const body = parse(text);
  const top = plain(body) ? body : null;
  const inner = top && plain(top.result) ? top.result : null;
  const msg = inner?.error_msg ?? inner?.errorMsg ?? top?.error_msg ?? top?.errorMsg;
  return {
    kind: `${kind}_response`,
    parsed: top !== null,
    top_success: top ? valueOf(top.success) : "missing",
    top_error_code: top ? codeOf(top.error_code ?? top.errorCode) : "missing",
    result_kind: top ? kindOf(top.result) : "missing",
    result_value: inner ? "object" : top ? valueOf(top.result) : "missing",
    inner_result: inner ? valueOf(inner.result) : "missing",
    inner_success: inner ? valueOf(inner.success) : "missing",
    inner_error_code: inner ? codeOf(inner.error_code ?? inner.errorCode) : "missing",
    error_msg_present: typeof msg === "string" && msg !== "",
    error_msg_len: typeof msg === "string" ? msg.length : null,
    error_msg_mentions_favorite: typeof msg === "string" ? msg.includes("收藏") : null,
  };
}

/** 关闭会话请求：只看目标是否为当前会话。 */
export function closeRequestProbe(postData: string | null, active: string | null): TransferProbeRecord {
  const body = parse(postData);
  const data = plain(body) && plain(body.data) ? body.data : null;
  const uid = data?.uid ?? (data && plain(data.conversation) ? data.conversation.uid : undefined);
  return {
    kind: "close_request",
    parsed: data !== null,
    active_known: active !== null,
    target_is_active: active !== null && typeof uid === "string" && uid === active,
  };
}

/**
 * 请求与诊断转移的关联：请求发出时冻结页面代次与诊断批次序号（diag=null 表示当时没有进行中的诊断转移）。
 * 记录时（异步读取前后各一次）当前页面代次与诊断批次都未变才算 bound；变了记 stale；从未绑定记 unbound。
 * stale / unbound 时不关联诊断目标（账号名）与尝试时间。
 */
export type TransferBinding = "bound" | "stale" | "unbound";

export function bindingOf(frozen: { epoch: number; diag: number | null }, now: { epoch: number; diag: number | null }): TransferBinding {
  if (frozen.diag === null) return "unbound";
  return frozen.epoch === now.epoch && frozen.diag === now.diag ? "bound" : "stale";
}

/** 读前读后两次核对合并：两次都 bound 才是 bound。 */
export function combineBinding(before: TransferBinding, after: TransferBinding): TransferBinding {
  if (before === "unbound" || after === "unbound") return "unbound";
  return before === "bound" && after === "bound" ? "bound" : "stale";
}
