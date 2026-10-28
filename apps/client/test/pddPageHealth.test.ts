import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import Module from "node:module";
import { test } from "node:test";

const req = Module.createRequire(__filename), electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: {} } } as unknown as NodeModule;
const { PddPageAdapter } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");
const { PageHealth } = req("../src/core/pageHealth.js") as typeof import("../src/core/pageHealth.js");

/** 虚构平台页面：只记录生命周期调用，不加载任何网页。 */
function fakePage() {
  const dbg = Object.assign(new EventEmitter(), {
    attached: false,
    attaches: 0,
    commands: [] as string[],
    isAttached() { return this.attached; },
    attach() { this.attached = true; this.attaches++; },
    async sendCommand(method: string) { this.commands.push(method); return {}; },
  });
  const wc = Object.assign(new EventEmitter(), {
    debugger: dbg,
    crashes: 0,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    isLoadingMainFrame: () => false,
    getURL: () => "https://mms.pinduoduo.com/chat-merchant/index.html",
    setWindowOpenHandler() {},
    forcefullyCrashRenderer() { this.crashes++; },
    executeJavaScriptInIsolatedWorld: async () => null,
  });
  const closed: (() => void)[] = [];
  const page = {
    webContents: wc,
    loads: [] as string[],
    isDestroyed: () => wc.destroyed,
    loadURL: async (url: string) => { page.loads.push(url); },
    close: () => { wc.destroyed = true; for (const l of closed.splice(0)) l(); },
    on: (event: string, l: () => void) => { if (event === "closed") closed.push(l); },
  };
  return page;
}

async function loggedIn(page: ReturnType<typeof fakePage>) {
  const adapter = new PddPageAdapter("fixture", "虚构店铺", null, () => page as any) as any;
  await adapter.login();
  // 用固定时钟的健康状态替换，便于控制时间。
  let t = 1_000_000;
  const clock = { advance: (ms: number) => (t += ms) };
  adapter.health = new PageHealth({ now: () => t, crashDelayMs: 2000, maxBusyWaitMs: 30_000 });
  page.webContents.emit("did-finish-load");
  return { adapter, clock };
}

test("页面崩溃：结束平台会话、标记异常，进程退出后重新附加调试通道并重新加载", async () => {
  const page = fakePage();
  const { adapter, clock } = await loggedIn(page);
  const ended: string[] = [];
  adapter.onEvent((e: any) => { if (e.type === "session_ended") ended.push(e.reason); });
  adapter.tracker.active = { mall_id: "1", mall_name: "虚构" };
  const epoch = adapter.watchEpoch;
  page.webContents.debugger.attached = false; // 崩溃使调试通道断开
  page.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.deepEqual(ended, ["platform_page_crashed"]);
  assert.ok(adapter.watchEpoch > epoch, "旧页面上的待点击操作失效");
  assert.equal(adapter.status().page.state, "crashed");
  assert.match(adapter.status().detail, /崩溃/);
  const loadsBefore = page.loads.length;
  adapter.healthTick(page);
  assert.equal(page.loads.length, loadsBefore, "等进程退出");
  clock.advance(2000);
  adapter.healthTick(page);
  assert.equal(page.loads.length, loadsBefore + 1);
  assert.equal(page.webContents.debugger.attached, true);
  assert.ok(page.webContents.debugger.commands.includes("Fetch.enable"), "重新开启发送拦截");
  adapter.dispose();
});

test("页面崩溃时正在发送：先等发送结束（有上限），不重发", async () => {
  const page = fakePage();
  const { adapter, clock } = await loggedIn(page);
  page.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  clock.advance(2000);
  adapter.sending = true;
  const before = page.loads.length;
  adapter.healthTick(page);
  assert.equal(page.loads.length, before);
  adapter.sending = false;
  adapter.healthTick(page);
  assert.equal(page.loads.length, before + 1);
  // 上限：发送一直不结束也会恢复
  page.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  clock.advance(2000);
  adapter.sending = true;
  adapter.healthTick(page);
  clock.advance(30_000);
  adapter.healthTick(page);
  assert.equal(page.loads.length, before + 2);
  adapter.sending = false;
  adapter.dispose();
});

test("页面无响应超过宽限期：结束渲染进程，之后按崩溃恢复", async () => {
  const page = fakePage();
  const { adapter, clock } = await loggedIn(page);
  page.webContents.emit("unresponsive");
  adapter.healthTick(page);
  assert.equal(page.webContents.crashes, 0);
  clock.advance(30_000);
  adapter.healthTick(page);
  assert.equal(page.webContents.crashes, 1);
  adapter.healthTick(page);
  assert.equal(page.webContents.crashes, 1, "不重复结束");
  adapter.dispose();
});

test("跳到登录页：标记登录失效；人工重新加载在发送中被拒绝", async () => {
  const page = fakePage();
  const { adapter } = await loggedIn(page);
  adapter.tracker.active = { mall_id: "1", mall_name: "虚构" };
  page.webContents.emit("did-navigate", {}, "https://mms.pinduoduo.com/login/");
  assert.equal(adapter.status().page.session_lost, true);
  adapter.sending = true;
  assert.equal(adapter.reloadPage(), "pdd_send_busy");
  adapter.sending = false;
  const before = page.loads.length;
  assert.equal(adapter.reloadPage(), null);
  assert.equal(page.loads.length, before + 1);
  adapter.dispose();
  assert.equal(adapter.reloadPage(), "platform_window_closed");
});

test("调试通道已附加时，开始加载不会重复附加或重复开启拦截", async () => {
  const page = fakePage();
  const { adapter } = await loggedIn(page);
  const dbg = page.webContents.debugger;
  assert.equal(dbg.attaches, 1);
  const fetchEnables = dbg.commands.filter((c) => c === "Fetch.enable").length;
  page.webContents.emit("did-start-loading");
  assert.equal(dbg.attaches, 1);
  assert.equal(dbg.commands.filter((c) => c === "Fetch.enable").length, fetchEnables);
  adapter.dispose();
});
