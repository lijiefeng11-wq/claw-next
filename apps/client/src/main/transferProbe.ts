/**
 * 诊断模式（CLAW_NEXT_PDD_PROBE=1）专用：为转人工（转移会话）取证（#18 / 契约 1.3“接收人”与转移成功判据）。
 * 核实两件事：
 *  1. 转移请求里的接收人编号 csid，与客服列表接口里哪个字段对应，以及该客服的“账号名”出现在哪个字段；
 *  2. 转移接口响应在成功与失败（如“已收藏不可转移”）时各字段的取值形态。
 * 输出只含布尔、计数和封闭候选集内的值；不输出客服/买家编号、账号名、昵称、错误原文或任何请求/响应原文。
 * 客服列表只在内存里用于比较，不写盘。本模块不参与任何收发或转移判定。
 * 客服列表接口的路径与结构都未核实：按前缀匹配、按字段名在整棵 JSON 里找到的对象一律只是“候选”，
 * 输出字段以 candidate 命名，只作取证观察，不能据此认定已核实的客服列表或接收人对应。
 * 父级键、其他字段与 tokens 只在内存中用于比较，不写盘、不输出。
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

/** 客服列表候选里的一项：编号与名称字段用于比较；parentKey、others 只在内存里用于比较，永不输出。 */
export type AssignEntry = {
  id: unknown;
  csid: unknown;
  username: unknown;
  nickname: unknown;
  /** 候选作为普通对象属性值时所在的键；在数组里或在根上为 null。 */
  parentKey: string | null;
  /** 候选自身的其他字段：键不在 ID_KEYS / NAME_KEYS 里、值为非空字符串或有限数字；每项最多 40 条。 */
  others: Array<{ key: string; value: string }>;
};
/** complete=false：层数、节点或项数预算耗尽，列表可能不全，不能据此判断“唯一”或“不存在”。 */
export type AssignCandidates = { entries: AssignEntry[]; complete: boolean };

const ASSIGN_MAX_DEPTH = 8;
const ASSIGN_MAX_NODES = 5000;
const ASSIGN_MAX_ENTRIES = 500;
/** 每个候选最多保留的其他字段数；超出即把整体记为不完整（与其它预算耗尽一致）。 */
const ASSIGN_MAX_OTHERS = 40;
/** tokens 里键与值各自的条目上限。 */
const TOKENS_MAX = 5000;
/** 只收集长度不超过该值的字符串值。 */
const TOKEN_VALUE_MAX_LEN = 200;

const ID_KEYS = ["id", "csid", "cs_id", "csId"];
const NAME_KEYS = ["username", "user_name", "userName", "nickname", "nick_name", "nickName"];

/** 候选自身直接字段里的其他字段：只收非空字符串与有限数字（数字转字符串）；只在内存里比较，不输出。 */
function otherFieldsOf(v: Record<string, unknown>): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const [k, x] of Object.entries(v)) {
    if (ID_KEYS.includes(k) || NAME_KEYS.includes(k)) continue;
    if (typeof x === "string") {
      if (x !== "") out.push({ key: k, value: x });
    } else if (typeof x === "number" && Number.isFinite(x)) {
      out.push({ key: k, value: String(x) });
    }
  }
  return out;
}

/**
 * 从客服列表响应里找出候选对象：同时带编号字段（id/csid）与名称字段（username/nickname）。
 * 结构未核实，所以按字段名在整棵 JSON 里找；任一预算耗尽即记为不完整（不静默返回部分结果当作全部）。
 * 同时记下候选所在的父级键（在数组里为 null）与自身的其他字段（只在内存里比较，永不输出）。
 */
