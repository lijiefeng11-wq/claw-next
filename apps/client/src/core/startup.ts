import fs from "node:fs";
import path from "node:path";

/**
 * 开机自启与崩溃后自动重启（只用于打包后的独立应用）。
 * - macOS：一个用户级 LaunchAgent 任务。KeepAlive.SuccessfulExit=false = 异常退出才重启（正常退出不重启）。
 *   launchd 手册说明 SuccessfulExit 隐含 RunAtLoad，所以“只勾崩溃重启”时任务文件不能放进 ~/Library/LaunchAgents
 *   （否则登录时也会启动）：放在客户端数据目录，只在交接时由客户端加载；勾了开机自启才放进 LaunchAgents。
 * - Windows：开机自启用系统登录启动项；崩溃重启由随应用附带的守护程序负责（客户端非零退出时再拉起）。
 * 两种自动启动都受同一个重启预算约束：5 分钟内最多 3 次，超过就停住并提示用户，防止无限重启。
 * 自动启动只是重复“打开客户端”；店铺恢复与运行模式见 sessionStore，发送规则不变。
 */
export type StartupSettings = { launch_at_login: boolean; restart_on_crash: boolean };
export const DEFAULT_STARTUP: StartupSettings = { launch_at_login: false, restart_on_crash: false };

export const LAUNCH_AGENT_LABEL = "com.claw-next.client";
/** 由 LaunchAgent 启动时带的参数。 */
export const ARG_LAUNCHED_BY_AGENT = "--launched-by-agent";
/** 由 Windows 守护程序启动时带的参数。 */
export const ARG_SUPERVISED = "--supervised";
/** 自动启动时传递数据目录（不依赖登录时没有的环境变量）。 */
export const ARG_USER_DATA = "--user-data";
/** 交接失败兜底：带此参数打开时不再交接，直接运行，避免反复退出。 */
export const ARG_NO_HANDOVER = "--no-handover";

/** 启动参数里的数据目录（--user-data <目录>），没有则为 null。 */
export function userDataFromArgv(argv: string[]): string | null {
  const i = argv.indexOf(ARG_USER_DATA);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return typeof v === "string" && v.length > 0 && !v.startsWith("--") ? v : null;
}

/** macOS 任务文件放哪里：勾了开机自启放 LaunchAgents（登录时加载）；只勾崩溃重启放客户端数据目录（只在交接时加载）；都没勾则不要。 */
export function launchAgentLocation(settings: StartupSettings): "login" | "private" | null {
  if (settings.launch_at_login) return "login";
  if (settings.restart_on_crash) return "private";
  return null;
}
/** 重启预算：窗口与次数（与后台 launchd 保活一致）。 */
export const RESTART_WINDOW_MS = 300_000;
export const RESTART_MAX_STARTS = 3;
/** 两次自动重启之间至少间隔（毫秒）。 */
export const RESTART_DELAY_MS = 30_000;

export class StartupStore {
  private readonly file: string;
  private value: StartupSettings = { ...DEFAULT_STARTUP };

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "startup.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<StartupSettings>;
      this.value = { launch_at_login: raw.launch_at_login === true, restart_on_crash: raw.restart_on_crash === true };
    } catch {
      this.value = { ...DEFAULT_STARTUP };
    }
  }

  get(): StartupSettings {
    return { ...this.value };
  }

  set(next: StartupSettings) {
    this.value = { launch_at_login: next.launch_at_login === true, restart_on_crash: next.restart_on_crash === true };
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...this.value }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

/**
 * 自动启动的预算：记录自动启动（开机或崩溃后由系统/守护程序拉起）的时刻，窗口内达到上限就拒绝。
 * 手动打开不计入。记录文件损坏时拒绝（与后台一致：不自动清空，避免掩盖反复崩溃）。
 */
export class RestartBudget {
  private readonly file: string;

  constructor(dir: string, private readonly now: () => number = Date.now) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "restarts.json");
  }

  /** 允许本次自动启动则记下并返回 null；否则返回原因。 */
  admit(): null | "budget_exhausted" | "budget_unreadable" {
    let starts: number[] = [];
    if (fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { starts?: unknown };
        if (!Array.isArray(raw.starts) || !raw.starts.every((x) => typeof x === "number" && Number.isFinite(x))) return "budget_unreadable";
        starts = raw.starts as number[];
      } catch {
        return "budget_unreadable";
      }
    }
    const now = this.now();
    const recent = starts.filter((t) => t <= now && now - t < RESTART_WINDOW_MS);
    if (recent.length >= RESTART_MAX_STARTS) return "budget_exhausted";
    recent.push(now);
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, starts: recent }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return null;
  }

  /** 用户手动处理后重新开启自动重启时清空记录。 */
  reset() {
    fs.rmSync(this.file, { force: true });
  }
}

const xml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * 生成用户级 LaunchAgent。只用参数数组（路径可含空格和中文），不写环境变量、不含口令；
 * userData 只有在覆盖过数据目录时才以 --user-data 传入，让托管的进程用同一个数据目录。
 */
