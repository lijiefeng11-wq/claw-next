import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { WebContents } from "electron";
import { messageObserverScript, PddMessageWatcher, ScanScheduler } from "../src/main/pddMessageWatcher.js";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("通知和兜底合并，50 ms 开始扫描；连续通知不延后", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0;
  const scan = new ScanScheduler(async () => { calls++; }, () => false);
  t.after(() => scan.close());
  scan.request();
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(10); scan.request(); }
  assert.equal(calls, 1);
  await settle();
  t.mock.timers.tick(50);
  assert.equal(calls, 2); // 扫描期间的新变化合并为一次补扫。
});

test("扫描超过兜底间隔仍不重入，期间请求只补扫一次", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0;
  let finish!: () => void;
  const scan = new ScanScheduler(async () => { calls++; if (calls === 1) await new Promise<void>((r) => { finish = r; }); }, () => false);
  t.after(() => scan.close());
  scan.request(); t.mock.timers.tick(50);
  for (let i = 0; i < 4; i++) { scan.request(); t.mock.timers.tick(1500); }
  assert.equal(calls, 1);
  finish(); await settle(); t.mock.timers.tick(50); await settle();
  assert.equal(calls, 2);
  t.mock.timers.tick(1500); assert.equal(calls, 2);
});

test("发送期间通知不丢失，退出后仅补一次；关闭后不再扫描", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let blocked = true, calls = 0;
  const scan = new ScanScheduler(async () => { calls++; }, () => blocked);
  for (let i = 0; i < 20; i++) scan.request();
  t.mock.timers.tick(5000); assert.equal(calls, 0);
  blocked = false; scan.resume(); t.mock.timers.tick(50); await settle();
  assert.equal(calls, 1);
  scan.request(); scan.close(); t.mock.timers.tick(5000); assert.equal(calls, 1);
});

function harness() {
  const debuggerEvents = new EventEmitter();
  const calls: { method: string; params: any }[] = [];
  let attached = true, context = 11, scans = 0, changes = 0;
  const dbg = Object.assign(debuggerEvents, {
    isAttached: () => attached,
    sendCommand: async (method: string, params?: any) => {
      calls.push({ method, params });
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: context };
      return {};
    },
  });
  const wc = Object.assign(new EventEmitter(), { debugger: dbg, isDestroyed: () => false, isLoadingMainFrame: () => false });
  const watcher = new PddMessageWatcher(wc as unknown as WebContents, async () => { scans++; }, () => false, () => { changes++; });
  const notify = (id = context, payload = "changed", name = calls.find((c) => c.method === "Runtime.addBinding")?.params.name) => dbg.emit("message", {}, "Runtime.bindingCalled", { executionContextId: id, payload, name });
  return { watcher, wc, dbg, calls, notify, scans: () => scans, changes: () => changes, setContext: (v: number) => { context = v; }, setAttached: (v: boolean) => { attached = v; } };
}

test("绑定仅限指定隔离环境与当前页面，拒绝旧上下文和非固定载荷", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(); t.after(() => h.watcher.close()); await settle();
  const binding = h.calls.find((c) => c.method === "Runtime.addBinding")!;
  assert.ok(binding.params.executionContextName.startsWith("claw-message-watcher-"));
  assert.equal(h.calls.find((c) => c.method === "Page.createIsolatedWorld")?.params.frameId, "main-frame");
  h.notify(999); h.notify(11, "message body"); h.notify(11, "changed", "wrong");
  t.mock.timers.tick(100); assert.equal(h.scans(), 0);
  h.notify(); t.mock.timers.tick(50); await settle(); assert.equal(h.scans(), 1);
  h.wc.emit("did-start-navigation", {}, "https://example.invalid", false, true);
  h.notify(11); t.mock.timers.tick(50); assert.equal(h.scans(), 1);
  h.setContext(12); h.wc.emit("dom-ready"); await settle(); t.mock.timers.tick(50); await settle();
  assert.equal(h.changes(), 1);
  const baseline = h.scans();
  h.notify(11); t.mock.timers.tick(50); assert.equal(h.scans(), baseline);
  h.notify(12); t.mock.timers.tick(50); assert.equal(h.scans(), baseline + 1);
});

test("调试器断开后兜底扫描继续，重连后恢复监听且不重复注册", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(); t.after(() => h.watcher.close()); await settle();
  h.setAttached(false); h.dbg.emit("detach", {}, "test");
  h.notify(); t.mock.timers.tick(100); assert.equal(h.scans(), 0);
  t.mock.timers.tick(1500); t.mock.timers.tick(50); await settle();
  assert.equal(h.scans(), 1);
  assert.equal(h.calls.filter((c) => c.method === "Runtime.addBinding").length, 1);
  h.setAttached(true); h.setContext(22);
  t.mock.timers.tick(1500); await settle(); t.mock.timers.tick(50); await settle();
  assert.equal(h.calls.filter((c) => c.method === "Runtime.addBinding").length, 2);
  t.mock.timers.tick(1500); await settle();
  assert.equal(h.calls.filter((c) => c.method === "Runtime.addBinding").length, 2);
  h.watcher.close(); assert.equal(h.dbg.listenerCount("message"), 0);
});

test("实际生成的监听脚本支持列表替换，忽略无关变化，只发送固定信号", () => {
  const signals: string[] = [];
  let callback!: (records: any[]) => void;
  let installs = 0;
  const observer = class {
    constructor(cb: typeof callback) { callback = cb; installs++; }
    observe() {}
  };
  const scope = { changed: (value: string) => signals.push(value) };
  const run = new Function("globalThis", "MutationObserver", "document", `return ${messageObserverScript("changed")};`);
  run(scope, observer, {}); run(scope, observer, {}); assert.equal(installs, 1);
  const node = (within: boolean, contains: boolean) => ({ nodeType: 1, closest: () => within ? {} : null, querySelector: () => contains ? {} : null });
  callback([{ target: node(false, true), addedNodes: [node(false, false)], removedNodes: [] }]);
  assert.deepEqual(signals, []);
  callback([{ target: node(false, true), addedNodes: [node(true, true)], removedNodes: [node(true, true)] }]);
  callback([{ target: node(true, false), addedNodes: [], removedNodes: [] }]);
  assert.deepEqual(signals, ["changed", "changed"]);
});
