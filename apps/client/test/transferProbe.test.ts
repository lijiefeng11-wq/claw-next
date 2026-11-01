import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bindingOf, closeRequestProbe, combineBinding, extractAssignEntries, moveRequestProbe, transferProbePath, transferResponseProbe } from "../src/main/transferProbe.js";

// 转人工取证探针（诊断模式专用）：全部为虚构编号与名称；核对输出只有布尔、计数与封闭候选值，不含任何原文。

const CSID = "cs-9f3a71";
const BUYER = "buyer-55120";
const NAME = "主账号";
const NICK = "小王客服";
const SECRETS = [CSID, BUYER, NAME, NICK, "7788", "20017", "店铺备注原文", "该会话已被收藏，不可转移"];

const assignBody = (list: unknown[]) => JSON.stringify({ success: true, result: { data: { csList: list } } });
const moveBody = (conversation: Record<string, unknown>) => JSON.stringify({ data: { cmd: "move_conversation", conversation } });

function assertNoLeak(rec: unknown) {
  const text = JSON.stringify(rec);
  for (const s of SECRETS) assert.equal(text.includes(s), false, `输出含原文：${s}`);
}

describe("路径", () => {
  test("只认拼多多域名下的精确路径；客服列表按前缀", () => {
    assert.equal(transferProbePath("https://mms.pinduoduo.com/plateau/chat/move_conversation?x=1"), "move");
    assert.equal(transferProbePath("https://mms.pinduoduo.com/plateau/chat/close_conversation"), "close");
    assert.equal(transferProbePath("https://mms.pinduoduo.com/latitude/assign/getCsList"), "assign");
    assert.equal(transferProbePath("https://mms.pinduoduo.com/latitude/assign"), "assign");
    assert.equal(transferProbePath("https://mms.pinduoduo.com/latitude/assignment"), null);
    assert.equal(transferProbePath("https://evil.example.com/plateau/chat/move_conversation"), null);
    assert.equal(transferProbePath("https://mms.pinduoduo.com/plateau/chat/move_conversation_v2"), null);
    assert.equal(transferProbePath(null), null);
    assert.equal(transferProbePath("not a url"), null);
  });
});

describe("客服列表候选", () => {
  test("在嵌套结构里找出同时带编号与名称字段的对象；完整", () => {
    const c = extractAssignEntries(assignBody([{ id: 7788, username: NAME, nickname: NICK }, { csid: CSID, nickname: "别人" }, { id: 1 }]));
    assert.equal(c?.complete, true);
    assert.equal(c?.entries.length, 2);
    assert.equal(c?.entries[0].username, NAME);
    assert.equal(c?.entries[1].csid, CSID);
  });
  test("不是 JSON 时为 null；空列表为空数组且完整", () => {
    assert.equal(extractAssignEntries("<html>"), null);
    assert.equal(extractAssignEntries(null), null);
    assert.deepEqual(extractAssignEntries(assignBody([])), { entries: [], complete: true });
  });
  test("超过 500 项、层数或节点预算：记为不完整，不静默当作全部", () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `cs-${i}`, username: `u-${i}` }));
    assert.equal(extractAssignEntries(assignBody(many))?.complete, false);
    let deep: unknown = { id: 1, username: "x" };
    for (let i = 0; i < 12; i++) deep = { child: deep };
    assert.equal(extractAssignEntries(JSON.stringify(deep))?.complete, false);
    const wide = { list: Array.from({ length: 6000 }, () => ({ other: true })) };
    assert.equal(extractAssignEntries(JSON.stringify(wide))?.complete, false);
  });
});

