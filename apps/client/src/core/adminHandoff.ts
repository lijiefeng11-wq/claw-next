import { normalizeBackendUrl } from "./protocol.js";

/**
 * 客户端一键打开后台管理（#62）：用某个店铺的客户端口令向本机后台换一次性票据（60 秒、只能用一次），
 * 再用系统浏览器打开后台管理页，票据放在 # 后面（不随请求发给服务器、不进访问日志），管理页启动时先从地址栏去掉再兑换。
 * 后台不在本机时不换票据，只打开登录页（照常输入密码）。
 */
export type AdminOpenResult = "ok" | "not_local" | "unsupported" | "failed" | "no_shop";

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
export function adminOpenText(result: AdminOpenResult, detail?: string): string {
  switch (result) {
    case "ok":
      return "已在浏览器打开后台管理（已自动登录）";
    case "not_local":
      return "后台不在本机，已打开登录页，请输入后台密码";
    case "unsupported":
      return "后台还不支持一键登录，已打开登录页，请输入后台密码";
    case "failed":
      return `一键登录没成功${detail ? `（${detail}）` : ""}，已打开登录页，请输入后台密码`;
    case "no_shop":
      return "还没有设置了后台口令的店铺，打不开后台";
  }
}
