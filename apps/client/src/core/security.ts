import { isIdentifier } from "./protocol.js";

/** 本地界面窗口：渲染页面没有 Node 能力，只通过预加载脚本暴露的受限 IPC 通信。 */
export const APP_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  spellcheck: false,
} as const;

/** 平台登录窗口：远程网页，没有预加载脚本，也没有任何 Node/文件/命令能力。 */
export const PLATFORM_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false,
} as const;

export const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const PLATFORM_HOSTS = ["pinduoduo.com", "yangkeduo.com"];

/** 平台登录窗口只允许在拼多多相关 HTTPS 域名内导航。 */
export function isAllowedPlatformUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  return PLATFORM_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith("." + h));
}

const IMAGE_HOSTS = ["pddpic.com", "yangkeduo.com", "pinduoduo.com"];

/** 买家图片只从平台自身图片域名读取（HTTPS，无账号信息）。 */
export function isAllowedImageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  return IMAGE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith("." + h));
}

/** 按文件头判断图片类型，不信任响应头声明。 */
export function sniffImage(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** shop_id 会用作目录名、口令文件名和浏览器分区名：全由点组成的编号会被路径解析成上级目录，一律拒绝。 */
export function isPathSafeShopId(shopId: string): boolean {
  return isIdentifier(shopId) && !/^\.+$/.test(shopId);
}

/** 每店独立持久化分区，键来自稳定 shop_id，而不是昵称或列表序号。 */
export function partitionFor(shopId: string): string {
  if (!isPathSafeShopId(shopId)) throw new Error("invalid_shop_id");
  return `persist:claw-next-shop-${shopId}`;
}
