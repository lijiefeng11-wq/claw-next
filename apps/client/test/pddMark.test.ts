import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { judgeMark, MARK_COLOR_VALUE, markRequestVerdict, markResponseOk, newMarkWatch, observeInput } from "../src/core/pddMark.js";
import { convActionReason, parseSnapshot } from "../src/core/protocol.js";

// 契约“标星执行与成功判据”的纯判定：全部为虚构编号与虚构响应。
const BUYER = "880011223344";
const REQ_ID = 1790000000123;
const body = (data: unknown) => JSON.stringify({ data });
const ok = (over: Record<string, unknown> = {}, inner: Record<string, unknown> = {}) =>
  JSON.stringify({ success: true, ...over, result: { success: true, result: "ok", request_id: REQ_ID, response: "虚构", ...inner } });

describe("颜色数值", () => {
  test("店主确认的对应：orange=1、red=2、green=3、blue=4", () => {
    assert.deepEqual(MARK_COLOR_VALUE, { orange: 1, red: 2, green: 3, blue: 4 });
  });
});

describe("请求核对：放行与拦截", () => {
  const watch = () => newMarkWatch(BUYER, MARK_COLOR_VALUE.red, 7);
  const good = { uid: BUYER, color: 2, request_id: REQ_ID };

  test("窗口内第一条目标与颜色一致的 mark 请求放行，记下浏览器编号与 request_id", () => {
    assert.deepEqual(markRequestVerdict(watch(), "mark", 7, "net-1", body(good)), { allow: true, networkId: "net-1", requestId: REQ_ID });
  });

  for (const [name, kind, epoch, net, data] of [
    ["目标买家不符", "mark", 7, "net-1", { ...good, uid: "880099887766" }],
    ["买家编号是数字不是字符串", "mark", 7, "net-1", { ...good, uid: Number(BUYER) }],
    ["颜色不符", "mark", 7, "net-1", { ...good, color: 1 }],
    ["颜色是字符串", "mark", 7, "net-1", { ...good, color: "2" }],
    ["颜色缺失", "mark", 7, "net-1", { uid: BUYER, request_id: REQ_ID }],
    ["request_id 缺失", "mark", 7, "net-1", { uid: BUYER, color: 2 }],
    ["request_id 是字符串", "mark", 7, "net-1", { ...good, request_id: String(REQ_ID) }],
    ["unmark 一律拦截", "unmark", 7, "net-1", { uid: BUYER, request_id: REQ_ID }],
    ["页面代次已变", "mark", 8, "net-1", good],
    ["没有浏览器请求编号", "mark", 7, undefined, good],
  ] as const) {
    test(`${name}：拦截`, () => {
      assert.deepEqual(markRequestVerdict(watch(), kind, epoch, net, body(data)), { allow: false });
    });
  }

  test("请求体不是 JSON 或没有 data：拦截", () => {
    assert.deepEqual(markRequestVerdict(watch(), "mark", 7, "net-1", "not-json"), { allow: false });
    assert.deepEqual(markRequestVerdict(watch(), "mark", 7, "net-1", JSON.stringify(good)), { allow: false });
    assert.deepEqual(markRequestVerdict(watch(), "mark", 7, "net-1", undefined), { allow: false });
  });

  test("已放行一条后，第二条完全一致的 mark 也拦截", () => {
    const w = watch();
    w.allowed = { networkId: "net-1", requestId: REQ_ID };
    assert.deepEqual(markRequestVerdict(w, "mark", 7, "net-2", body(good)), { allow: false });
  });
});

describe("成功判据：响应", () => {
  test("两层 success 为 true、result 为 ok、request_id 一致：成功", () => {
    assert.equal(markResponseOk(REQ_ID, ok()), true);
  });

  for (const [name, text] of [
    ["外层 success 为 false", ok({ success: false })],
    ["外层 success 是字符串", ok({ success: "true" })],
    ["外层 success 缺失", JSON.stringify({ result: { success: true, result: "ok", request_id: REQ_ID } })],
    ["result 不是对象", JSON.stringify({ success: true, result: "ok" })],
    ["result 是数组", JSON.stringify({ success: true, result: [] })],
    ["result.success 为 false", ok({}, { success: false })],
    ["result.success 是数字 1", ok({}, { success: 1 })],
    ["result.result 不是 ok", ok({}, { result: "OK" })],
    ["result.result 缺失", ok({}, { result: undefined })],
    ["request_id 不等", ok({}, { request_id: REQ_ID + 1 })],
    ["request_id 是字符串", ok({}, { request_id: String(REQ_ID) })],
    ["request_id 缺失", ok({}, { request_id: undefined })],
    ["不是 JSON", "<html>"],
    ["JSON 数组", "[]"],
    ["空响应", null],
  ] as const) {
    test(`${name}：不成功`, () => {
      assert.equal(markResponseOk(REQ_ID, text as string | null), false);
    });
  }
});

