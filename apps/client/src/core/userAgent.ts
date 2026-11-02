/**
 * 平台页面对网站报的浏览器身份：去掉 Electron 默认加上的“应用名/版本”和“Electron/版本”两段，
 * Chrome 版本按正版 Chrome 的写法只留主版本号（Chrome/140.0.0.0），其余（系统、内核）保持原样。
 *
 * 这是待验证的假设，不是已证实的原因：用户反映在本客户端登录约一天就被平台结束、在 Chrome 里不会；
 * 本机取证只看到两边登录凭证的类型与有效期相同（未比较凭证值），而客户端的浏览器标识带着 Electron 和应用名。
 * 这里只改标识字符串；页面里的 navigator.userAgentData 与请求头 sec-ch-ua（Client Hints）仍是 Electron 内置值，
 * 未改。改了之后能否避免掉线，要看用户实际使用的观察结果。
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
