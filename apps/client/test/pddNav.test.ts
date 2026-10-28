import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import Module from "node:module";
import { describe, test } from "node:test";

// 用 Electron 替身实例化真实的 PddPageAdapter，检查“后退 / 回到会话”的判断与导航；按钮呈现由界面端到端测试覆盖。
const req = Module.createRequire(__filename);
const electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: { fromPartition: () => ({}) } } } as unknown as NodeModule;
const { PddPageAdapter } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

const CHAT = "https://mms.pinduoduo.com/chat-merchant/index.html";
const LOGIN = "https://mms.pinduoduo.com/login/?redirectUrl=x";
const AFTER_SALE = "https://mms.pinduoduo.com/aftersales/aftersale_list/detail?id=1";
const AFTER_SALE_LIST = "https://mms.pinduoduo.com/aftersales/aftersale_list";

function harness(urls: string[], active = urls.length - 1) {
  const adapter = new PddPageAdapter("shop-x", "虚构店铺") as any;
  const log: string[] = [];
  const history = {
    entries: urls.slice(),
    index: active,
    getActiveIndex() { return this.index; },
    getEntryAtIndex(i: number) { return { url: this.entries[i], title: "" }; },
    canGoBack() { return this.index > 0; },
    goBack() { log.push("goBack"); this.index--; },
  };
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getURL: () => history.entries[history.index],
    navigationHistory: history,
    debugger: { isAttached: () => true },
  });
  const win = { isDestroyed: () => false, webContents, loadURL: (url: string) => { log.push(`load ${url}`); return Promise.resolve(); } };
  adapter.window = win;
  adapter.tracker = { status: () => ({ logged_in: true, detail: "已登录" }), end() {} };
  const events: string[] = [];
  adapter.onEvent((e: { type: string }) => events.push(e.type));
  return { adapter, win, log, history, events };
}

describe("平台页面后退 / 回到会话", () => {
  test("在会话页：不提供后退（即使有更早的记录，可能是登录页）", () => {
    const { adapter } = harness([LOGIN, CHAT]);
    assert.deepEqual(adapter.status().nav, { on_chat: true, can_go_back: false });
  });

  test("离开会话页：上一条是平台页面才可后退；登录页、非平台页面、没有记录都不可后退", () => {
    assert.deepEqual(harness([CHAT, AFTER_SALE]).adapter.status().nav, { on_chat: false, can_go_back: true });
    assert.deepEqual(harness([CHAT, AFTER_SALE_LIST, AFTER_SALE]).adapter.status().nav, { on_chat: false, can_go_back: true });
    assert.deepEqual(harness([LOGIN, AFTER_SALE]).adapter.status().nav, { on_chat: false, can_go_back: false });
    assert.deepEqual(harness(["about:blank", AFTER_SALE]).adapter.status().nav, { on_chat: false, can_go_back: false });
    assert.deepEqual(harness(["http://mms.pinduoduo.com/chat-merchant/index.html", AFTER_SALE]).adapter.status().nav, { on_chat: false, can_go_back: false });
    assert.deepEqual(harness([AFTER_SALE]).adapter.status().nav, { on_chat: false, can_go_back: false });
    const broken = harness([CHAT, AFTER_SALE]);
    broken.history.getActiveIndex = () => { throw new Error("destroyed"); };
    assert.deepEqual(broken.adapter.status().nav, { on_chat: false, can_go_back: false });
  });

  test("后退：退一步，页面代次加一、当前对话与离开会话页计时清空", () => {
    const { adapter, log } = harness([CHAT, AFTER_SALE_LIST, AFTER_SALE]);
    adapter.lastActiveUid = "buyer-1";
    adapter.offChatSince = Date.now();
    const epoch = adapter.watchEpoch;
    assert.equal(adapter.navigatePlatform("back"), null);
    assert.deepEqual(log, ["goBack"]);
    assert.equal(adapter.watchEpoch, epoch + 1);
    assert.equal(adapter.lastActiveUid, null);
    assert.equal(adapter.offChatSince, 0);
  });

  test("回到会话：离开会话页时载入会话页；已在会话页时什么都不做", () => {
    const off = harness([CHAT, AFTER_SALE]);
    const epoch = off.adapter.watchEpoch;
    assert.equal(off.adapter.navigatePlatform("chat"), null);
    assert.deepEqual(off.log, [`load ${CHAT}`]);
    assert.equal(off.adapter.watchEpoch, epoch + 1);
    const on = harness([CHAT]);
    assert.equal(on.adapter.navigatePlatform("chat"), null);
    assert.deepEqual(on.log, []);
    assert.equal(on.adapter.watchEpoch, epoch);
  });

  test("拒绝：发送或待确认发送进行中、页面未打开、不可后退时不导航", () => {
    const busy = harness([CHAT, AFTER_SALE]);
    busy.adapter.sending = true;
    assert.equal(busy.adapter.navigatePlatform("chat"), "pdd_send_busy");
    busy.adapter.sending = false;
    busy.adapter.outgoing = {};
    assert.equal(busy.adapter.navigatePlatform("back"), "pdd_send_busy");
    assert.deepEqual(busy.log, []);
    const noHistory = harness([LOGIN, AFTER_SALE]);
    assert.equal(noHistory.adapter.navigatePlatform("back"), "platform_no_history");
    assert.deepEqual(noHistory.log, []);
    const closed = harness([CHAT, AFTER_SALE]);
    closed.adapter.window = null;
    assert.equal(closed.adapter.navigatePlatform("chat"), "platform_window_closed");
    closed.adapter.window = { isDestroyed: () => true };
    assert.equal(closed.adapter.navigatePlatform("back"), "platform_window_closed");
    assert.deepEqual(closed.log, []);
  });

  test("页面导航后：导航状态变化才通知界面；不是当前页面的导航忽略", () => {
    const { adapter, win, history, events } = harness([CHAT, AFTER_SALE]);
    adapter.noteNav(win);
    adapter.noteNav(win);
    assert.deepEqual(events, ["status"]);
    history.index = 0;
    adapter.noteNav(win);
    adapter.noteNav(win);
    assert.deepEqual(events, ["status", "status"]);
    history.index = 1;
    adapter.noteNav({ ...win });
    assert.deepEqual(events, ["status", "status"]);
  });
});
