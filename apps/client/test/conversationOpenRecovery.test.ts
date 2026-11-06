import assert from "node:assert/strict";
import Module from "node:module";
import vm from "node:vm";
import { test, type TestContext } from "node:test";

const req = Module.createRequire(__filename), electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: {} } } as unknown as NodeModule;
const { PddPageAdapter } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

function fixture(t: TestContext, appearAfter = 0) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const adapter = new PddPageAdapter("fictional", "虚构") as any;
  adapter.window = { isDestroyed: () => false, webContents: { isDestroyed: () => false } };
  adapter.tracker = { status: () => ({ logged_in: true }) };
  let opens = 0, sends = 0, reads = 0, active = false;
  const row = {
    getAttribute: () => "9001-fictional",
    classList: { contains: () => active },
    querySelector: () => null,
    dispatchEvent: (event: { type: string }) => { if (event.type === "click") { active = true; opens++; } },
  };
  const evaluate = (script: string) => vm.runInNewContext(script, {
    document: { querySelectorAll: () => Date.now() >= 10_000 + appearAfter ? [row] : [] },
    Date, window: {}, MouseEvent: class { constructor(public type: string) {} },
  });
  adapter.run = async (script: string) => {
    reads++;
    return script.includes("const match = (e)") ? evaluate(script) : { items: active ? [{ active: true, key: "9001-fictional" }] : [] };
  };
  adapter.clickText = async () => { sends++; return { status: "not_sent", reason: "fictional_stop_after_preparation" }; };
  const request = () => ({ conversation_id: "9001", text: "虚构回复", attempt_id: "fictional", deadline: Date.now() / 1000 + 8 });
  return { adapter, evaluate, request, counts: () => ({ opens, sends, reads }) };
}

async function finish(t: TestContext, operation: Promise<{ status: string; reason?: string }>, maxMs = 6000): Promise<{ status: string; reason?: string }> {
  let done = false;
  void operation.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i <= maxMs / 100 && !done; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (!done) t.mock.timers.tick(100);
  }
  assert.equal(done, true, "preparation must return within its bounded interval");
  return operation;
}

test("列表晚出现：实际点击脚本只打开一次，然后才进入发送准备", async t => {
  const f = fixture(t, 300);
  const result = await finish(t, f.adapter.send(f.request()));
  assert.equal(result.reason, "fictional_stop_after_preparation");
  assert.deepEqual({ opens: f.counts().opens, sends: f.counts().sends }, { opens: 1, sends: 1 });
  assert.ok(f.counts().reads >= 5);
  assert.equal(f.adapter.sending, false);
});

test("目标一直缺失：按剩余预算有界结束（4 秒上限）、零填入/发送、释放忙碌", async t => {
  const f = fixture(t, Infinity);
  assert.deepEqual(await finish(t, f.adapter.send(f.request())), { status: "not_sent", reason: "pdd_conversation_not_in_list" });
  assert.equal(f.counts().opens, 0); assert.equal(f.counts().sends, 0);
  assert.equal(f.adapter.sending, false);
  // 起点 10_000、准备预算 5_000、截止余量 1_500 → until=15_000；等待上限 4_000 → 14_000 结束。
  assert.ok(Date.now() <= 14_600, `实际 ${Date.now()}`);
  assert.ok(Date.now() >= 13_900, `实际 ${Date.now()}`);
});

test("列表 1.6 秒后出现：仍在预算内完成打开（旧实现 1.5 秒即放弃）", async t => {
  const f = fixture(t, 1600);
  const result = await finish(t, f.adapter.send(f.request()));
  assert.equal(result.reason, "fictional_stop_after_preparation");
  assert.deepEqual({ opens: f.counts().opens, sends: f.counts().sends }, { opens: 1, sends: 1 });
  assert.equal(f.adapter.sending, false);
});

test("已打开的会话：clickConversation 直接返回 true，不产生点击（不能被当作已重新拉取消息）", async t => {
  const f = fixture(t);
  let clicks = 0;
  const activeRow = { getAttribute: () => "9001-fictional", classList: { contains: () => true }, querySelector: () => null, dispatchEvent: () => { clicks += 1; } };
  f.adapter.run = async (script: string) => vm.runInNewContext(script, { document: { querySelectorAll: () => [activeRow] }, Date, window: {}, MouseEvent: class {} });
  assert.equal(await f.adapter.clickConversation("9001"), true);
  assert.equal(clicks, 0);
  assert.equal(f.counts().opens, 0);
});

