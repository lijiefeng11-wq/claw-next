import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stableAppLocation } from "../src/core/startup.js";

test("Mac 程序位置：在“应用程序”文件夹且不在系统临时位置才能写进系统任务；其他平台不检查", () => {
  const app = "/Applications/Claw-Next-Client.app/Contents/MacOS/Claw-Next-Client";
  const translocated = "/private/var/folders/x1/abc/T/AppTranslocation/0F1E2D3C/d/Claw-Next-Client.app/Contents/MacOS/Claw-Next-Client";
  const downloads = "/Users/u/Downloads/Claw-Next-Client.app/Contents/MacOS/Claw-Next-Client";
  assert.equal(stableAppLocation({ platform: "darwin", execPath: app, inApplications: true }), true);
  assert.equal(stableAppLocation({ platform: "darwin", execPath: translocated, inApplications: false }), false);
  assert.equal(stableAppLocation({ platform: "darwin", execPath: translocated, inApplications: true }), false);
  assert.equal(stableAppLocation({ platform: "darwin", execPath: downloads, inApplications: false }), false);
  assert.equal(stableAppLocation({ platform: "win32", execPath: "C:\\Users\\u\\Downloads\\Claw-Next-Client.exe", inApplications: false }), true);
});

// 用 Electron 替身实例化真实的 StartupManager，模拟“打包版 Mac、不在应用程序文件夹”：不碰系统任务（不卸载、不写任务文件、不交接）。
// 加载被测模块前先把所有子进程入口换成只记录、不执行的替身（结束后恢复），并断言调用为零：
// 即使拒绝条件失效（例如变异验证去掉位置检查），也只会被替身记录，不会在开发者的 Mac 上执行真实的 launchctl / sh。
const CHILD_PROCESS_ENTRIES = ["execFileSync", "execFile", "execSync", "exec", "spawn", "spawnSync", "fork"] as const;
test("Mac 不在“应用程序”文件夹：手动打开不改系统任务；保存设置被拒且设置不变；不交接", () => {
  const commands: string[] = [];
  const cp = childProcess as unknown as Record<string, unknown>;
  const savedEntries = Object.fromEntries(CHILD_PROCESS_ENTRIES.map((k) => [k, cp[k]]));
  for (const k of CHILD_PROCESS_ENTRIES) {
    cp[k] = (file: unknown, args: unknown) => {
      commands.push(`${k} ${String(file)} ${Array.isArray(args) ? args.join(" ") : ""}`.trim());
      throw new Error("子进程已被测试替身拦截");
    };
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claw-next-startup-home-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "claw-next-startup-data-"));
  const req = Module.createRequire(__filename);
  const electronPath = req.resolve("electron");
  const savedElectron = req.cache[electronPath];
  const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const savedHome = process.env.HOME;
  let quits = 0;
  req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { app: { isPackaged: true, isInApplicationsFolder: () => false, quit: () => quits++, setLoginItemSettings: () => assert.fail("不应改登录项") } } } as unknown as NodeModule;
  const managerPath = req.resolve("../src/main/startupManager.js");
  delete req.cache[managerPath];
  try {
    Object.defineProperty(process, "platform", { ...savedPlatform, value: "darwin" });
    process.env.HOME = home;
    const { StartupManager } = req("../src/main/startupManager.js") as typeof import("../src/main/startupManager.js");
    const manager = new StartupManager(userData, null, false);
    manager.store.set({ launch_at_login: true, restart_on_crash: true });
    assert.equal(manager.locationOk(), false);
    assert.equal(manager.view().location_ok, false);
    manager.syncAtManualStart();
    assert.throws(() => manager.apply({ launch_at_login: false, restart_on_crash: false }), /startup_needs_applications/);
    assert.deepEqual(manager.store.get(), { launch_at_login: true, restart_on_crash: true });
    manager.handover("launch_agent");
    assert.deepEqual(commands, [], "不执行任何系统命令");
    assert.equal(quits, 0, "不交接、不退出");
    assert.equal(fs.existsSync(path.join(home, "Library")), false, "不写 ~/Library/LaunchAgents");
    assert.equal(fs.existsSync(path.join(userData, "launchd")), false, "不写私有任务文件");
  } finally {
    for (const k of CHILD_PROCESS_ENTRIES) cp[k] = savedEntries[k];
    Object.defineProperty(process, "platform", savedPlatform);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedElectron) req.cache[electronPath] = savedElectron;
    else delete req.cache[electronPath];
    delete req.cache[managerPath];
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
