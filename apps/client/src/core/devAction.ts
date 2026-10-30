/**
 * 诊断模式人工测试请求（diag/<店铺>/action.request）的校验。
 * 请求须带一次性 id、有效期和用户确认时取得的对话令牌；过期、重复、格式不符一律不执行。
 * 转移请求的 allow_unfavorite 默认 false：遇“已收藏不可转移”时不取消收藏。
 */
export type StarColorName = "red" | "orange" | "blue" | "green";

export type DevAction =
  | { id: string; conv: string; action: "star"; color: StarColorName }
  | { id: string; conv: string; action: "transfer_inspect" | "transfer"; target: string; allowUnfavorite: boolean };

/** 有效期上限：请求最多在写入后这么久内有效。 */
export const DEV_ACTION_MAX_TTL_MS = 120_000;

export function parseDevAction(raw: string, now: number, consumed: ReadonlySet<string>): DevAction | string {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return "bad_json";
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return "bad_shape";
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(r.id)) return "bad_id";
  if (consumed.has(r.id)) return "id_already_used";
  if (typeof r.exp !== "number" || !Number.isFinite(r.exp)) return "bad_exp";
  if (r.exp < now) return "expired";
  if (r.exp > now + DEV_ACTION_MAX_TTL_MS) return "exp_too_far";
  if (typeof r.conv !== "string" || !/^[0-9a-f]{16}$/.test(r.conv)) return "bad_conv";
  if (r.action === "star") {
    if (!["red", "orange", "blue", "green"].includes(r.color as string)) return "bad_color";
    return { id: r.id, conv: r.conv, action: "star", color: r.color as StarColorName };
  }
  if (r.action === "transfer_inspect" || r.action === "transfer") {
    if (typeof r.target !== "string" || !r.target.trim() || r.target.length > 40) return "bad_target";
    if (r.allow_unfavorite !== undefined && typeof r.allow_unfavorite !== "boolean") return "bad_allow_unfavorite";
    return { id: r.id, conv: r.conv, action: r.action, target: r.target.trim(), allowUnfavorite: r.allow_unfavorite === true };
  }
  return "bad_action";
}
