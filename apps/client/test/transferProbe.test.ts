import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assignNameProbe, assignTokens, bindingOf, closeRequestProbe, combineBinding, extractAssignEntries, mergeAssignCandidates, mergeAssignTokens, moveRequestProbe, transferProbePath, transferResponseProbe } from "../src/main/transferProbe.js";

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

describe("csid 对应字段扩展", () => {
  test("父级映射键：候选挂在结果映射的键下时记 parentKey；数组里为 null", () => {
    const c = extractAssignEntries(JSON.stringify({ success: true, result: { a: { [CSID]: { id: 7788, username: NAME, nickname: NICK } }, b: {} } }));
    assert.equal(c?.complete, true);
    assert.equal(c?.entries.length, 1);
    assert.equal(c?.entries[0].parentKey, CSID);
    const rec = moveRequestProbe(moveBody({ csid: CSID, uid: BUYER }), BUYER, NAME, c);
    assert.equal(rec.csid_eq_candidate_parent_key_any, true);
    assert.equal(rec.csid_eq_candidate_other_field_any, false);
    assert.equal(rec.csid_other_field_names, 0);
    assert.equal(rec.csid_eq_parent_key_of_username_candidate, true);
    assert.equal(rec.csid_eq_other_field_of_username_candidate, false);
    assertNoLeak(rec);
    const inArray = extractAssignEntries(JSON.stringify({ list: [{ id: 7788, username: NAME }] }));
    assert.equal(inArray?.entries[0].parentKey, null);
  });

  test("others：只收非空字符串与有限数字，排除编号/名称字段、空串、布尔、对象；超过 40 项记不完整", () => {
    const c = extractAssignEntries(JSON.stringify({ list: [{ id: 7788, username: NAME, nickname: NICK, empty: "", flag: true, obj: { x: 1 }, note: "note-value", num: 42 }] }));
    assert.equal(c?.complete, true);
    assert.deepEqual(c?.entries[0].others.map((o) => o.key).sort(), ["note", "num"]);
    assert.deepEqual(c?.entries[0].others.map((o) => o.value).sort(), ["42", "note-value"]);
    const many: Record<string, unknown> = { id: 1, username: NAME };
    for (let i = 0; i < 41; i++) many[`f${i}`] = `v${i}`;
    const over = extractAssignEntries(JSON.stringify({ list: [many] }));
    assert.equal(over?.complete, false);
    assert.equal(over?.entries.length, 1);
    assert.equal(over?.entries[0].others.length, 40);
  });

  test("csid 等于候选对象某个其他字段的值：记 other_field_any 与命中键名个数（不输出键名）", () => {
    const c = extractAssignEntries(JSON.stringify({ list: [{ id: 7788, username: NAME, nickname: NICK, cs_key: CSID }] }));
    assert.equal(c?.complete, true);
    assert.equal(c?.entries[0].others.length, 1);
    assert.equal(c?.entries[0].others[0].key, "cs_key");
    const rec = moveRequestProbe(moveBody({ csid: CSID, uid: BUYER }), BUYER, NAME, c);
    assert.equal(rec.csid_eq_candidate_other_field_any, true);
    assert.equal(rec.csid_eq_candidate_parent_key_any, false);
    assert.equal(rec.csid_other_field_names, 1);
    assert.equal(JSON.stringify(rec).includes("cs_key"), false);
    assert.equal(rec.csid_eq_other_field_of_username_candidate, true);
    assert.equal(rec.csid_eq_other_field_of_nickname_candidate, null);
    assertNoLeak(rec);
  });

  test("动态身份键（ASCII 字母也算）不输出键名，只给命中个数；两个不同键名命中记 2", () => {
    const ident = extractAssignEntries(JSON.stringify({ list: [{ id: 1, username: "FixtureAgent", AlicePrivateBuyer: "fixture-csid" }] }));
    const r1 = moveRequestProbe(moveBody({ csid: "fixture-csid", uid: BUYER }), BUYER, NAME, ident);
    assert.equal(r1.csid_eq_candidate_other_field_any, true);
    assert.equal(r1.csid_other_field_names, 1);
    for (const s of ["AlicePrivateBuyer", "FixtureAgent", "fixture-csid"]) assert.equal(JSON.stringify(r1).includes(s), false, `输出含原文：${s}`);
    const nameKey = extractAssignEntries(JSON.stringify({ list: [{ id: 1, username: "u-1", [NAME]: CSID }] }));
    const r2 = moveRequestProbe(moveBody({ csid: CSID, uid: BUYER }), BUYER, NAME, nameKey);
    assert.equal(r2.csid_other_field_names, 1);
    assertNoLeak(r2);
    const multi = extractAssignEntries(JSON.stringify({ list: [{ id: 1, username: "u-1", cs_a: CSID, cs_b: CSID }] }));
    const r4 = moveRequestProbe(moveBody({ csid: CSID, uid: BUYER }), BUYER, NAME, multi);
    assert.equal(r4.csid_eq_candidate_other_field_any, true);
    assert.equal(r4.csid_other_field_names, 2);
    assert.equal(JSON.stringify(r4).includes("cs_a"), false);
    assertNoLeak(r4);
    const none = moveRequestProbe(moveBody({ csid: "cs-zzz", uid: BUYER }), BUYER, NAME, multi);
    assert.equal(none.csid_other_field_names, 0);
  });

  test("csid 是数字或空串：父级键/其他字段比较为 false，字段名与 tokens 比较为 null", () => {
    const c = extractAssignEntries(JSON.stringify({ a: { [CSID]: { id: 7788, username: NAME, cs_key: CSID } } }));
    const tokens = assignTokens(JSON.stringify({ a: { [CSID]: 1 } }));
    for (const raw of [7788, ""]) {
      const rec = moveRequestProbe(moveBody({ csid: raw, uid: BUYER }), BUYER, NAME, c, tokens);
      assert.equal(rec.csid_eq_candidate_parent_key_any, false);
      assert.equal(rec.csid_eq_candidate_other_field_any, false);
      assert.equal(rec.csid_other_field_names, null);
      assert.equal(rec.csid_in_assign_keys, null);
      assert.equal(rec.csid_in_assign_values, null);
      assertNoLeak(rec);
    }
  });

  test("列表不完整且没找到：新增 any 类字段为 null，字段名仍为 null", () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `cs-${i}`, username: `u-${i}`, f: `v-${i}` }));
    const c = extractAssignEntries(JSON.stringify({ list: many }));
    assert.equal(c?.complete, false);
    const rec = moveRequestProbe(moveBody({ csid: "cs-zzz", uid: BUYER }), BUYER, "无人", c);
    assert.equal(rec.csid_eq_candidate_parent_key_any, null);
    assert.equal(rec.csid_eq_candidate_other_field_any, null);
    assert.equal(rec.csid_eq_parent_key_of_username_candidate, null);
    assert.equal(rec.csid_eq_other_field_of_username_candidate, null);
    assert.equal(rec.csid_other_field_names, null);
    assertNoLeak(rec);
  });

  test("assignTokens：收集所有键与非空字符串/有限数字值，数字转字符串", () => {
    const t = assignTokens(JSON.stringify({ result: { abc: { id: 7788, note: "x", empty: "" } }, flag: true }));
    assert.equal(t?.complete, true);
    assert.equal(t?.keys.has("result"), true);
    assert.equal(t?.keys.has("abc"), true);
    assert.equal(t?.keys.has("id"), true);
    assert.equal(t?.values.has("7788"), true);
    assert.equal(t?.values.has("x"), true);
    assert.equal(t?.values.has(""), false);
    assert.equal(t?.values.has("true"), false);
  });

  test("assignTokens：非 JSON 为 null；节点预算或条目上限耗尽记不完整", () => {
    assert.equal(assignTokens("<html>"), null);
    assert.equal(assignTokens(null), null);
    const wide = JSON.stringify({ list: Array.from({ length: 6000 }, () => ({ a: 1 })) });
    assert.equal(assignTokens(wide)?.complete, false);
    const huge: Record<string, string> = {};
    for (let i = 0; i < 5001; i++) huge[`k${i}`] = `v${i}`;
    const t = assignTokens(JSON.stringify(huge));
    assert.equal(t?.complete, false);
    assert.equal(t?.keys.size, 5000);
  });

  test("mergeAssignTokens：并集、不修改入参、null 处理", () => {
    const a = { keys: new Set(["k1"]), values: new Set(["v1"]), complete: true };
    const b = { keys: new Set(["k2"]), values: new Set(["v1", "v2"]), complete: true };
    const m = mergeAssignTokens(a, b);
    assert.deepEqual(Array.from(m?.keys ?? []).sort(), ["k1", "k2"]);
    assert.deepEqual(Array.from(m?.values ?? []).sort(), ["v1", "v2"]);
    assert.equal(m?.complete, true);
    assert.deepEqual(Array.from(a.keys), ["k1"]);
    assert.deepEqual(Array.from(a.values), ["v1"]);
    assert.deepEqual(Array.from(b.keys), ["k2"]);
    assert.equal(mergeAssignTokens(null, b), b);
    assert.equal(mergeAssignTokens(a, null), a);
    assert.equal(mergeAssignTokens(null, null), null);
  });

  test("tokens：csid 作为键或值出现分别记录；都不在且完整记 false，不完整记 null；省略 tokens 时未知", () => {
    const c = extractAssignEntries(assignBody([{ id: 7788, username: NAME }]));
    const asKey = assignTokens(JSON.stringify({ result: { [CSID]: { id: 7788 } } }));
    const recKey = moveRequestProbe(moveBody({ csid: CSID, uid: BUYER }), BUYER, NAME, c, asKey);
    assert.equal(recKey.tokens_known, true);
    assert.equal(recKey.tokens_complete, true);
    assert.equal(recKey.csid_in_assign_keys, true);
    assert.equal(recKey.csid_in_assign_values, false);
    assertNoLeak(recKey);
    const asValue = assignTokens(JSON.stringify({ result: { other: CSID } }));
    const recValue = moveRequestProbe(moveBody({ csid: CSID, uid: BUYER }), BUYER, NAME, c, asValue);
    assert.equal(recValue.csid_in_assign_keys, false);
    assert.equal(recValue.csid_in_assign_values, true);
    assertNoLeak(recValue);
    const none = assignTokens(JSON.stringify({ result: { other: "zzz" } }));
    const recNone = moveRequestProbe(moveBody({ csid: CSID, uid: BUYER }), BUYER, NAME, c, none);
    assert.equal(recNone.csid_in_assign_keys, false);
    assert.equal(recNone.csid_in_assign_values, false);
    const incomplete = { keys: new Set<string>(), values: new Set<string>(), complete: false };
    const recBad = moveRequestProbe(moveBody({ csid: CSID, uid: BUYER }), BUYER, NAME, c, incomplete);
    assert.equal(recBad.csid_in_assign_keys, null);
    assert.equal(recBad.csid_in_assign_values, null);
    const recOmitted = moveRequestProbe(moveBody({ csid: CSID, uid: BUYER }), BUYER, NAME, c);
    assert.equal(recOmitted.tokens_known, false);
    assert.equal(recOmitted.tokens_complete, null);
    assert.equal(recOmitted.csid_in_assign_keys, null);
    assert.equal(recOmitted.csid_in_assign_values, null);
    assertNoLeak(recOmitted);
  });

  test("assignNameProbe：分别统计账号名命中 username / nickname / 其他字段", () => {
    const c = extractAssignEntries(JSON.stringify({ list: [
      { id: 1, username: NAME, nickname: "n-1" },
      { id: 2, username: "u-2", nickname: NAME },
      { id: 3, username: "u-3", nickname: "n-3", alias: NAME },
      { id: 4, username: "u-4", nickname: "n-4" },
    ] }));
    assert.equal(c?.complete, true);
    const rec = assignNameProbe(c, NAME);
    assert.equal(rec.target_known, true);
    assert.equal(rec.candidate_name_eq_username, 1);
    assert.equal(rec.candidate_name_eq_nickname, 1);
    assert.equal(rec.candidate_name_eq_other_field, 1);
    assert.equal(rec.candidate_names_complete, true);
    assertNoLeak(rec);
  });

  test("assignNameProbe：目标或列表缺失时计数为 null", () => {
    const c = extractAssignEntries(assignBody([{ id: 1, username: NAME }]));
    const noTarget = assignNameProbe(c, null);
    assert.equal(noTarget.target_known, false);
    assert.equal(noTarget.candidate_name_eq_username, null);
    assert.equal(noTarget.candidate_name_eq_nickname, null);
    assert.equal(noTarget.candidate_name_eq_other_field, null);
    assert.equal(noTarget.candidate_names_complete, true);
    assertNoLeak(noTarget);
    const noList = assignNameProbe(null, NAME);
    assert.equal(noList.target_known, true);
    assert.equal(noList.candidate_name_eq_username, null);
    assert.equal(noList.candidate_name_eq_nickname, null);
    assert.equal(noList.candidate_name_eq_other_field, null);
    assert.equal(noList.candidate_names_complete, null);
    assertNoLeak(noList);
  });
});