describe("转移请求", () => {
  test("账号名对应 username、csid 对应该候选的 id：逐项记布尔，不含原文", () => {
    const c = extractAssignEntries(assignBody([{ id: CSID, username: NAME, nickname: NICK }, { id: "cs-other", username: "其他", nickname: "其他昵称" }]));
    const rec = moveRequestProbe(moveBody({ csid: CSID, uid: BUYER, need_wx: false, remark: "" }), BUYER, NAME, c);
    assert.equal(rec.parsed, true);
    assert.equal(rec.target_is_active, true);
    assert.equal(rec.csid_kind, "string");
    assert.equal(rec.remark_empty, true);
    assert.equal(rec.need_wx_kind, "boolean");
    assert.equal(rec.candidates, 2);
    assert.equal(rec.candidates_complete, true);
    assert.equal(rec.candidate_name_eq_username, 1);
    assert.equal(rec.candidate_name_eq_nickname, 0);
    assert.equal(rec.csid_eq_candidate_id_any, true);
    assert.equal(rec.csid_eq_id_of_username_candidate, true);
    assert.equal(rec.csid_eq_id_of_nickname_candidate, null);
    assertNoLeak(rec);
  });

  test("账号名只命中昵称：分别记录，便于判断对话框第一列对应哪个字段", () => {
    const c = extractAssignEntries(assignBody([{ id: CSID, username: "u-1", nickname: NAME }]));
    const rec = moveRequestProbe(moveBody({ csid: CSID, uid: BUYER }), BUYER, NAME, c);
    assert.equal(rec.candidate_name_eq_username, 0);
    assert.equal(rec.candidate_name_eq_nickname, 1);
    assert.equal(rec.csid_eq_id_of_nickname_candidate, true);
    assertNoLeak(rec);
  });

  test("数字编号与字符串 csid：严格不等、宽松相等分开记录（宽松只作对照）", () => {
    const c = extractAssignEntries(assignBody([{ id: 7788, username: NAME }]));
    const rec = moveRequestProbe(moveBody({ csid: "7788", uid: BUYER }), BUYER, NAME, c);
    assert.equal(rec.csid_eq_candidate_id_any, false);
    assert.equal(rec.csid_loose_eq_candidate_id_any, true);
    assert.equal(rec.csid_eq_id_of_username_candidate, false);
    assert.equal(rec.csid_loose_eq_id_of_username_candidate, true);
    assertNoLeak(rec);
  });

  test("同名候选不止一个：唯一命中类记 null（不挑其中一个）", () => {
    const c = extractAssignEntries(assignBody([{ id: CSID, username: NAME }, { id: "cs-2", username: NAME }]));
    const rec = moveRequestProbe(moveBody({ csid: CSID, uid: BUYER }), BUYER, NAME, c);
    assert.equal(rec.candidate_name_eq_username, 2);
    assert.equal(rec.csid_eq_id_of_username_candidate, null);
    assert.equal(rec.csid_eq_candidate_id_any, true);
  });

  test("反例：同账号第 1 项与第 501 项各一个，列表被截断——不给唯一对应，没找到的也不记 false", () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `cs-${i}`, username: i === 0 || i === 500 ? NAME : `u-${i}` }));
    const c = extractAssignEntries(assignBody(many));
    assert.equal(c?.complete, false);
    const rec = moveRequestProbe(moveBody({ csid: "cs-0", uid: BUYER }), BUYER, NAME, c);
    assert.equal(rec.candidates_complete, false);
    assert.equal(rec.candidate_name_eq_username, 1);
    assert.equal(rec.csid_eq_id_of_username_candidate, null);
    assert.equal(rec.csid_eq_candidate_id_any, true);
    const notFound = moveRequestProbe(moveBody({ csid: "cs-zzz", uid: BUYER }), BUYER, NAME, c);
    assert.equal(notFound.csid_eq_candidate_id_any, null);
  });

  test("没有绑定的诊断目标（店主手动转移）、没读到列表、目标不是当前会话、请求体坏", () => {
    const manual = moveRequestProbe(moveBody({ csid: CSID, uid: BUYER }), BUYER, null, null);
    assert.equal(manual.target_known, false);
    assert.equal(manual.candidates_known, false);
    assert.equal(manual.candidates_complete, null);
    assert.equal(manual.candidate_name_eq_username, 0);
    assert.equal(manual.csid_eq_candidate_id_any, null);
    const empty = { entries: [], complete: true };
    assert.equal(moveRequestProbe(moveBody({ csid: CSID, uid: "buyer-other" }), BUYER, NAME, empty).target_is_active, false);
    assert.equal(moveRequestProbe(moveBody({ csid: CSID, uid: BUYER }), null, NAME, empty).target_is_active, false);
    const bad = moveRequestProbe("not json", BUYER, NAME, empty);
    assert.equal(bad.parsed, false);
    assert.equal(bad.csid_kind, "missing");
    assertNoLeak(manual);
  });
});

