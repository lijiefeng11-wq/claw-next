// Windows 崩溃重启守护程序：以 Electron 的 Node 模式运行（ELECTRON_RUN_AS_NODE=1），没有窗口，不加载任何业务代码。
// 用法：<应用可执行文件> <本文件> --app <应用可执行文件> --parent <交接前的进程号> --log <日志文件>
//        --settings <startup.json> [--user-data <数据目录>]
// 先等交接前的客户端退出（让出单实例锁），再以 --supervised 启动客户端；客户端异常退出时按 supervisorNext 延迟拉起，
// 正常退出则自己也退出。每次拉起前（退出后、等待后）都重新读取设置：用户已关闭崩溃重启就不再拉起。
import { spawn } from "node:child_process";
import fs from "node:fs";
import { ARG_SUPERVISED, ARG_USER_DATA, restartStillEnabled, supervisorNext } from "../core/startup.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] ?? null : null;
};
const app = arg("app");
const parent = Number(arg("parent") ?? "0");
const logFile = arg("log");
const settingsFile = arg("settings");
const userData = arg("user-data");
/** 仅测试用：覆盖两次拉起之间的等待（毫秒）；正式运行不传，使用 supervisorNext 给出的间隔。 */
const delayOverride = arg("delay-ms") === null ? null : Number(arg("delay-ms"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(line: string) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} supervisor ${line}\n`, { mode: 0o600 });
  } catch {
    // 日志写不了不影响守护。
  }
}

function alive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!app) {
    log("missing --app");
    process.exit(2);
  }
  // 最多等 60 秒让交接前的客户端退出。
  for (let i = 0; i < 600 && alive(parent); i++) await sleep(100);
  const restarts: number[] = [];
  for (;;) {
    // 子进程不能继承 Node 模式，否则客户端会以纯 Node 运行。
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const started = Date.now();
    const child = spawn(app, [ARG_SUPERVISED, ...(userData ? [ARG_USER_DATA, userData] : [])], { env, stdio: "ignore", windowsHide: false });
    log(`started pid=${child.pid ?? "?"}`);
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once("error", () => resolve({ code: -1, signal: null }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const next = supervisorNext(exit, restarts, Date.now());
    log(`exit code=${exit.code} signal=${exit.signal ?? "-"} ran_ms=${Date.now() - started} next=${next.action}${next.action === "stop" ? ` reason=${next.reason}` : ""}`);
    if (next.action === "stop") return;
    if (!restartStillEnabled(settingsFile)) return log("stop reason=disabled_after_exit");
    restarts.push(Date.now());
    await sleep(delayOverride !== null && Number.isFinite(delayOverride) && delayOverride >= 0 ? delayOverride : next.delay_ms);
    if (!restartStillEnabled(settingsFile)) return log("stop reason=disabled_while_waiting");
  }
}

void main().then(() => process.exit(0));
