import { normalizeBackendUrl } from "./protocol.js";

/**
 * 客户端一键打开后台管理（#62）：用某个店铺的客户端口令向本机后台换一次性票据（60 秒、只能用一次），
 * 再用系统浏览器打开后台管理页，票据放在 # 后面（不随请求发给服务器、不进访问日志），管理页启动时先从地址栏去掉再兑换。
 * 后台不在本机时不换票据，只打开登录页（照常输入密码）。
 */
export type AdminOpenResult = "ok" | "not_local" | "unsupported" | "failed" | "no_shop";
/** 换票失败的封闭类别：日志与提示只用这些，不输出后台返回的任意 code / message。 */
export type AdminFailure = "timeout" | "network" | "response_invalid" | `http_${number}`;

/** 把错误归到封闭类别；后台拒绝只保留 HTTP 状态码（整数）。 */
export function adminFailureOf(err: unknown): AdminFailure {
  const e = err as { name?: unknown; status?: unknown; code?: unknown } | null;
  if (e && typeof e.status === "number" && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599) return `http_${e.status}`;
  if (e && e.code === "timeout") return "timeout";
  if (e && (e.code === "handoff_response_invalid" || e.code === "response_unreadable")) return "response_invalid";
  return "network";
}

function failureText(f: AdminFailure): string {
  if (f === "timeout") return "后台响应超时";
  if (f === "network") return "连不上后台";
  if (f === "response_invalid") return "后台返回的内容格式不对";
  return `后台拒绝了请求（HTTP ${f.slice(5)}）`;
}

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

export function isLoopbackBackend(raw: string): boolean {
  try {
    return LOOPBACK.includes(new URL(normalizeBackendUrl(raw)).hostname);
  } catch {
    return false;
  }
}

/** 票据：后台签发的 urlsafe 随机串；格式不符就不用（不把奇怪的内容拼进地址）。 */
export function isHandoffTicket(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,128}$/.test(value);
}

/** 后台管理页地址；有票据时放在 # 后面。 */
export function adminPageUrl(backendUrl: string, ticket: string | null): string {
  const base = normalizeBackendUrl(backendUrl);
  return `${base}/${ticket && isHandoffTicket(ticket) ? `#handoff=${ticket}` : ""}`;
}

/**
 * 选用哪个店铺的口令：优先当前选中的店铺，其次第一个已设口令的店铺；都没有为 null。
 * 后台地址相同时任一店铺的口令都能换到同一个管理员会话。
 */
export function pickAdminShop<T extends { shop_id: string; backend_url: string }>(configs: readonly T[], selected: string | null, hasToken: (shopId: string) => boolean): T | null {
  const usable = configs.filter((c) => hasToken(c.shop_id));
  return usable.find((c) => c.shop_id === selected) ?? usable[0] ?? null;
}

/** 给用户看的结果说明。 */
export function adminOpenText(result: AdminOpenResult, failure?: AdminFailure): string {
  switch (result) {
    case "ok":
      // 客户端无法知道浏览器里是否兑换成功，只说明已打开链接。
      return "已打开后台登录链接，登录结果请在浏览器查看";
    case "not_local":
      return "后台不在本机，已打开登录页，请输入后台密码";
    case "unsupported":
      return "后台还不支持一键登录，已打开登录页，请输入后台密码";
    case "failed":
      return `一键登录没成功${failure ? `（${failureText(failure)}）` : ""}，已打开登录页，请输入后台密码`;
    case "no_shop":
      return "还没有设置了后台口令的店铺，打不开后台";
  }
}