export function extractAssignEntries(text: string | null): AssignCandidates | null {
  const body = parse(text);
  if (body === undefined) return null;
  const out: AssignEntry[] = [];
  let nodes = 0;
  let complete = true;
  const walk = (v: unknown, depth: number, key: string | null) => {
    if (!complete) return;
    if (v === null || typeof v !== "object") return;
    if (depth > ASSIGN_MAX_DEPTH || ++nodes > ASSIGN_MAX_NODES) {
      complete = false;
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1, null);
      return;
    }
    if (!plain(v)) return;
    if (ID_KEYS.some((k) => k in v) && NAME_KEYS.some((k) => k in v)) {
      if (out.length >= ASSIGN_MAX_ENTRIES) {
        complete = false;
        return;
      }
      const all = otherFieldsOf(v);
      out.push({
        id: v.id,
        csid: v.csid ?? v.cs_id ?? v.csId,
        username: v.username ?? v.user_name ?? v.userName,
        nickname: v.nickname ?? v.nick_name ?? v.nickName,
        parentKey: key,
        others: all.slice(0, ASSIGN_MAX_OTHERS),
      });
      if (all.length > ASSIGN_MAX_OTHERS) {
        complete = false;
        return;
      }
    }
    for (const [k, x] of Object.entries(v)) walk(x, depth + 1, k);
  };
  walk(body, 0, null);
  return { entries: out, complete };
}

/** 客服列表响应里所有存在的键与字符串/数字值（只在内存里比较 csid 是否出现，不输出）。 */
export type AssignTokens = { keys: Set<string>; values: Set<string>; complete: boolean };

/**
 * 收集整棵客服列表 JSON 里的键与非空字符串值（长度 ≤ 200）/有限数字值（转字符串）。
 * 层数、节点、条目预算耗尽即 complete=false 并停止收集；解析失败返回 null。
 */
export function assignTokens(text: string | null): AssignTokens | null {
  const body = parse(text);
  if (body === undefined) return null;
  const keys = new Set<string>();
  const values = new Set<string>();
  let nodes = 0;
  let complete = true;
  const addKey = (k: string) => {
    if (k === "" || keys.has(k)) return;
    if (keys.size >= TOKENS_MAX) {
      complete = false;
      return;
    }
    keys.add(k);
  };
  const addValue = (v: string) => {
    if (v === "" || values.has(v)) return;
    // 超长值不收集：明确记为不完整，避免把“没收集”当成“不存在”。
    if (v.length > TOKEN_VALUE_MAX_LEN) {
      complete = false;
      return;
    }
    if (values.size >= TOKENS_MAX) {
      complete = false;
      return;
    }
    values.add(v);
  };
  const walk = (v: unknown, depth: number) => {
    if (!complete) return;
    if (typeof v === "string") {
      addValue(v);
      return;
    }
    if (typeof v === "number") {
      if (Number.isFinite(v)) addValue(String(v));
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (depth > ASSIGN_MAX_DEPTH || ++nodes > ASSIGN_MAX_NODES) {
      complete = false;
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) {
        if (!complete) return;
        walk(x, depth + 1);
      }
      return;
    }
    if (!plain(v)) return;
    for (const [k, x] of Object.entries(v)) {
      if (!complete) return;
      addKey(k);
      if (!complete) return;
      walk(x, depth + 1);
    }
  };
  walk(body, 0);
  return { keys, values, complete };
}

/** 合并两份 tokens：一方为 null 返回另一方；否则返回并集新对象（不修改入参），并集超限记不完整。 */
export function mergeAssignTokens(a: AssignTokens | null, b: AssignTokens | null): AssignTokens | null {
  if (a === null) return b;
  if (b === null) return a;
  const keys = new Set<string>(a.keys);
  const values = new Set<string>(a.values);
  let complete = a.complete && b.complete;
  for (const k of b.keys) {
    if (keys.has(k)) continue;
    if (keys.size >= TOKENS_MAX) {
      complete = false;
      break;
    }
    keys.add(k);
  }
  for (const v of b.values) {
    if (values.has(v)) continue;
    if (values.size >= TOKENS_MAX) {
      complete = false;
      break;
    }
    values.add(v);
  }
  return { keys, values, complete };
}

/**
 * 多个来源（不同客服列表接口）各自最新的候选合并：任一来源不完整或无法解析（null）则整体不完整；
 * 没有任何可解析的来源返回 null。同名候选出现在多个来源时，“唯一命中”类比较自然给 null（不挑其中一个）。
 */
