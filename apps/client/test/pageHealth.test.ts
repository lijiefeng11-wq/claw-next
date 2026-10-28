import assert from "node:assert/strict";
import { test } from "node:test";
import { PageHealth, shopAlert } from "../src/core/pageHealth.js";

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("正常加载：没有动作，状态为正常", () => {
  const c = clock();
  const h = new PageHealth({ now: c.now });
  assert.equal(h.view().state, "loading");
  h.loadFinished();
  assert.equal(h.view().state, "ok");
  c.advance(60_000);
  assert.equal(h.decide(false), "none");
});

test("崩溃：等进程退出后重载；发送中先等待", () => {
  const c = clock();
  const h = new PageHealth({ now: c.now, crashDelayMs: 2000 });
  h.loadFinished();
  h.crashed();
  assert.equal(h.decide(false), "none", "刚崩溃不立即重载");
  c.advance(2000);
  assert.equal(h.decide(true), "wait", "发送中先等待");
  assert.equal(h.decide(false), "reload");
  h.acted("reload");
  assert.equal(h.view().state, "loading");
  assert.equal(h.view().reloads, 1);
  h.loadFinished();
  assert.equal(h.view().state, "ok");
});

test("发送中等待有上限：崩溃页面上的脚本可能永不返回", () => {
  const c = clock();
  const h = new PageHealth({ now: c.now, crashDelayMs: 0, maxBusyWaitMs: 30_000 });
  h.crashed();
  assert.equal(h.decide(true), "wait");
  c.advance(29_999);
  assert.equal(h.decide(true), "wait");
  c.advance(1);
  assert.equal(h.decide(true), "reload");
});

test("10 分钟内自动恢复 3 次后放弃，并在提醒里要求人工处理", () => {
  const c = clock();
  const h = new PageHealth({ now: c.now, crashDelayMs: 0, maxReloads: 3, windowMs: 600_000 });
  for (let i = 0; i < 3; i++) {
    h.crashed();
    assert.equal(h.decide(false), "reload");
    h.acted("reload");
    h.loadFinished();
    c.advance(1000);
  }
  h.crashed();
  assert.equal(h.decide(false), "none");
  const v = h.view();
  assert.equal(v.gave_up, true);
  assert.match(v.detail, /人工/);
  assert.deepEqual(shopAlert({ adapter: "pdd", pageOpen: true, logged_in: false, page: v }), { level: "error", text: "平台页面异常，自动恢复失败" });
  // 人工重载清除放弃状态。
  h.resetGiveUp();
  assert.equal(h.decide(false), "reload");
});

test("统计窗口过后，次数重新计算", () => {
  const c = clock();
  const h = new PageHealth({ now: c.now, crashDelayMs: 0, maxReloads: 1, windowMs: 60_000 });
  h.crashed();
  assert.equal(h.decide(false), "reload");
  h.acted("reload");
  h.loadFinished();
  c.advance(61_000);
  h.crashed();
  assert.equal(h.decide(false), "reload");
});

test("无响应：宽限期内不动作，超时后结束渲染进程，随后的崩溃重载不重复计数", () => {
  const c = clock();
  const h = new PageHealth({ now: c.now, unresponsiveGraceMs: 30_000, crashDelayMs: 0 });
  h.loadFinished();
  h.unresponsive();
  assert.equal(h.decide(false), "none");
  c.advance(10_000);
  h.responsive();
  assert.equal(h.view().state, "ok", "短暂卡顿后恢复");
  h.unresponsive();
  c.advance(30_000);
  assert.equal(h.decide(true), "wait");
  assert.equal(h.decide(false), "kill");
  h.acted("kill");
  assert.equal(h.decide(false), "none", "已结束进程，等待崩溃事件");
  h.crashed();
  assert.equal(h.decide(false), "reload");
  h.acted("reload");
  assert.equal(h.view().reloads, 1, "一次卡死只计一次");
});