describe("证据有效性（复审修正）", () => {
  test("字符串值 200 字符照常收集；201 字符不收集并记不完整，比较给未知而不是 false", () => {
    const v200 = "a".repeat(200), v201 = "b".repeat(201);
    const t200 = assignTokens(JSON.stringify({ list: [{ k: v200 }] }));
    assert.equal(t200?.complete, true);
    assert.equal(moveRequestProbe(moveBody({ csid: v200, uid: BUYER }), BUYER, null, null, t200).csid_in_assign_values, true);
    const t201 = assignTokens(JSON.stringify({ list: [{ k: v201 }] }));
    assert.equal(t201?.complete, false);
    assert.equal(t201?.values.has(v201), false);
    const rec = moveRequestProbe(moveBody({ csid: v201, uid: BUYER }), BUYER, null, null, t201);
    assert.equal(rec.tokens_complete, false);
    assert.equal(rec.csid_in_assign_values, null);
    assert.equal(JSON.stringify(rec).includes(v201), false);
  });

  test("mergeAssignCandidates：多来源合并；任一来源不完整或无法解析则不完整；全部无法解析为 null", () => {
    const a = extractAssignEntries(JSON.stringify({ list: [{ id: 1, username: NAME }] }))!;
    const b = extractAssignEntries(JSON.stringify({ list: [] }))!;
    assert.deepEqual(mergeAssignCandidates([a, b])?.entries.length, 1);
    assert.equal(mergeAssignCandidates([a, b])?.complete, true);
    assert.equal(mergeAssignCandidates([a, null])?.complete, false);
    assert.equal(mergeAssignCandidates([a, { entries: [], complete: false }])?.complete, false);
    assert.equal(mergeAssignCandidates([null]), null);
    assert.equal(mergeAssignCandidates([]), null);
    const dup = mergeAssignCandidates([a, a]);
    const rec = moveRequestProbe(moveBody({ csid: "1", uid: BUYER }), BUYER, NAME, dup);
    assert.equal(rec.candidate_name_eq_username, 2);
    assert.equal(rec.csid_loose_eq_id_of_username_candidate, null);
  });
});