export function launchAgentPlist(opts: { executable: string; settings: StartupSettings; userData?: string | null }): string {
  const args = [opts.executable, ARG_LAUNCHED_BY_AGENT, ...(opts.userData ? [ARG_USER_DATA, opts.userData] : [])].map((a) => `\t\t<string>${xml(a)}</string>`).join("\n");
  const keepAlive = opts.settings.restart_on_crash ? "<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>" : "<false/>";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCH_AGENT_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>RunAtLoad</key>
\t${opts.settings.launch_at_login ? "<true/>" : "<false/>"}
\t<key>KeepAlive</key>
\t${keepAlive}
\t<key>ThrottleInterval</key>
\t<integer>${RESTART_DELAY_MS / 1000}</integer>
\t<key>LimitLoadToSessionType</key>
\t<string>Aqua</string>
\t<key>ProcessType</key>
\t<string>Interactive</string>
</dict>
</plist>
`;
}

/**
 * Windows 守护程序的判断：客户端退出后是否再拉起。
 * 正常退出（退出码 0 且非信号）不再拉起；异常退出在硬上限内延迟后拉起（客户端自己还会按重启预算再核一次）。
 * 硬上限防止客户端在检查预算之前就崩溃导致的无限循环。
 */
export function supervisorNext(exit: { code: number | null; signal: string | null }, recentRestarts: number[], now: number): { action: "stop"; reason: "clean_exit" | "too_many_restarts" } | { action: "restart"; delay_ms: number } {
  if (exit.code === 0 && !exit.signal) return { action: "stop", reason: "clean_exit" };
  const recent = recentRestarts.filter((t) => now - t < RESTART_WINDOW_MS * 2);
  if (recent.length >= RESTART_MAX_STARTS * 2) return { action: "stop", reason: "too_many_restarts" };
  return { action: "restart", delay_ms: RESTART_DELAY_MS };
}

/** 守护程序在每次拉起前读取的最新设置：读不到或已关闭崩溃重启就不再拉起。 */
export function restartStillEnabled(settingsFile: string | null): boolean {
  if (!settingsFile) return false;
  try {
    return (JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Partial<StartupSettings>).restart_on_crash === true;
  } catch {
    return false;
  }
}

/**
 * macOS 交接脚本（交给 /bin/sh 在后台执行）：先等旧进程退出、让出单实例锁；再卸载旧任务、加载任务文件
 * （SuccessfulExit 隐含 RunAtLoad，加载即启动）；然后确认任务真的在运行。约 15 秒内没起来就用 --no-handover 直接打开应用，
 * 保证客户端不会就此消失；兜底打开时带上自定义数据目录。launchctl / open 的路径可替换，便于测试。
 */
export function handoverScript(o: { pid: number; domain: string; label: string; plist: string; bundle: string; userData?: string | null; launchctl?: string; open?: string; waitTicks?: number; checkTicks?: number }): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const lc = q(o.launchctl ?? "/bin/launchctl");
  const op = q(o.open ?? "/usr/bin/open");
  const target = q(`${o.domain}/${o.label}`);
  return [
    `i=0; while kill -0 ${o.pid} 2>/dev/null && [ $i -lt ${o.waitTicks ?? 600} ]; do sleep 0.1; i=$((i+1)); done`,
    `${lc} bootout ${target} >/dev/null 2>&1`,
    `${lc} bootstrap ${q(o.domain)} ${q(o.plist)} >/dev/null 2>&1`,
    `i=0; while [ $i -lt ${o.checkTicks ?? 30} ]; do ${lc} print ${target} 2>/dev/null | grep -q 'state = running' && exit 0; sleep 0.5; i=$((i+1)); done`,
    `${op} -n ${q(o.bundle)} --args ${ARG_NO_HANDOVER}${o.userData ? ` ${ARG_USER_DATA} ${q(o.userData)}` : ""}`,
  ].join("\n");
}

/** 客户端启动时该怎么做（只对打包版生效）。 */
export function startupDecision(input: { packaged: boolean; platform: NodeJS.Platform; settings: StartupSettings; argv: string[] }):
  | { action: "run"; automatic: boolean }
  | { action: "handover"; to: "launch_agent" | "supervisor" } {
  const automatic = input.argv.includes(ARG_LAUNCHED_BY_AGENT) || input.argv.includes(ARG_SUPERVISED);
  if (!input.packaged || automatic || !input.settings.restart_on_crash) return { action: "run", automatic: input.packaged && automatic };
  // 手动打开且开启了崩溃重启：交给系统托管（macOS）或守护程序（Windows）重新启动，这样之后的崩溃才会被拉起。
  if (input.platform === "darwin") return { action: "handover", to: "launch_agent" };
  if (input.platform === "win32") return { action: "handover", to: "supervisor" };
  return { action: "run", automatic: false };
}

export function startupSupported(packaged: boolean, platform: NodeJS.Platform): boolean {
  return packaged && (platform === "darwin" || platform === "win32");
}
