import { app } from "electron";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ARG_USER_DATA,
  LAUNCH_AGENT_LABEL,
  RestartBudget,
  StartupSettings,
  StartupStore,
  handoverScript,
  launchAgentLocation,
  launchAgentPlist,
  stableAppLocation,
  startupSupported,
} from "../core/startup.js";

export type StartupView = { supported: boolean; platform: NodeJS.Platform; launch_at_login: boolean; restart_on_crash: boolean; managed: boolean; location_ok: boolean };

/**
 * 开机自启与崩溃重启的系统操作（只在打包版、macOS / Windows 上生效）。
 *
 * macOS 任务何时真正更新到系统（launchd 内存中的任务）：
 * - 本进程不是托管启动时：保存设置会先卸载（bootout）旧任务、按设置写入或删除任务文件；开启崩溃重启需交接（重启客户端），
 *   交接时加载任务文件并确认任务在运行。只勾开机自启时不立即加载，下次登录由系统加载。
 * - 本进程由系统托管时：卸载任务会结束自己，所以只改任务文件；系统里已加载的任务在本次正常退出后、
 *   下次手动打开（启动时先卸载旧任务）或下次登录时才更新。界面会说明这一点。
 */
export class StartupManager {
  readonly store: StartupStore;
  readonly budget: RestartBudget;

  constructor(
    private readonly userData: string,
    /** 覆盖过的数据目录（--user-data 或 CLAW_NEXT_USER_DATA）；自动启动时以 --user-data 传下去。 */
    private readonly userDataOverride: string | null,
    /** 本进程是否由系统托管或守护程序启动。 */
    readonly managed: boolean,
  ) {
    this.store = new StartupStore(path.join(userData, "config"));
    this.budget = new RestartBudget(path.join(userData, "config"));
  }

  supported() {
    return startupSupported(app.isPackaged, process.platform);
  }

  /** 程序路径能否写进系统任务（见 stableAppLocation）。读不到时按不能处理。 */
  locationOk(): boolean {
    try {
      return stableAppLocation({ platform: process.platform, execPath: process.execPath, inApplications: process.platform === "darwin" ? app.isInApplicationsFolder() : true });
    } catch {
      return false;
    }
  }

  /** 是否运行在系统临时位置（在“下载”等位置解压后直接打开）。只用于日志。 */
  translocated(): boolean {
    return process.execPath.includes("/AppTranslocation/");
  }

  view(): StartupView {
    const s = this.store.get();
    const supported = this.supported();
    return { supported, platform: process.platform, launch_at_login: s.launch_at_login, restart_on_crash: s.restart_on_crash, managed: this.managed, location_ok: !supported || this.locationOk() };
  }

  private settingsFile() {
    return path.join(this.userData, "config", "startup.json");
  }

  private plistPath(where: "login" | "private") {
    return where === "login" ? path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`) : path.join(this.userData, "launchd", `${LAUNCH_AGENT_LABEL}.plist`);
  }

  private domain() {
    return `gui/${os.userInfo().uid}`;
  }

  /** 卸载系统里的旧任务（没有也不报错）。只在本进程不是托管启动时调用，否则会结束自己。 */
  private bootout() {
    if (this.managed || process.platform !== "darwin") return;
    try {
      execFileSync("/bin/launchctl", ["bootout", `${this.domain()}/${LAUNCH_AGENT_LABEL}`], { stdio: "ignore", timeout: 10_000 });
    } catch {
      // 没有加载的任务时 bootout 会失败，忽略。
    }
  }

  /** 按设置写入或删除 macOS 任务文件；两个位置只保留一个。 */
  private writeTaskFiles(s: StartupSettings) {
    const where = launchAgentLocation(s);
    for (const loc of ["login", "private"] as const) {
      const file = this.plistPath(loc);
      if (loc !== where) {
        fs.rmSync(file, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, launchAgentPlist({ executable: process.execPath, settings: s, userData: this.userDataOverride }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
  }

  /** 非托管启动时把系统状态与设置对齐：卸载可能残留的旧任务并重写任务文件（交接或下次登录时再加载）。 */
  syncAtManualStart() {
    if (!this.supported() || this.managed || process.platform !== "darwin") return;
    // 程序路径不长期有效时不动系统任务：既不卸载也不改写，避免把临时路径写进去。
    if (!this.locationOk()) return;
    this.bootout();
    this.writeTaskFiles(this.store.get());
  }

  /** 保存设置并同步到系统。返回是否需要交接（开启崩溃重启、而本进程不是托管启动的）。 */
  apply(next: StartupSettings): { needsHandover: boolean } {
    if (!this.supported()) throw new Error("startup_unsupported");
    if (!this.locationOk()) throw new Error("startup_needs_applications");
    const prev = this.store.get();
    this.store.set(next);
    if (next.restart_on_crash && !prev.restart_on_crash) this.budget.reset();
    if (process.platform === "darwin") {
      this.bootout();
      this.writeTaskFiles(next);
    } else if (process.platform === "win32") {
      app.setLoginItemSettings({ openAtLogin: next.launch_at_login, path: process.execPath, args: this.userDataOverride ? [ARG_USER_DATA, this.userDataOverride] : [] });
    }
    console.log(`startup settings launch_at_login=${next.launch_at_login} restart_on_crash=${next.restart_on_crash} managed=${this.managed}`);
    return { needsHandover: next.restart_on_crash && !this.managed };
  }

  /**
   * 交接：让系统托管（macOS）或守护程序（Windows）在本进程退出后重新启动客户端，然后本进程退出。
   * 两边都等本进程真正退出（让出单实例锁）后才启动新实例；macOS 还确认任务在运行，否则直接重新打开应用。
   */
  handover(to: "launch_agent" | "supervisor") {
    if (to === "launch_agent") {
      // 调用方已检查；这里再挡一次：不把临时路径写进系统任务。
      if (!this.locationOk()) {
        console.log("startup handover skipped: app not in Applications folder");
        return;
      }
      const s = this.store.get();
      this.writeTaskFiles(s);
      const where = launchAgentLocation(s);
      if (!where) return;
      const script = handoverScript({ pid: process.pid, domain: this.domain(), label: LAUNCH_AGENT_LABEL, plist: this.plistPath(where), bundle: path.resolve(process.execPath, "..", "..", ".."), userData: this.userDataOverride });
      spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" }).unref();
    } else {
      const supervisor = path.join(__dirname, "supervisor.js");
      const log = path.join(this.userData, "logs", "supervisor.log");
      fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
      const args = [supervisor, "--app", process.execPath, "--parent", String(process.pid), "--log", log, "--settings", this.settingsFile(), ...(this.userDataOverride ? ["--user-data", this.userDataOverride] : [])];
      spawn(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true, stdio: "ignore", windowsHide: true }).unref();
    }
    console.log(`startup handover to=${to}`);
    app.quit();
  }
}
