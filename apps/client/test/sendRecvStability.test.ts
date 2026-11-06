import assert from "node:assert/strict";
import Module from "node:module";
import { test } from "node:test";

const req = Module.createRequire(__filename), electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: {} } } as unknown as NodeModule;
const { classifyTransferCleanup, nextOpenRetryDelay, OPEN_CONVERSATION_WAIT_MAX_MS } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

test("收尾分类：页面变化优先于会话变化与残留", () => {
  assert.equal(classifyTransferCleanup({ bound: false, conversationMatched: false, leftovers: { dialogs: 1, popovers: 1 } }), "page_changed");
});

test("收尾分类：绑定仍在但当前会话变了", () => {
  assert.equal(classifyTransferCleanup({ bound: true, conversationMatched: false, leftovers: { dialogs: 0, popovers: 0 } }), "conversation_changed");
});

test("收尾分类：弹窗残留与浮层残留分开记录", () => {
  assert.equal(classifyTransferCleanup({ bound: true, conversationMatched: true, leftovers: { dialogs: 1, popovers: 0 } }), "dialog_left");
  assert.equal(classifyTransferCleanup({ bound: true, conversationMatched: true, leftovers: { dialogs: 0, popovers: 1 } }), "popover_left");
});

test("收尾分类：读不到残留信息时归为不可读，不猜成已关闭", () => {
  assert.equal(classifyTransferCleanup({ bound: true, conversationMatched: true, leftovers: "unavailable" }), "unavailable");
  assert.equal(classifyTransferCleanup({ bound: true, conversationMatched: true, leftovers: "script_failed" }), "unavailable");
});

test("收尾分类：全部清干净才算 closed", () => {
  assert.equal(classifyTransferCleanup({ bound: true, conversationMatched: true, leftovers: { dialogs: 0, popovers: 0 } }), "closed");
});

test("未读会话退避：2s 起、指数增长、30s 封顶", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(nextOpenRetryDelay), [2000, 4000, 8000, 16000, 30000]);
  assert.equal(nextOpenRetryDelay(99), 30000);
  assert.equal(nextOpenRetryDelay(0), 2000);
});

test("找会话等待上限为 4 秒", () => {
  assert.equal(OPEN_CONVERSATION_WAIT_MAX_MS, 4000);
});
