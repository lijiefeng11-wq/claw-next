import assert from "node:assert/strict";
import Module from "node:module";
import { test } from "node:test";

const req = Module.createRequire(__filename), electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: {} } } as unknown as NodeModule;
const { PddPageAdapter } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

test("真实文字适配器准备结束后再检查时限，过期不点击并清除本次输入", async () => {
  const adapter = new PddPageAdapter("fictional", "虚构") as any;
  let clicks = 0, clears = 0, checked = 0;
  adapter.window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, debugger: { isAttached: () => true, sendCommand: async () => { clicks++; } } } };
  adapter.tracker = { status: () => ({ logged_in: true }) };
  adapter.openConversation = async () => null;
  adapter.run = async (script: string) => script.includes('return "filled"') ? "filled" : { x: 10, y: 10 };
  adapter.clearInput = async () => { clears++; };
  const result = await adapter.send({ conversation_id: "9001", text: "虚构回复", attempt_id: "fixture-attempt", deadline: Date.now() / 1000 + 8, recheck: () => { checked++; return "reply_deadline_exceeded"; } });
  assert.deepEqual(result, { status: "not_sent", reason: "reply_deadline_exceeded" });
  assert.equal(checked, 1); assert.equal(clicks, 0); assert.equal(clears, 1);
});

test("准备期间页面尺寸/代次变化：不点击，清除本次输入", async () => {
  const adapter = new PddPageAdapter("fictional", "虚构") as any;
  let clicks = 0;
  adapter.window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, debugger: { isAttached: () => true, sendCommand: async () => { clicks++; } } } };
  adapter.tracker = { status: () => ({ logged_in: true }) };
  adapter.openConversation = async () => null;
  adapter.run = async (script: string) => {
    if (script.includes('return "filled"')) return "filled";
    adapter.watchEpoch++;
    return { x: 10, y: 10 };
  };
  adapter.clearInput = async () => undefined;
  assert.deepEqual(await adapter.send({ conversation_id: "9001", text: "虚构回复", attempt_id: "fixture-attempt", deadline: Date.now() / 1000 + 8, recheck: () => null }), { status: "not_sent", reason: "pdd_page_changed" });
  assert.equal(clicks, 0);
});

test("按下发送命令拒绝：保留 unknown，不补发松开或重试", async () => {
  const adapter = new PddPageAdapter("fictional", "虚构") as any;
  const commands: string[] = [];
  adapter.window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, debugger: { isAttached: () => true, sendCommand: async (_m: string, p: { type: string }) => { commands.push(p.type); throw new Error("lost reply"); } } } };
  adapter.tracker = { status: () => ({ logged_in: true }) };
  adapter.openConversation = async () => null;
  adapter.run = async (s: string) => s.includes('return "filled"') ? "filled" : { x: 12.5, y: 10 };
  adapter.clearInput = async () => assert.fail("uncertain press must not clear input");
  assert.deepEqual(await adapter.send({ conversation_id: "9001", text: "虚构回复", attempt_id: "fixture-attempt", deadline: Date.now() / 1000 + 8, recheck: () => null }), { status: "unknown", reason: "press_command_rejected" });
  assert.deepEqual(commands, ["mousePressed"]);
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