export function mergeAssignCandidates(sources: readonly (AssignCandidates | null)[]): AssignCandidates | null {
  const parsed = sources.filter((c): c is AssignCandidates => c !== null);
  if (!parsed.length) return null;
  return { entries: parsed.flatMap((c) => c.entries), complete: parsed.length === sources.length && parsed.every((c) => c.complete) };
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
 * 值等于 csid 的“其他字段”有几个不同键名：只输出个数（封闭分类），不输出键名——键名可能是动态的身份标识，
 * 字母格式不能证明它是已核实的静态字段。没比较条件（无 csid / 无列表）为 null；没找到且列表不完整为 null。
 */
function otherFieldNamesOf(assign: AssignCandidates | null, csidStr: string | null): number | null {
  if (assign === null || csidStr === null) return null;
  const names = new Set<string>();
  for (const e of assign.entries) for (const o of e.others) if (o.value === csidStr) names.add(o.key);
  return names.size === 0 && !assign.complete ? null : names.size;
}

/**
 * 页面自己发出的转移请求：目标是否为当前会话；csid 与客服列表候选的对应关系。
 * target 为请求发出时已绑定的本次诊断转移的账号名（对话框第一列原文）；未绑定（店主手动转移、诊断已失效）为 null。
 * “唯一命中”类字段只在列表完整、且恰好命中一项时给出布尔，否则 null。
 * tokens 为客服列表响应里出现过的键/值（可选）：只判 csid 是否作为键或值出现过，不输出任何原文。
 */
export function moveRequestProbe(
  postData: string | null,
  active: string | null,
  target: string | null,
  assign: AssignCandidates | null,
  tokens: AssignTokens | null = null,
): TransferProbeRecord {
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
  const csidStr = typeof csid === "string" && csid !== "" ? csid : null;
  const parentHit = (e: AssignEntry) => csidStr !== null && e.parentKey === csidStr;
  const otherHit = (e: AssignEntry) => csidStr !== null && e.others.some((o) => o.value === csidStr);
  const tokenIn = (pick: (t: AssignTokens) => Set<string>): boolean | null => {
    if (tokens === null || csidStr === null) return null;
    const set = pick(tokens);
    return set.has(csidStr) ? true : tokens.complete ? false : null;
  };
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
    csid_eq_candidate_parent_key_any: any(parentHit),
    csid_eq_candidate_other_field_any: any(otherHit),
    csid_other_field_names: otherFieldNamesOf(assign, csidStr),
    csid_eq_parent_key_of_username_candidate: one(byUser, parentHit),
    csid_eq_parent_key_of_nickname_candidate: one(byNick, parentHit),
    csid_eq_other_field_of_username_candidate: one(byUser, otherHit),
    csid_eq_other_field_of_nickname_candidate: one(byNick, otherHit),
    tokens_known: tokens !== null,
    tokens_complete: tokens === null ? null : tokens.complete,
    csid_in_assign_keys: tokenIn((t) => t.keys),
    csid_in_assign_values: tokenIn((t) => t.values),
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

/**
 * 诊断目标账号名在客服列表候选里的命中统计：username、nickname、其他字段分别计数。
 * 目标或列表缺失时计数为 null；只输出计数与 complete，不含任何原文。
 */
export function assignNameProbe(assign: AssignCandidates | null, target: string | null): TransferProbeRecord {
  if (assign === null) {
    return {
      target_known: target !== null,
      candidate_name_eq_username: null,
      candidate_name_eq_nickname: null,
      candidate_name_eq_other_field: null,
      candidate_names_complete: null,
    };
  }
  if (target === null) {
    return {
      target_known: false,
      candidate_name_eq_username: null,
      candidate_name_eq_nickname: null,
      candidate_name_eq_other_field: null,
      candidate_names_complete: assign.complete,
    };
  }
  const t = target;
  const list = assign.entries;
  return {
    target_known: true,
    candidate_name_eq_username: list.filter((e) => nameIs(e.username, t)).length,
    candidate_name_eq_nickname: list.filter((e) => nameIs(e.nickname, t)).length,
    candidate_name_eq_other_field: list.filter((e) => e.others.some((o) => o.value.trim() === t)).length,
    candidate_names_complete: assign.complete,
  };
}