describe("转移 / 关闭会话响应", () => {
  test("成功形态：只记封闭候选值与类型", () => {
    const rec = transferResponseProbe("move", JSON.stringify({ success: true, result: { result: "ok" } }));
    assert.equal(rec.kind, "move_response");
    assert.equal(rec.top_success, true);
    assert.equal(rec.result_value, "object");
    assert.equal(rec.inner_result, "ok");
    assert.equal(rec.inner_error_code, "missing");
    assert.equal(rec.error_msg_present, false);
  });

  test("已收藏被拒：错误码不在候选集只记 num_other；错误文字只记是否提到“收藏”", () => {
    const rec = transferResponseProbe("move", JSON.stringify({ success: true, result: { result: "fail", error_code: 20017, error_msg: "该会话已被收藏，不可转移" } }));
    assert.equal(rec.inner_result, "fail");
    assert.equal(rec.inner_error_code, "num_other");
    assert.equal(rec.error_msg_present, true);
    assert.equal(rec.error_msg_mentions_favorite, true);
    assert.equal(typeof rec.error_msg_len, "number");
    assertNoLeak(rec);
  });

  test("数字一律走封闭候选集：只有 -1 / 0 / 1 原样，其余只记类型", () => {
    const pick = (v: unknown) => transferResponseProbe("move", JSON.stringify({ success: v, error_code: v, result: { error_code: v, result: v } }));
    for (const v of [-1, 0, 1]) {
      const rec = pick(v);
      assert.deepEqual([rec.top_success, rec.top_error_code, rec.inner_error_code, rec.inner_result], [v, v, v, v]);
    }
    for (const v of [2, 7788, 20017, -5, 1.5, 1e12]) {
      const rec = pick(v);
      assert.deepEqual([rec.top_success, rec.top_error_code, rec.inner_error_code, rec.inner_result], ["num_other", "num_other", "num_other", "num_other"]);
      assertNoLeak(rec);
    }
    assert.equal(transferResponseProbe("move", JSON.stringify({ error_code: "0" })).top_error_code, "str:0");
    for (const v of ["40001", "7788", "账号7788", ""]) assert.equal(transferResponseProbe("move", JSON.stringify({ error_code: v })).top_error_code, "str_other");
  });

  test("候选集外的文字、坏响应", () => {
    const rec = transferResponseProbe("close", JSON.stringify({ success: "yes", result: "店铺备注原文" }));
    assert.equal(rec.kind, "close_response");
    assert.equal(rec.top_success, "other");
    assert.equal(rec.result_kind, "string");
    assert.equal(rec.result_value, "other");
    const bad = transferResponseProbe("move", null);
    assert.equal(bad.parsed, false);
    assert.equal(bad.top_success, "missing");
    assertNoLeak(rec);
  });
});

describe("关闭会话请求", () => {
  test("只记目标是否为当前会话", () => {
    assert.equal(closeRequestProbe(JSON.stringify({ data: { uid: BUYER } }), BUYER).target_is_active, true);
    assert.equal(closeRequestProbe(JSON.stringify({ data: { conversation: { uid: BUYER } } }), BUYER).target_is_active, true);
    assert.equal(closeRequestProbe(JSON.stringify({ data: { uid: BUYER } }), null).target_is_active, false);
    const rec = closeRequestProbe("x", BUYER);
    assert.equal(rec.parsed, false);
    assertNoLeak(rec);
  });
});

describe("请求与诊断转移的关联", () => {
  test("请求时没有诊断：unbound；页面代次或诊断批次变了：stale；都没变：bound", () => {
    assert.equal(bindingOf({ epoch: 1, diag: null }, { epoch: 1, diag: 3 }), "unbound");
    assert.equal(bindingOf({ epoch: 1, diag: 3 }, { epoch: 1, diag: 3 }), "bound");
    assert.equal(bindingOf({ epoch: 1, diag: 3 }, { epoch: 2, diag: 3 }), "stale");
    assert.equal(bindingOf({ epoch: 1, diag: 3 }, { epoch: 1, diag: 4 }), "stale");
    assert.equal(bindingOf({ epoch: 1, diag: 3 }, { epoch: 1, diag: null }), "stale");
  });
  test("读前读后两次都 bound 才是 bound", () => {
    assert.equal(combineBinding("bound", "bound"), "bound");
    assert.equal(combineBinding("bound", "stale"), "stale");
    assert.equal(combineBinding("stale", "bound"), "stale");
    assert.equal(combineBinding("unbound", "bound"), "unbound");
  });
});