describe("窗口结论", () => {
  const w = () => newMarkWatch(BUYER, 2, 1);
  test("只有放行请求的响应满足判据才成功", () => {
    const x = w();
    x.allowed = { networkId: "n", requestId: REQ_ID };
    x.outcome = "ok";
    assert.deepEqual(judgeMark(x), { ok: true });
  });
  test("其余都是 unknown，并区分原因", () => {
    const none = w();
    assert.deepEqual(judgeMark(none), { ok: false, reason: "mark_request_not_observed" });
    const blocked = w();
    blocked.blocked = 1;
    assert.deepEqual(judgeMark(blocked), { ok: false, reason: "mark_request_blocked" });
    for (const [outcome, reason] of [["bad", "mark_response_not_ok"], ["failed", "mark_request_failed"], [null, "mark_response_timeout"]] as const) {
      const x = w();
      x.allowed = { networkId: "n", requestId: REQ_ID };
      x.outcome = outcome;
      assert.deepEqual(judgeMark(x), { ok: false, reason });
    }
    // 没有放行请求时，即使有结论也不成功。
    const stray = w();
    stray.outcome = "ok";
    assert.equal(judgeMark(stray).ok, false);
  });
});

describe("来源绑定：输入配对与窗口结论", () => {
  const ready = () => {
    const x = newMarkWatch(BUYER, 2, 1);
    x.allowed = { networkId: "n", requestId: REQ_ID };
    x.outcome = "ok";
    return x;
  };
  test("命令期间按顺序到达的对应类型事件算自己的；其余（多出、类型不对、命令之外）都算外来", () => {
    const w = newMarkWatch(BUYER, 2, 1);
    w.expected = ["mouseDown", "mouseUp"];
    observeInput(w, "mouseDown");
    observeInput(w, "mouseUp");
    assert.deepEqual([w.foreign, w.expected], [0, []]);
    observeInput(w, "mouseMove");
    w.expected = ["mouseDown", "mouseUp"];
    observeInput(w, "mouseUp");
    assert.equal(w.foreign, 2);
    w.closed = true;
    observeInput(w, "keyDown");
    assert.equal(w.foreign, 2, "窗口关闭后不再计数");
  });
  test("响应满足判据时，外来输入、点击前请求、窗口内第二条请求、页面或登录失效都使结论为 unknown", () => {
    assert.deepEqual(judgeMark(ready()), { ok: true });
    for (const [set, reason] of [
      [(x: ReturnType<typeof ready>) => (x.foreign = 1), "manual_input_during_mark"],
      [(x: ReturnType<typeof ready>) => (x.before = 1), "mark_request_before_click"],
      [(x: ReturnType<typeof ready>) => (x.blocked = 1), "mark_request_ambiguous"],
      [(x: ReturnType<typeof ready>) => (x.invalid = "page_changed_during_mark"), "page_changed_during_mark"],
      [(x: ReturnType<typeof ready>) => (x.invalid = "platform_changed_during_mark"), "platform_changed_during_mark"],
    ] as const) {
      const x = ready();
      set(x);
      assert.deepEqual(judgeMark(x), { ok: false, reason });
    }
  });
});

describe("回执原因归类", () => {
  test("页面状态原样；能力撤回与截止归类；其余 not_started", () => {
    assert.equal(convActionReason("conv_state_changed"), "conv_state_changed");
    assert.equal(convActionReason("conv_state_unavailable"), "conv_state_unavailable");
    assert.equal(convActionReason("capability_not_confirmed"), "capability_withdrawn");
    for (const d of ["claim_expiring", "decision_expired", "reply_deadline_exceeded"]) assert.equal(convActionReason(d), "deadline_exceeded");
    for (const d of ["superseded", "session_changed", "manual_takeover", "pdd_send_busy", "restarted_before_send", "platform_changed_during_mark", null, undefined]) assert.equal(convActionReason(d), "not_started");
  });
});

describe("决定解析：mark", () => {
  const snap = (decision: unknown) =>
    parseSnapshot({
      event_id: "evt-1", shop_id: "shop-a", client_id: "client-a", conversation_id: "c-1", message_id: "m-1", context_revision: 1,
      session_id: "s-1", generation: 1, state: "ready", decision, delivery: { status: "unclaimed", attempt_id: null, platform_message_id: null }, created_at: 1,
    }).decision;
  const base = { reason: "fallback:unhandled", expires_at: 1790000060 };

  test("合法 mark：颜色四选一、policy_version 为正整数，文字为空", () => {
    assert.deepEqual(snap({ action: "mark", mark: { color: "orange" }, policy_version: 3, ...base }), { action: "mark", text: "", ...base, mark: { color: "orange" }, policy_version: 3 });
  });

  for (const [name, d] of [
    ["颜色不在四色内", { action: "mark", mark: { color: "yellow" }, policy_version: 3 }],
    ["颜色是平台数值", { action: "mark", mark: { color: 1 }, policy_version: 3 }],
    ["缺 mark", { action: "mark", policy_version: 3 }],
    ["mark 是数组", { action: "mark", mark: ["red"], policy_version: 3 }],
    ["缺 policy_version", { action: "mark", mark: { color: "red" } }],
    ["policy_version 为 0", { action: "mark", mark: { color: "red" }, policy_version: 0 }],
    ["policy_version 是小数", { action: "mark", mark: { color: "red" }, policy_version: 1.5 }],
    ["transfer 本阶段不支持", { action: "transfer", transfer: { target_id: "t-1", unmark_policy: { allow: true, version: 3 } }, policy_version: 3 }],
  ] as const) {
    test(`${name}：按 none 记录，不执行`, () => {
      const r = snap({ ...d, ...base });
      assert.equal(r?.action, "none");
      assert.ok(r?.reason.startsWith("unsupported_action:"));
      assert.equal(r?.mark, undefined);
    });
  }
});