test("脚本拒绝与挂起分类明确，均不触碰发送按钮", async t => {
  const f = fixture(t);
  f.adapter.run = async () => { throw new Error("fictional-private-error"); };
  assert.equal((await finish(t, f.adapter.send(f.request()))).reason, "pdd_page_script_failed");
  f.adapter.run = () => new Promise(() => {});
  assert.equal((await finish(t, f.adapter.send(f.request()))).reason, "pdd_page_script_timeout");
  assert.equal(f.counts().sends, 0); assert.equal(f.adapter.sending, false);
});

test("等待期间页面代次变化：立即失效，零发送", async t => {
  const f = fixture(t, Infinity);
  const original = f.adapter.run;
  f.adapter.run = async (script: string) => { const r = await original(script); f.adapter.watchEpoch++; return r; };
  assert.equal((await finish(t, f.adapter.send(f.request()))).reason, "pdd_page_changed");
  assert.equal(f.counts().reads, 1); assert.equal(f.counts().sends, 0);
});

test("等待期间授权失效：保持本次拒绝，不打开或发送", async t => {
  const f = fixture(t, 500);
  const request = { ...f.request(), recheck: () => Date.now() >= 10_200 ? "lease_mismatch" : null };
  assert.equal((await finish(t, f.adapter.send(request))).reason, "lease_mismatch");
  assert.equal(f.counts().opens, 0); assert.equal(f.counts().sends, 0);
});

test("没有1500ms发送余量：零页面读取", async t => {
  const f = fixture(t);
  assert.equal((await finish(t, f.adapter.send({ ...f.request(), deadline: 11 }))).reason, "claim_expiring");
  assert.equal(f.counts().reads, 0); assert.equal(f.counts().sends, 0);
});

test("打开后当前买家不符：不会填入回复或发送", async t => {
  const f = fixture(t);
  f.adapter.clickConversation = async () => true;
  f.adapter.run = async () => ({ items: [{ active: true, key: "9002-other" }] });
  assert.equal((await finish(t, f.adapter.send(f.request()))).reason, "pdd_conversation_not_opened");
  assert.equal(f.counts().sends, 0); assert.equal(f.adapter.sending, false);
});

test("列表脚本迟到：时限之后不能再打开会话", async t => {
  const f = fixture(t);
  const script = { value: "" };
  f.adapter.run = (value: string) => { script.value = value; return new Promise(() => {}); };
  assert.equal((await finish(t, f.adapter.send(f.request()))).reason, "pdd_page_script_timeout");
  assert.equal(f.evaluate(script.value), false);
  assert.equal(f.counts().opens, 0); assert.equal(f.counts().sends, 0);
});

test("收藏准备到时后列表才出现：零迟到点击，后续发送可独立占用页面", async t => {
  const f = fixture(t, 1200);
  const request = { conversation_id: "9001", color: "red", deadline: 18, recheck: () => null };
  const result = await finish(t, f.adapter.markConversation(request), 1100);
  assert.equal(f.adapter.sending, false);
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(100);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(f.counts().opens, 0);
  assert.equal(result.reason, "pdd_conversation_not_in_list");
  assert.equal((await finish(t, f.adapter.send(f.request()))).reason, "fictional_stop_after_preparation");
  assert.equal(f.counts().opens, 1);
});

test("收藏准备脚本挂起：一秒有界释放，迟到脚本不打开会话", async t => {
  const f = fixture(t);
  let script = "";
  f.adapter.run = (value: string) => { script = value; return new Promise(() => {}); };
  const request = { conversation_id: "9001", color: "red", deadline: 18, recheck: () => null };
  const result = await finish(t, f.adapter.markConversation(request), 1100);
  assert.equal(f.adapter.sending, false);
  assert.equal(f.evaluate(script), false);
  assert.equal(f.counts().opens, 0);
  assert.equal(result.reason, "pdd_page_script_timeout");
});
