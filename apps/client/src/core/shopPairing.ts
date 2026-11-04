import { createHash, randomBytes } from "node:crypto";
import { isIdentifier } from "./protocol.js";

/**
 * 本机店铺自动登记（契约“本机店铺自动登记（1.0 增量）”，#75）：
 * 本机后台且已保存本机授权码时，客户端为店铺生成稳定的 client_id 与 32 随机字节口令，
 * 先按“店铺 + 后台 origin”存入系统安全存储，再用本机授权码向后台登记；成功后把口令作为本店客户端口令保存。
 * 响应丢失、超时不自动重试、不重新生成：下次点连接时用同一组值向后台核对（后台幂等）。
 * 口令只在系统安全存储与登记请求体里出现，不进普通配置、日志或界面。
 */

export type Pairing = { client_id: string; client_token: string };

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** 新的一组登记凭据：client_id 为 claw- 加 24 位十六进制；口令为 32 随机字节的 URL-safe Base64（43 位）。 */
export function newPairing(random: (n: number) => Buffer = randomBytes): Pairing {
  const client_id = `claw-${random(12).toString("hex")}`;
  const client_token = random(32).toString("base64url");
  return { client_id, client_token };
}

/** 安全存储里的键：sha256(店铺编号 + 换行 + 规范化 origin) 十六进制前 32 位。换了后台地址就是另一组凭据。 */
export function pairingKey(shopId: string, origin: string): string {
  return createHash("sha256").update(`${shopId}\n${origin}`).digest("hex").slice(0, 32);
}

export function encodePairing(p: Pairing): string {
  return JSON.stringify({ v: 1, client_id: p.client_id, client_token: p.client_token });
}

/** 读回的内容不合格（损坏或旧格式）返回 null；调用方不得因此静默生成新凭据覆盖。 */
export function decodePairing(raw: string | null): Pairing | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v?.v !== 1 || typeof v.client_id !== "string" || !isIdentifier(v.client_id) || typeof v.client_token !== "string" || !TOKEN.test(v.client_token)) return null;
    return { client_id: v.client_id, client_token: v.client_token };
  } catch {
    return null;
  }
}

/** 登记名称：去掉首尾空白，最多 128 字；空时用店铺编号。 */
export function pairingName(displayName: string, shopId: string): string {
  const name = displayName.trim();
  return [...(name || shopId)].slice(0, 128).join("");
}

/**
 * 登记失败的封闭类别：日志与提示只用这些，不输出后台返回的任意 message。
 * uncertain：超时、网络或响应不合格——后台可能已经登记，下次连接用同一组值核对，不重新生成。
 */
export type PairingFailure =
  | "no_grant"
  | "unsupported"
  | "grant_invalid"
  | "conflict"
  | "reserved"
  | "rate_limited"
  | "local_only"
  | "invalid_request"
  | "uncertain"
  | "rejected"
  | "stored_invalid"
  | "changed";

export function pairingFailureOf(err: unknown): PairingFailure {
  const e = err as { status?: unknown; code?: unknown } | null;
  if (e && typeof e.status === "number") {
    if (e.status === 404) return "unsupported";
    if (e.status === 401 && e.code === "invalid_handoff_grant") return "grant_invalid";
    if (e.status === 409 && e.code === "client_registration_conflict") return "conflict";
    if (e.status === 409 && e.code === "shop_id_reserved") return "reserved";
    if (e.status === 429) return "rate_limited";
    if (e.status === 403 && e.code === "local_only") return "local_only";
    if (e.status === 400) return "invalid_request";
    return "rejected";
  }
  return "uncertain";
}

/** 登记成功响应：店铺编号与 client_id 必须与提交的一致，created 为布尔，name 为字符串；否则按结果不确定处理。 */
export function parseRegistration(v: unknown, sent: { shop_id: string; client_id: string }): { created: boolean; name: string } | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.shop_id !== sent.shop_id || r.client_id !== sent.client_id || typeof r.created !== "boolean" || typeof r.name !== "string" || r.protocol_version !== "1.0") return null;
  return { created: r.created, name: r.name };
}

/** 自动登记流程用到的外部能力：安全存储、授权码、登记请求与保存口令，全部可替换以便测试。 */
export type PairingDeps = {
  shopId: string;
  displayName: string;
  /** 本机根地址的规范化 origin；后台不在本机时为 null。 */
  origin: string | null;
  grant: (origin: string) => string | null;
  store: { has(key: string): boolean; get(key: string): string | null; set(key: string, value: string): void };
  register: (origin: string, grant: string, body: { shop_id: string; name: string; client_id: string; client_token: string }) => Promise<{ created: boolean }>;
  saveToken: (token: string) => void;
  /** 保存口令前核对：本店仍存在、后台 origin 未变；否则本次登记作废，不写回口令。 */
  stillCurrent?: () => boolean;
  random?: (n: number) => Buffer;
};

export type PairingOutcome = { ok: true; created: boolean } | { ok: false; failure: PairingFailure | "not_local" | "storage_unavailable" };

/**
 * 一次登记：凭据先写入安全存储再发请求；已有记录就复用（响应丢失后的核对）；记录损坏不换新。
 * 请求失败一律不重试、不重新生成；成功后才保存为本店客户端口令。
 */
export async function pairShop(d: PairingDeps): Promise<PairingOutcome> {
  if (!d.origin) return { ok: false, failure: "not_local" };
  const grant = d.grant(d.origin);
  if (!grant) return { ok: false, failure: "no_grant" };
  const key = pairingKey(d.shopId, d.origin);
  let pairing: Pairing | null;
  if (d.store.has(key)) {
    let raw: string | null;
    try {
      raw = d.store.get(key);
    } catch {
      raw = null;
    }
    pairing = decodePairing(raw);
    if (!pairing) return { ok: false, failure: "stored_invalid" };
  } else {
    pairing = newPairing(d.random);
    try {
      d.store.set(key, encodePairing(pairing));
    } catch {
      return { ok: false, failure: "storage_unavailable" };
    }
  }
  let created: boolean;
  try {
    created = (await d.register(d.origin, grant, { shop_id: d.shopId, name: pairingName(d.displayName, d.shopId), client_id: pairing.client_id, client_token: pairing.client_token })).created;
  } catch (err) {
    return { ok: false, failure: pairingFailureOf(err) };
  }
  if (d.stillCurrent && !d.stillCurrent()) return { ok: false, failure: "changed" };
  try {
    d.saveToken(pairing.client_token);
  } catch {
    return { ok: false, failure: "storage_unavailable" };
  }
  return { ok: true, created };
}
