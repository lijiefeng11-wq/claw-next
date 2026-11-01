/**
 * 拼多多商家后台的登录凭据：mms.pinduoduo.com 的 PASS_ID Cookie（2026-11-01 在用户 Mac 上核对：持久 Cookie，
 * 扫码后 3 天过期）。客户端只用它的过期时间来提前提醒重新扫码，从不读取、记录或上报 Cookie 的值。
 */
export const LOGIN_COOKIE_URL = "https://mms.pinduoduo.com/";
export const LOGIN_COOKIE_NAME = "PASS_ID";

/** Electron Cookie 对象里本模块用到的字段（不含 value）。 */
export type CookieMeta = { name?: string; expirationDate?: number; session?: boolean };

/**
 * 登录凭据的过期时间（Unix 秒）。多个同名凭据时取最早的（提醒偏保守）；会话 Cookie、没有或不合法的过期时间忽略；
 * 一个都没有时返回 null（不提醒“即将过期”，未登录由页面状态另行提醒）。
 */
export function loginExpiryOf(cookies: readonly CookieMeta[]): number | null {
  let min: number | null = null;
  for (const c of cookies) {
    if (c.name !== LOGIN_COOKIE_NAME || c.session === true) continue;
    const t = c.expirationDate;
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) continue;
    if (min === null || t < min) min = t;
  }
  return min;
}

/** 界面文字：“平台登录有效至 11-04 09:58”；没有过期时间时为空串。 */
export function loginExpiryText(expiresAt: number | null | undefined, now = Date.now()): string {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return "";
  const d = new Date(expiresAt * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const when = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return expiresAt * 1000 <= now ? `平台登录已于 ${when} 过期` : `平台登录有效至 ${when}`;
}
