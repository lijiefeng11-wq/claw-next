import assert from "node:assert/strict";
import Module from "node:module";
import { test } from "node:test";

const req = Module.createRequire(__filename);
const electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: {} } } as unknown as NodeModule;
const { PddPageAdapter } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

test("扫描读取后发送开始：保留已观察的新消息标记，空闲后仍刷新一次", async () => {
  const adapter = new PddPageAdapter("fixture", "虚构") as any;
  let reads = 0, pending = 0, reloads = 0;
  adapter.window = { isDestroyed: () => false, webContents: { getURL: () => "https://mms.pinduoduo.com/chat-merchant/index.html" } };
  adapter.tracker = { status: () => ({ logged_in: true }) };
  adapter.messageWatcher = { scheduler: { request: () => { pending++; }, resume: () => {} } };
  adapter.lastActiveUid = "9001";
  adapter.run = async () => {
    reads++;
    if (reads === 1) adapter.sending = true;
    return { items: [{ key: "9001-x", active: true, unread: false }], freshBuyer: reads === 1 };
  };
  adapter.reload = () => { reloads++; };
  await adapter.watch(); assert.equal(pending, 1); assert.equal(reloads, 0);
  adapter.sending = false; await adapter.watch(); assert.equal(reloads, 1);
  await adapter.watch(); assert.equal(reloads, 1);
});

test("旧页面扫描晚返回，不据此切换新页面的会话", async () => {
  const adapter = new PddPageAdapter("fixture", "虚构") as any;
  let clicks = 0;
  adapter.window = { isDestroyed: () => false, webContents: { getURL: () => "https://mms.pinduoduo.com/chat-merchant/index.html" } };
  adapter.tracker = { status: () => ({ logged_in: true }) };
  adapter.run = async () => { adapter.watchEpoch++; return { items: [{ key: "9001-x", active: false, unread: true }], freshBuyer: false }; };
  adapter.clickConversation = async () => { clicks++; return true; };
  await adapter.watch(); assert.equal(clicks, 0);
});
