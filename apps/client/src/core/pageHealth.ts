/**
 * 平台页面健康状态：只根据页面生命周期事件判断，不读取页面内容、不访问平台。
 * 决定何时自动恢复（重新加载或结束卡死的渲染进程），并限制次数，避免反复重载。
 */

export type PageState = "loading" | "ok" | "load_failed" | "crashed" | "unresponsive";

export type PageHealthView = {
  state: PageState;
  /** 给人看的说明，不含页面内容。 */
  detail: string;
  /** 进入当前状态的时间（毫秒）。 */
  since: number;
  /** 统计窗口内已自动重载的次数（崩溃与卡死）。 */
  reloads: number;
  /** 自动恢复次数用尽：不再自动重载，需要人工处理。 */
  gave_up: boolean;
  /** 本次运行中曾登录过、随后掉线（跳到登录页等），不是用户主动关闭。 */
  session_lost: boolean;
};

/**
 * none：什么都不做。
 * wait：需要恢复，但正在发送或准备发送，等它结束（发送结果按原规则判定，不因恢复而重发）。
 * reload：重新加载聊天页。
 * kill：渲染进程卡死，先结束它；随后按崩溃处理并重新加载。
 */
export type HealthAction = "none" | "wait" | "reload" | "kill";

export type PageHealthOptions = {
  now?: () => number;
  /** 统计窗口内最多自动重载次数。 */
  maxReloads?: number;
  windowMs?: number;
  /** 崩溃后等多久再重载（让进程完全退出）。 */
  crashDelayMs?: number;
  /** 卡死多久才结束渲染进程。 */
  unresponsiveGraceMs?: number;
  /** 页面加载失败（多为网络问题）后多久重试；不计入重载次数。 */
  loadRetryMs?: number;
  /**
   * 需要恢复但仍在发送时最多等多久。崩溃页面上的脚本可能永远不返回；超过后照常恢复。
   * 恢复会让旧页面的待点击操作失效（未点击的按未发送处理，已点击的保持不确定），不会重发。
   */
  maxBusyWaitMs?: number;
};

const DETAIL: Record<PageState, string> = {
  loading: "平台页面加载中",
  ok: "平台页面正常",
  load_failed: "平台页面加载失败（可能是网络问题），稍后自动重试",
  crashed: "平台页面已崩溃，正在自动重新加载",
  unresponsive: "平台页面无响应",
};

export class PageHealth {
  private state: PageState = "loading";
  private since: number;
  private reloadTimes: number[] = [];
  private gaveUp = false;
  private killed = false;
  private crashFromKill = false;
  private sessionLost = false;
  private readonly now: () => number;
  private readonly maxReloads: number;
  private readonly windowMs: number;
  private readonly crashDelayMs: number;
  private readonly unresponsiveGraceMs: number;
  private readonly loadRetryMs: number;
  private readonly maxBusyWaitMs: number;
  private waitingSince: number | null = null;

  constructor(opts: PageHealthOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.maxReloads = opts.maxReloads ?? 3;
    this.windowMs = opts.windowMs ?? 10 * 60_000;
    this.crashDelayMs = opts.crashDelayMs ?? 2_000;
    this.unresponsiveGraceMs = opts.unresponsiveGraceMs ?? 30_000;
    this.loadRetryMs = opts.loadRetryMs ?? 15_000;
    this.maxBusyWaitMs = opts.maxBusyWaitMs ?? 30_000;
    this.since = this.now();
  }

  private set(state: PageState) {
    if (this.state === state) return;
    this.state = state;
    this.since = this.now();
  }

  private recentReloads(): number {
    const cutoff = this.now() - this.windowMs;
    this.reloadTimes = this.reloadTimes.filter((t) => t > cutoff);
    return this.reloadTimes.length;
  }

  /** 主框架开始加载。崩溃后的加载也会经过这里。 */
  loadStarted() {
    if (this.state === "unresponsive") return;
    this.set("loading");
  }

  /** 主框架加载完成。 */
  loadFinished() {
    this.killed = false;
    // 页面已正常加载（例如人工处理后），恢复自动重载；窗口内的计数保留。
    this.gaveUp = false;
    this.set("ok");
  }

  /** 主框架加载失败（不含被新导航中止的情况，由调用方过滤）。 */
  loadFailed() {
    if (this.state === "crashed") return;
    this.set("load_failed");
  }

