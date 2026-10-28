import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import Module from "node:module";
import { describe, test } from "node:test";

// 用 Electron 替身实例化真实的 PddPageAdapter，只检查弹窗清理的调度与互斥；页面脚本的实际效果由界面端到端测试在虚构页面上验证。
const req = Module.createRequire(__filename);
const electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: { fromPartition: () => ({}) } } } as unknown as NodeModule;
const { PddPageAdapter, POPUP_SWEEP_START_MS, POPUP_SWEEP_STUCK_MS } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");
const { popupSweepScript, AUTO_DISMISS_LABELS, MANUAL_DISMISS_LABELS } = req("../src/main/pddPopups.js") as typeof import("../src/main/pddPopups.js");

type Result = { dismissed: { label: string; layer: string }[]; seen: { layer: string; title: string | null; why: string }[]; expired?: boolean };

function harness() {
  const adapter = new PddPageAdapter("shop-x", "虚构店铺") as any;
  const calls: string[] = [];
  let pending: ((r: Result | null) => void)[] = [];
  const webContents = Object.assign(new EventEmitter(), {
    reloads: 0,
    isDestroyed: () => false,
    isLoadingMainFrame: (): boolean => false,
    getURL: () => "https://mms.pinduoduo.com/chat-merchant/index.html",
    reload() { this.reloads++; },
    executeJavaScriptInIsolatedWorld: (_world: number, [{ code }]: { code: string }[]) => {
      calls.push(code.includes("__clawPopups") ? (code.includes('"manual"') ? "sweep:manual" : "sweep:auto") : "other");
      return new Promise((resolve) => pending.push(resolve));
    },
  });
  const win = { isDestroyed: () => false, webContents };
  adapter.window = win;
  adapter.tracker = { status: () => ({ logged_in: true }) };
  const settle = (r: Result | null) => { const p = pending; pending = []; for (const f of p) f(r); };
  return { adapter, win, calls, settle, pendingCount: () => pending.length };
}
const none: Result = { dismissed: [], seen: [] };
const one: Result = { dismissed: [{ label: "我知道了", layer: "div.guide-pop" }], seen: [] };
const tick = () => new Promise((r) => setImmediate(r));

