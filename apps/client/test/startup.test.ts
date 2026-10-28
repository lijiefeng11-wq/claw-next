import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { validateIpc } from "../src/core/ipc.js";
import {
  ARG_LAUNCHED_BY_AGENT,
  ARG_NO_HANDOVER,
  ARG_SUPERVISED,
  ARG_USER_DATA,
  handoverScript,
  launchAgentLocation,
  restartStillEnabled,
  userDataFromArgv,
  LAUNCH_AGENT_LABEL,
  RESTART_DELAY_MS,
  RESTART_WINDOW_MS,
  RestartBudget,
  StartupStore,
  launchAgentPlist,
  startupDecision,
  startupSupported,
  supervisorNext,
} from "../src/core/startup.js";
import { tempDir } from "./helpers.js";

// 开机自启与崩溃重启：只测纯逻辑与守护程序；不安装 LaunchAgent、不改系统登录项。

const withDir = (fn: (dir: string) => void) => {
  const dir = tempDir("claw-startup-");
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("设置默认都关闭；保存后读回；文件损坏视为都关闭", () =>
  withDir((dir) => {
    assert.deepEqual(new StartupStore(dir).get(), { launch_at_login: false, restart_on_crash: false });
    new StartupStore(dir).set({ launch_at_login: true, restart_on_crash: false });
    assert.deepEqual(new StartupStore(dir).get(), { launch_at_login: true, restart_on_crash: false });
    fs.writeFileSync(path.join(dir, "startup.json"), "{bad");
    assert.deepEqual(new StartupStore(dir).get(), { launch_at_login: false, restart_on_crash: false });
  }));

test("重启预算：5 分钟内最多 3 次自动启动，窗口过后恢复；记录损坏时拒绝；手动处理后可清空", () =>
  withDir((dir) => {
    let now = 1_000_000;
    const b = new RestartBudget(dir, () => now);
    assert.equal(b.admit(), null);
    now += 60_000;
    assert.equal(b.admit(), null);
    now += 60_000;
    assert.equal(b.admit(), null);
    now += 60_000;
    assert.equal(b.admit(), "budget_exhausted");
    now = 1_000_000 + RESTART_WINDOW_MS + 1;
    assert.equal(b.admit(), null, "最早一次已出窗口");
    fs.writeFileSync(path.join(dir, "restarts.json"), "{bad");
    assert.equal(b.admit(), "budget_unreadable");
    b.reset();
    assert.equal(b.admit(), null);
  }));

test("LaunchAgent：参数数组（空格、中文、特殊字符转义）；开机自启 = RunAtLoad；崩溃重启 = 仅异常退出时 KeepAlive", () => {
  const exe = "/Applications/Claw Next 客户端 & <测试>.app/Contents/MacOS/Claw-Next-Client";
  const both = launchAgentPlist({ executable: exe, settings: { launch_at_login: true, restart_on_crash: true } });
  assert.match(both, new RegExp(`<key>Label</key>\\s*<string>${LAUNCH_AGENT_LABEL.replace(/\./g, "\\.")}</string>`));
  assert.ok(both.includes("<string>/Applications/Claw Next 客户端 &amp; &lt;测试&gt;.app/Contents/MacOS/Claw-Next-Client</string>"));
  assert.ok(both.includes(`<string>${ARG_LAUNCHED_BY_AGENT}</string>`));
  assert.match(both, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(both, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
  assert.match(both, new RegExp(`<key>ThrottleInterval</key>\\s*<integer>${RESTART_DELAY_MS / 1000}</integer>`));
  assert.ok(!both.includes(ARG_USER_DATA), "未覆盖数据目录时不传 --user-data");
  assert.ok(!both.includes("EnvironmentVariables"), "不写环境变量");
  const loginOnly = launchAgentPlist({ executable: "/x", settings: { launch_at_login: true, restart_on_crash: false } });
  assert.match(loginOnly, /<key>KeepAlive<\/key>\s*<false\/>/);
  const crashOnly = launchAgentPlist({ executable: "/x", settings: { launch_at_login: false, restart_on_crash: true }, userData: "/私有/数据" });
  assert.match(crashOnly, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(crashOnly, new RegExp(`<string>${ARG_LAUNCHED_BY_AGENT}</string>\\s*<string>${ARG_USER_DATA}</string>\\s*<string>/私有/数据</string>`));
  assert.ok(!crashOnly.includes("EnvironmentVariables"));
  assert.ok(!/token|password|口令/i.test(both + crashOnly));
});

test("守护程序判断：正常退出不再拉起；异常退出（含信号）延迟拉起；短时间内拉起过多则停止", () => {
  assert.deepEqual(supervisorNext({ code: 0, signal: null }, [], 0), { action: "stop", reason: "clean_exit" });
  assert.deepEqual(supervisorNext({ code: 1, signal: null }, [], 0), { action: "restart", delay_ms: RESTART_DELAY_MS });
  assert.deepEqual(supervisorNext({ code: null, signal: "SIGKILL" }, [], 0), { action: "restart", delay_ms: RESTART_DELAY_MS });
  const now = 10_000_000;
  assert.deepEqual(supervisorNext({ code: 1, signal: null }, Array.from({ length: 6 }, (_, i) => now - i * 1000), now), { action: "stop", reason: "too_many_restarts" });
});

test("启动判断：只对打包版生效；自动启动直接运行；手动打开且开启崩溃重启时交给系统托管（Mac）或守护程序（Windows）", () => {
  const on = { launch_at_login: false, restart_on_crash: true };
  const off = { launch_at_login: true, restart_on_crash: false };
  assert.deepEqual(startupDecision({ packaged: false, platform: "darwin", settings: on, argv: [] }), { action: "run", automatic: false });
  assert.deepEqual(startupDecision({ packaged: true, platform: "darwin", settings: off, argv: [] }), { action: "run", automatic: false });
  assert.deepEqual(startupDecision({ packaged: true, platform: "darwin", settings: on, argv: [] }), { action: "handover", to: "launch_agent" });
  assert.deepEqual(startupDecision({ packaged: true, platform: "win32", settings: on, argv: [] }), { action: "handover", to: "supervisor" });
  assert.deepEqual(startupDecision({ packaged: true, platform: "darwin", settings: on, argv: [ARG_LAUNCHED_BY_AGENT] }), { action: "run", automatic: true });
  assert.deepEqual(startupDecision({ packaged: true, platform: "win32", settings: on, argv: [ARG_SUPERVISED] }), { action: "run", automatic: true });
  assert.deepEqual(startupDecision({ packaged: true, platform: "linux", settings: on, argv: [] }), { action: "run", automatic: false });
  assert.equal(startupSupported(true, "darwin"), true);
  assert.equal(startupSupported(true, "win32"), true);
  assert.equal(startupSupported(true, "linux"), false);
  assert.equal(startupSupported(false, "darwin"), false);
});

test("设置通道只接受两个布尔值", () => {
  assert.deepEqual(validateIpc("app:setStartup", { launch_at_login: true, restart_on_crash: false }), { channel: "app:setStartup", launch_at_login: true, restart_on_crash: false });
  assert.throws(() => validateIpc("app:setStartup", { launch_at_login: "yes", restart_on_crash: false }), /invalid_startup_settings/);
  assert.throws(() => validateIpc("app:setStartup", { launch_at_login: true }), /invalid_startup_settings/);
  assert.throws(() => validateIpc("app:setStartup", { launch_at_login: true, restart_on_crash: true, path: "/x" }), /unexpected_field:path/);
});

test("守护程序端到端：等交接前的进程退出，异常退出后拉起，正常退出后自己也退出；子进程不继承 Node 模式", { skip: process.platform === "win32" }, () =>
  withDir((dir) => {
    // 虚构客户端：第一次异常退出（码 3），第二次正常退出；记录收到的参数与是否继承了 ELECTRON_RUN_AS_NODE。
    const app = path.join(dir, "fake-app.sh");
    const count = path.join(dir, "count");
    fs.writeFileSync(app, `#!/bin/sh\nn=$(cat "${count}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${count}"\necho "run=$n args=$* node_mode=\${ELECTRON_RUN_AS_NODE:-unset}" >> "${dir}/runs"\n[ $n -eq 1 ] && exit 3\nexit 0\n`, { mode: 0o755 });
    const supervisor = path.join(__dirname, "..", "src", "main", "supervisor.js");
    const log = path.join(dir, "supervisor.log");
    new StartupStore(dir).set({ launch_at_login: false, restart_on_crash: true });
    const r = spawnSync(process.execPath, [supervisor, "--app", app, "--parent", "0", "--log", log, "--settings", path.join(dir, "startup.json"), "--delay-ms", "50"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20_000 });
    assert.equal(r.status, 0);
    assert.deepEqual(fs.readFileSync(path.join(dir, "runs"), "utf8").trim().split("\n"), [`run=1 args=${ARG_SUPERVISED} node_mode=unset`, `run=2 args=${ARG_SUPERVISED} node_mode=unset`]);
    const lines = fs.readFileSync(log, "utf8");
    assert.match(lines, /exit code=3 .* next=restart/);
    assert.match(lines, /exit code=0 .* next=stop reason=clean_exit/);
  }));

test("macOS 任务文件位置：勾开机自启放 LaunchAgents；只勾崩溃重启放客户端数据目录（launchd 中 SuccessfulExit 隐含 RunAtLoad）；都不勾不要", () => {
  assert.equal(launchAgentLocation({ launch_at_login: true, restart_on_crash: true }), "login");
  assert.equal(launchAgentLocation({ launch_at_login: true, restart_on_crash: false }), "login");
  assert.equal(launchAgentLocation({ launch_at_login: false, restart_on_crash: true }), "private");
  assert.equal(launchAgentLocation({ launch_at_login: false, restart_on_crash: false }), null);
});

test("启动参数里的数据目录：只认 --user-data 后紧跟的值", () => {
  assert.equal(userDataFromArgv(["app", ARG_SUPERVISED, ARG_USER_DATA, "D:\\数据 目录"]), "D:\\数据 目录");
  assert.equal(userDataFromArgv(["app", ARG_USER_DATA]), null);
  assert.equal(userDataFromArgv(["app", ARG_USER_DATA, "--supervised"]), null);
  assert.equal(userDataFromArgv(["app"]), null);
});

test("守护程序读取最新设置：开着才继续拉起；读不到或已关闭则停止", () =>
  withDir((dir) => {
    const file = path.join(dir, "startup.json");
    assert.equal(restartStillEnabled(file), false);
    new StartupStore(dir).set({ launch_at_login: false, restart_on_crash: true });
    assert.equal(restartStillEnabled(file), true);
    new StartupStore(dir).set({ launch_at_login: false, restart_on_crash: false });
    assert.equal(restartStillEnabled(file), false);
    fs.writeFileSync(file, "{bad");
    assert.equal(restartStillEnabled(file), false);
    assert.equal(restartStillEnabled(null), false);
  }));

/** 假 launchctl：记录调用；bootstrap 时记下当时旧进程是否还活着；print 按 mode 决定任务是否在运行。 */
function fakeLaunchctl(dir: string, oldPid: number, running: boolean) {
  const lc = path.join(dir, "launchctl");
  fs.writeFileSync(lc, `#!/bin/sh\necho "$1 $2 $3" >> "${dir}/calls"\nif [ "$1" = bootstrap ]; then if kill -0 ${oldPid} 2>/dev/null; then echo old_alive >> "${dir}/calls"; else echo old_gone >> "${dir}/calls"; fi; fi\nif [ "$1" = print ]; then ${running ? 'echo "state = running"' : 'echo "state = not running"'}; fi\nexit 0\n`, { mode: 0o755 });
  const op = path.join(dir, "open");
  fs.writeFileSync(op, `#!/bin/sh\necho "open $*" >> "${dir}/calls"\n`, { mode: 0o755 });
  return { lc, op };
}

test("Mac 交接脚本：等旧进程退出后才加载任务；确认任务在运行则结束；未运行则用 --no-handover 直接打开应用", { skip: process.platform === "win32" }, () => {
  for (const [running, userData] of [[true, null], [false, null], [false, "/Users/测试 用户/私有 数据"]] as const) {
    const dir = tempDir("claw-handover-");
    try {
      // 模拟“旧进程还要 1 秒才退出”（停店铺收尾）。用脱离本测试进程的独立进程，退出后由系统回收（不会成为僵尸）。
      const oldPid = Number(spawnSync("/bin/sh", ["-c", "sleep 1 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).stdout.trim());
      assert.ok(oldPid > 0);
      const { lc, op } = fakeLaunchctl(dir, oldPid, running);
      const script = handoverScript({ pid: oldPid, domain: "gui/501", label: "com.claw-next.client", plist: "/私有/数据/launchd/com.claw-next.client.plist", bundle: "/Applications/Claw Next.app", userData, launchctl: lc, open: op, checkTicks: 2 });
      const r = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", timeout: 20_000 });
      assert.equal(r.status, 0);
      const calls = fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n");
      assert.equal(calls[0], "bootout gui/501/com.claw-next.client ");
      assert.equal(calls[1], "bootstrap gui/501 /私有/数据/launchd/com.claw-next.client.plist");
      assert.equal(calls[2], "old_gone", "必须在旧进程退出（让出单实例锁）后才加载");
      assert.ok(calls.some((c) => c.trim() === "print gui/501/com.claw-next.client"), calls.join(" | "));
      assert.equal(calls.some((c) => c.startsWith("open ")), !running);
      // 兜底打开带上自定义数据目录（无环境变量时也能回到同一目录）；没有自定义目录时不多加参数。
      if (!running) assert.equal(calls.at(-1), `open -n /Applications/Claw Next.app --args ${ARG_NO_HANDOVER}${userData ? ` ${ARG_USER_DATA} ${userData}` : ""}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** 运行真实 supervisor.js：虚构客户端按 behavior 退出；返回运行记录与守护日志。 */
function runSupervisor(dir: string, script: string, extra: string[] = [], during?: () => void) {
  const app = path.join(dir, "fake-app.sh");
  fs.writeFileSync(app, script, { mode: 0o755 });
  const supervisor = path.join(__dirname, "..", "src", "main", "supervisor.js");
  const log = path.join(dir, "supervisor.log");
  const args = [supervisor, "--app", app, "--parent", "0", "--log", log, "--settings", path.join(dir, "startup.json"), ...extra];
  return { args, log, app, during };
}

test("守护程序：客户端运行中用户关闭了崩溃重启 → 异常退出后不再拉起", { skip: process.platform === "win32" }, () =>
  withDir((dir) => {
    new StartupStore(dir).set({ launch_at_login: false, restart_on_crash: true });
    // 虚构客户端：把设置改成关闭（相当于用户取消勾选），然后异常退出。
    const script = `#!/bin/sh\necho run >> "${dir}/runs"\nprintf '{"version":1,"launch_at_login":false,"restart_on_crash":false}' > "${dir}/startup.json"\nexit 3\n`;
    const { args, log } = runSupervisor(dir, script, ["--delay-ms", "50"]);
    const r = spawnSync(process.execPath, args, { timeout: 20_000 });
    assert.equal(r.status, 0);
    assert.equal(fs.readFileSync(path.join(dir, "runs"), "utf8").trim().split("\n").length, 1);
    assert.match(fs.readFileSync(log, "utf8"), /stop reason=disabled_after_exit/);
  }));

test("守护程序：等待重启期间用户关闭了崩溃重启 → 不再拉起；并把 --user-data 传给客户端", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir("claw-startup-");
  try {
    new StartupStore(dir).set({ launch_at_login: false, restart_on_crash: true });
    const script = `#!/bin/sh\necho "run args=$*" >> "${dir}/runs"\nexit 3\n`;
    const { args, log } = runSupervisor(dir, script, ["--delay-ms", "1500", "--user-data", "/私有/数据"]);
    const child = spawn(process.execPath, args, { stdio: "ignore" });
    const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    // 第一次退出后、拉起前关闭设置。
    for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, "runs")); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    new StartupStore(dir).set({ launch_at_login: false, restart_on_crash: false });
    assert.equal(await exited, 0);
    assert.deepEqual(fs.readFileSync(path.join(dir, "runs"), "utf8").trim().split("\n"), [`run args=${ARG_SUPERVISED} ${ARG_USER_DATA} /私有/数据`]);
    assert.match(fs.readFileSync(log, "utf8"), /stop reason=disabled_while_waiting/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Mac 兜底打开的参数：带空格和中文的数据目录作为一个参数传给应用", { skip: process.platform === "win32" }, () =>
  withDir((dir) => {
    // 用真实 sh 执行兜底那一行，确认参数边界：应用收到的 --user-data 后面是完整的一个目录。
    const op = path.join(dir, "open");
    fs.writeFileSync(op, `#!/bin/sh\nfor a in "$@"; do echo "[$a]" >> "${dir}/argv"; done\n`, { mode: 0o755 });
    const lc = path.join(dir, "lc");
    fs.writeFileSync(lc, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const script = handoverScript({ pid: 999999, domain: "gui/501", label: "x", plist: "/p", bundle: "/Applications/Claw Next.app", userData: "/Users/测试 用户/私有 数据", launchctl: lc, open: op, checkTicks: 1 });
    assert.equal(spawnSync("/bin/sh", ["-c", script]).status, 0);
    const argv = fs.readFileSync(path.join(dir, "argv"), "utf8").trim().split("\n");
    assert.deepEqual(argv, ["[-n]", "[/Applications/Claw Next.app]", "[--args]", `[${ARG_NO_HANDOVER}]`, `[${ARG_USER_DATA}]`, "[/Users/测试 用户/私有 数据]"]);
    assert.equal(userDataFromArgv(argv.slice(3).map((a) => a.slice(1, -1))), "/Users/测试 用户/私有 数据");
  }));