  crashed() {
    // 卡死后由本模块结束的进程已在 kill 时计过一次，随后的重载不再重复计数。
    this.crashFromKill = this.killed;
    this.killed = false;
    this.set("crashed");
  }

  unresponsive() {
    if (this.state === "crashed") return;
    this.set("unresponsive");
  }

  responsive() {
    if (this.state === "unresponsive") this.set("ok");
  }

  /** 平台会话结束。userClosed：用户主动关闭页面或退出登录，不算掉线。 */
  sessionEnded(userClosed: boolean) {
    if (!userClosed) this.sessionLost = true;
  }

  sessionStarted() {
    this.sessionLost = false;
  }

  /** 页面恢复正常后，手动“重新加载/重新登录”可以清掉放弃状态。 */
  resetGiveUp() {
    this.gaveUp = false;
    this.reloadTimes = [];
  }

  /** busy：正在发送或准备发送。由调用方定时询问。 */
  decide(busy: boolean): HealthAction {
    const action = this.need(busy);
    if (action !== "wait") {
      this.waitingSince = null;
      return action;
    }
    this.waitingSince ??= this.now();
    if (this.now() - this.waitingSince < this.maxBusyWaitMs) return "wait";
    return this.need(false);
  }

  private need(busy: boolean): HealthAction {
    const age = this.now() - this.since;
    switch (this.state) {
      case "crashed":
        if (this.gaveUp) return "none";
        if (age < this.crashDelayMs) return "none";
        // 本模块结束卡死进程时已为这次恢复计数并通过了次数门禁，随后的重载属于同一次恢复，必须完成；次数限制只作用于新的恢复周期。
        if (!this.crashFromKill && this.recentReloads() >= this.maxReloads) {
          this.gaveUp = true;
          return "none";
        }
        return busy ? "wait" : "reload";
      case "unresponsive":
        if (this.gaveUp || this.killed) return "none";
        if (age < this.unresponsiveGraceMs) return "none";
        if (this.recentReloads() >= this.maxReloads) {
          this.gaveUp = true;
          return "none";
        }
        return busy ? "wait" : "kill";
      case "load_failed":
        if (age < this.loadRetryMs) return "none";
        return busy ? "wait" : "reload";
      default:
        return "none";
    }
  }

  /** 调用方执行了 decide 给出的动作后登记。 */
  acted(action: HealthAction) {
    this.waitingSince = null;
    if (action === "reload") {
      // 加载失败的重试不计入次数：网络恢复前会一直重试，但间隔固定。
      if (this.state === "crashed" && !this.crashFromKill) this.reloadTimes.push(this.now());
      this.crashFromKill = false;
      this.set("loading");
    } else if (action === "kill") {
      this.killed = true;
      this.reloadTimes.push(this.now());
    }
  }

  view(): PageHealthView {
    let detail = DETAIL[this.state];
    if (this.gaveUp) detail = `平台页面连续 ${this.maxReloads} 次自动恢复后仍异常，已停止自动重载，请人工检查后点“重新加载平台页”`;
    else if (this.state === "unresponsive" && this.now() - this.since >= this.unresponsiveGraceMs) detail = "平台页面长时间无响应，正在结束并重新加载";
    return { state: this.state, detail, since: this.since, reloads: this.recentReloads(), gave_up: this.gaveUp, session_lost: this.sessionLost };
  }
}

export type ShopAlert = { level: "error" | "warn"; text: string };

/**
 * 店铺是否需要提醒（侧栏标红、系统通知）。只用于拼多多店铺；模拟店铺不提醒。
 * pageOpen：平台页面是否存在（用户关闭平台页面不提醒）。
 */
export function shopAlert(input: { adapter: "mock" | "pdd"; pageOpen: boolean; logged_in: boolean; page: PageHealthView | null }): ShopAlert | null {
  if (input.adapter !== "pdd" || !input.pageOpen || !input.page) return null;
  const p = input.page;
  if (p.gave_up) return { level: "error", text: "平台页面异常，自动恢复失败" };
  if (p.state === "crashed") return { level: "error", text: "平台页面崩溃，正在恢复" };
  if (p.state === "unresponsive") return { level: "error", text: "平台页面无响应" };
  if (p.state === "load_failed") return { level: "error", text: "平台页面加载失败" };
  if (!input.logged_in && p.session_lost) return { level: "error", text: "平台登录已失效，请重新扫码" };
  return null;
}
