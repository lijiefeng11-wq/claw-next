import assert from "node:assert/strict";
import Module from "node:module";
import { test } from "node:test";

const req = Module.createRequire(__filename), electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: {} } } as unknown as NodeModule;
const { PddPageAdapter } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

function fixture() {
  const adapter = new PddPageAdapter("fictional", "虚构") as any;
  adapter.window = { isDestroyed: () => false, webContents: { isDestroyed: () => false } };
  adapter.tracker = { status: () => ({ logged_in: true }) };
  adapter.openConversation = async () => null;
  return adapter;
}

// Adapter wiring tests; actual Playwright input failures are exercised in the Electron fixture.
test("发送引擎收到最新时限核验，过期零点击并清除本次输入", async () => {
  const adapter = fixture(); let calls = 0, clears = 0, checked = 0;
  adapter.clickText = async (_wc: unknown, _uid: string, _text: string, _until: number, check: () => string | null, _clicked: unknown, filled: () => void) => {
    calls++; filled(); return { status: "not_sent", reason: check() };
  };
  adapter.clearInput = async () => { clears++; };
  const result = await adapter.send({ conversation_id: "9001", text: "虚构回复", attempt_id: "fixture", deadline: Date.now() / 1000 + 8, recheck: () => { checked++; return "reply_deadline_exceeded"; } });
  assert.deepEqual(result, { status: "not_sent", reason: "reply_deadline_exceeded" });
  assert.equal(checked, 1); assert.equal(calls, 1); assert.equal(clears, 1);
});

test("发送引擎准备期间页面代次变化：核验立即阻止点击", async () => {
  const adapter = fixture(); let clears = 0;
  adapter.clickText = async (_wc: unknown, _uid: string, _text: string, _until: number, check: () => string | null) => {
    adapter.watchEpoch++; return { status: "not_sent", reason: check() };
  };
  adapter.clearInput = async () => { clears++; };
  assert.deepEqual(await adapter.send({ conversation_id: "9001", text: "虚构回复", attempt_id: "fixture", deadline: Date.now() / 1000 + 8 }), { status: "not_sent", reason: "pdd_page_changed" });
  assert.equal(clears, 0, "页面代次失效后不向新页面写入"); assert.equal(adapter.sending, false);
});

test("发送引擎返回unknown：适配器不再调用引擎或清除可能已发送的文本", async () => {
  const adapter = fixture(); let calls = 0;
  adapter.clickText = async () => { calls++; return { status: "unknown", reason: "pdd_playwright_click_uncertain" }; };
  adapter.clearInput = async () => assert.fail("unknown must preserve input");
  assert.deepEqual(await adapter.send({ conversation_id: "9001", text: "虚构回复", attempt_id: "fixture", deadline: Date.now() / 1000 + 8 }), { status: "unknown", reason: "pdd_playwright_click_uncertain" });
  assert.equal(calls, 1); assert.equal(adapter.sending, false); assert.equal(adapter.outgoing, null);
});

test("已点击但未观察到平台请求：保留输入与unknown，不再次点击", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = fixture(); let calls = 0;
  adapter.clickText = async (_wc: unknown, _uid: string, _text: string, _until: number, _check: unknown, clicked: (pressed: boolean) => void) => {
    calls++; clicked(true); return { status: "dispatched" };
  };
  adapter.clearInput = async () => assert.fail("点击后的未知结果不能清除输入");
  const sending = adapter.send({ conversation_id: "9001", text: "虚构回复", attempt_id: "fixture", deadline: Date.now() / 1000 + 10 });
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(8000);
  assert.deepEqual(await sending, { status: "unknown", reason: "pdd_send_request_not_observed" });
  assert.equal(calls, 1); assert.equal(adapter.sending, false);
});

test("准备正好到达1500ms余量边界：按到期返回并释放忙碌", async (t) => {
  let now = 10_000, clears = 0;
  t.mock.method(Date, "now", () => now);
  const adapter = fixture();
  adapter.clickText = async (_wc: unknown, _uid: string, _text: string, _until: number, check: () => string | null, _clicked: unknown, filled: () => void) => {
    filled(); now = 10_201; return { status: "not_sent", reason: check() };
  };
  adapter.clearInput = async () => { clears++; };
  assert.deepEqual(await adapter.send({ conversation_id: "9001", text: "虚构回复", attempt_id: "fixture", deadline: 11.7 }), { status: "not_sent", reason: "claim_expiring" });
  assert.equal(clears, 1); assert.equal(adapter.sending, false); assert.equal(adapter.outgoing, null);
});

test("非发送按钮定位等待中页面变化：旧坐标不得点击新的页面", async () => {
  for (const change of ["resize", "replace"]) {
    const adapter = new PddPageAdapter("fictional", "虚构") as any;
    let commands = 0;
    const page = () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, debugger: { isAttached: () => true, sendCommand: async () => { commands++; } } } });
    adapter.window = page();
    adapter.run = async () => {
      if (change === "resize") adapter.watchEpoch++; else adapter.window = page();
      return { x: 10, y: 10 };
    };
    assert.equal(await adapter.openVideoPanel(), "pdd_page_changed");
    assert.equal(commands, 0);
  }
});