describe("平台引导弹窗清理", () => {
  test("自动与手动脚本都能解析；自动不点“关闭 / 取消”", () => {
    for (const mode of ["auto", "manual"] as const) assert.doesNotThrow(() => new Function(popupSweepScript(mode, Date.now())));
    assert.throws(() => popupSweepScript("auto", NaN));
    const labels = (mode: "auto" | "manual") => JSON.parse(/const LABELS = new Set\((\[.*?\])\);/.exec(popupSweepScript(mode, 0))![1]) as string[];
    assert.deepEqual(labels("auto"), [...AUTO_DISMISS_LABELS]);
    for (const label of MANUAL_DISMISS_LABELS) assert.ok(!labels("auto").includes(label), `自动清理不应点“${label}”`);
    assert.deepEqual(labels("manual"), [...AUTO_DISMISS_LABELS, ...MANUAL_DISMISS_LABELS]);
  });

  test("自动清理：发送、待确认发送、预热进行中或未登录时不执行", () => {
    const { adapter, win, calls } = harness();
    for (const setup of [() => (adapter.sending = true), () => (adapter.outgoing = {}), () => (adapter.warmRun = {}), () => (adapter.tracker = { status: () => ({ logged_in: false }) })]) {
      const saved = { sending: adapter.sending, outgoing: adapter.outgoing, warmRun: adapter.warmRun, tracker: adapter.tracker };
      setup();
      adapter.autoPopups(win);
      Object.assign(adapter, saved);
    }
    assert.deepEqual(calls, []);
    adapter.autoPopups(win);
    adapter.autoPopups(win); // 上一次未结束，不并发
    assert.deepEqual(calls, ["sweep:auto"]);
  });

  test("发送开始前等进行中的清理结束；清理关掉浮层时页面代次加一", async () => {
    const { adapter, win, calls, settle } = harness();
    adapter.autoPopups(win);
    const epoch = adapter.watchEpoch;
    let yielded = false;
    const waiting = adapter.yieldWarm().then(() => (yielded = true));
    await tick();
    assert.equal(yielded, false, "清理未结束时发送不应开始");
    settle(one);
    await waiting;
    assert.equal(yielded, true);
    assert.equal(adapter.popupSweep, null);
    assert.equal(adapter.watchEpoch, epoch + 1);
    assert.deepEqual(calls, ["sweep:auto"]);
  });

  test("清理脚本迟迟不结束：发送一直等，不按超时放行；页面导航后过了点击时限才解除", async () => {
    const { adapter, win } = harness();
    adapter.autoPopups(win);
    const started = Date.now();
    let yielded = false;
    const waiting = adapter.yieldWarm().then(() => (yielded = true));
    await new Promise((r) => setTimeout(r, POPUP_SWEEP_START_MS + 300));
    assert.equal(yielded, false, "超过点击时限仍未结束的清理不应放行发送");
    win.webContents.emit("did-navigate");
    await waiting;
    assert.ok(Date.now() - started >= POPUP_SWEEP_START_MS);
    assert.equal(adapter.popupSweep, null);
    assert.equal(win.webContents.listenerCount("did-navigate"), 0, "结束后移除页面事件监听");
  });

  test("渲染进程退出：等到点击时限之后再解除", async () => {
    const { adapter, win } = harness();
    adapter.autoPopups(win);
    const started = Date.now();
    win.webContents.emit("render-process-gone");
    await adapter.yieldWarm();
    const waited = Date.now() - started;
    assert.ok(waited >= POPUP_SWEEP_START_MS && waited < POPUP_SWEEP_START_MS + 1500, `等待 ${waited} ms`);
  });

  test("清理卡住超过时限：重新加载平台页面，由导航结束它", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { adapter, win } = harness();
    adapter.autoPopups(win);
    t.mock.timers.tick(POPUP_SWEEP_STUCK_MS - 1);
    assert.equal(win.webContents.reloads, 0);
    t.mock.timers.tick(1);
    assert.equal(win.webContents.reloads, 1);
  });

  test("脚本过了点击时限才执行：返回 expired，不点击、页面代次不变", async () => {
    const { adapter, win, settle } = harness();
    const epoch = adapter.watchEpoch;
    const run = adapter.sweepPopupsOnce(win, "auto");
    await tick();
    settle({ dismissed: [], seen: [], expired: true });
    assert.deepEqual(await run, { dismissed: [], seen: [], expired: true });
    assert.equal(adapter.watchEpoch, epoch);
  });

  test("页面正在加载时不提交清理脚本", async () => {
    const { adapter, win, calls } = harness();
    win.webContents.isLoadingMainFrame = () => true;
    assert.equal(await adapter.sweepPopupsOnce(win, "manual"), null);
    assert.deepEqual(calls, []);
    assert.equal(adapter.popupSweep, null);
  });

  test("跳过的浮层同一签名只记一次日志", async () => {
    const { adapter, win, settle } = harness();
    const logs: string[] = [];
    const log = console.log;
    console.log = (line: string) => logs.push(String(line));
    try {
      for (let i = 0; i < 3; i++) {
        adapter.autoPopups(win);
        await tick();
        settle({ dismissed: [], seen: [{ layer: "div.notice", title: "违规提醒", why: "risky" }] });
        await adapter.popupIdle();
      }
    } finally {
      console.log = log;
    }
    assert.equal(logs.filter((l) => l.includes("platform popup kept")).length, 1);
  });

  test("人工清理：连清到没有可关的浮层为止；发送中返回忙；页面未打开返回未打开", async () => {
    const { adapter, calls, settle, pendingCount } = harness();
    const run = adapter.dismissPopups();
    for (const r of [one, one, none]) {
      while (!pendingCount()) await new Promise((res) => setTimeout(res, 20));
      settle(r);
    }
    assert.deepEqual(await run, { dismissed: 2 });
    assert.deepEqual(calls, ["sweep:manual", "sweep:manual", "sweep:manual"]);
    adapter.sending = true;
    assert.deepEqual(await adapter.dismissPopups(), { blocked: "pdd_send_busy" });
    adapter.sending = false;
    adapter.window = null;
    assert.deepEqual(await adapter.dismissPopups(), { blocked: "platform_window_closed" });
  });

  test("人工清理两轮之间发送开始：立即停止", async () => {
    const { adapter, calls, settle, pendingCount } = harness();
    const run = adapter.dismissPopups();
    while (!pendingCount()) await new Promise((res) => setTimeout(res, 20));
    settle(one);
    await tick();
    adapter.sending = true;
    assert.deepEqual(await run, { dismissed: 1 });
    assert.deepEqual(calls, ["sweep:manual"]);
  });
});
