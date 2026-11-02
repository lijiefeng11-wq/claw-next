/**
 * 平台页面对网站报的浏览器身份：去掉 Electron 默认加上的“应用名/版本”和“Electron/版本”两段，
 * Chrome 版本按正版 Chrome 的写法只留主版本号（Chrome/140.0.0.0），其余（系统、内核）保持原样。
 *
 * 原因：用户实测同一账号在本客户端登录约一天就被平台结束，在 Chrome 里不会；两边登录凭证有效期相同，
 * 差别在于客户端的浏览器标识里带着 Electron 和应用名，容易被平台当作非常规设备。
 * 只改浏览器标识，不改任何收发与判定。
 */
const KEEP = /^(Mozilla|AppleWebKit|Chrome|Safari|Version|Mobile)\//;

export function chromeLikeUserAgent(ua: string): string {
  if (typeof ua !== "string" || !/\bChrome\/\d+/.test(ua)) return ua;
  // 按空格切分，但括号里的内容（系统信息、“KHTML, like Gecko”）作为整体保留。
  const parts = ua.match(/\([^)]*\)|[^\s()]+/g) ?? [];
  const kept = parts.filter((p) => p.startsWith("(") || KEEP.test(p));
  return kept.join(" ").replace(/\bChrome\/(\d+)(?:\.\d+){1,3}\b/, "Chrome/$1.0.0.0");
}