test("加载失败（网络）：间隔重试，不计入崩溃次数，也不会放弃", () => {
  const c = clock();
  const h = new PageHealth({ now: c.now, loadRetryMs: 15_000, maxReloads: 1 });
  for (let i = 0; i < 5; i++) {
    h.loadFailed();
    assert.equal(h.decide(false), "none");
    c.advance(15_000);
    assert.equal(h.decide(false), "reload");
    h.acted("reload");
  }
  assert.equal(h.view().reloads, 0);
  assert.equal(h.view().gave_up, false);
});

test("提醒：只对打开着页面的拼多多店铺；用户主动关闭或模拟店铺不提醒", () => {
  const c = clock();
  const h = new PageHealth({ now: c.now });
  h.loadFinished();
  const ok = h.view();
  assert.equal(shopAlert({ adapter: "pdd", pageOpen: true, logged_in: true, page: ok }), null);
  assert.equal(shopAlert({ adapter: "pdd", pageOpen: true, logged_in: false, page: ok }), null, "从未登录过：等待扫码，不算掉线");
  h.sessionStarted();
  h.sessionEnded(false);
  assert.deepEqual(shopAlert({ adapter: "pdd", pageOpen: true, logged_in: false, page: h.view() }), { level: "error", text: "平台登录已失效，请重新扫码" });
  h.sessionStarted();
  assert.equal(shopAlert({ adapter: "pdd", pageOpen: true, logged_in: true, page: h.view() }), null, "重新登录后提醒消失");
  h.crashed();
  assert.equal(shopAlert({ adapter: "pdd", pageOpen: false, logged_in: false, page: null }), null);
  assert.equal(shopAlert({ adapter: "mock", pageOpen: true, logged_in: false, page: h.view() }), null);
  assert.equal(shopAlert({ adapter: "pdd", pageOpen: true, logged_in: false, page: h.view() })?.text, "平台页面崩溃，正在恢复");
});

/** 一轮“无响应 → 结束进程 → 崩溃 → 重载 → 加载完成”，返回各步动作。 */
function hangCycle(h: PageHealth, c: ReturnType<typeof clock>) {
  const actions: string[] = [];
  h.unresponsive();
  c.advance(60_000);
  const kill = h.decide(false);
  actions.push(kill);
  if (kill !== "kill") return actions;
  h.acted("kill");
  h.crashed();
  c.advance(2000);
  const reload = h.decide(false);
  actions.push(reload);
  if (reload === "reload") {
    h.acted("reload");
    h.loadFinished();
  }
  return actions;
}

test("连续三轮无响应：每轮结束进程后都完成重载，第四轮才放弃", () => {
  const c = clock();
  const h = new PageHealth({ now: c.now, crashDelayMs: 2000, maxReloads: 3, windowMs: 3_600_000 });
  h.loadFinished();
  for (let i = 1; i <= 3; i++) {
    assert.deepEqual(hangCycle(h, c), ["kill", "reload"], `第 ${i} 轮`);
    assert.equal(h.view().reloads, i);
    assert.equal(h.view().gave_up, false);
  }
  assert.deepEqual(hangCycle(h, c), ["none"]);
  assert.equal(h.view().gave_up, true);
  assert.equal(h.view().reloads, 3);
});

test("maxReloads=1：第一次结束进程后仍完成重载，下一次异常才放弃", () => {
  const c = clock();
  const h = new PageHealth({ now: c.now, crashDelayMs: 2000, maxReloads: 1, windowMs: 3_600_000 });
  h.loadFinished();
  assert.deepEqual(hangCycle(h, c), ["kill", "reload"]);
  assert.equal(h.view().reloads, 1);
  h.crashed();
  c.advance(2000);
  assert.equal(h.decide(false), "none");
  assert.equal(h.view().gave_up, true);
});

test("非本模块结束的崩溃仍受次数门禁", () => {
  const c = clock();
  const h = new PageHealth({ now: c.now, crashDelayMs: 0, maxReloads: 1, windowMs: 3_600_000 });
  h.loadFinished();
  h.crashed();
  assert.equal(h.decide(false), "reload");
  h.acted("reload");
  h.loadFinished();
  h.crashed();
  assert.equal(h.decide(false), "none");
  assert.equal(h.view().gave_up, true);
});
