import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { colorValue, MARKED_LIST_PATH, markedListProbe, markRequestProbe, markResponseProbe, MARK_REQUEST_PATH, UNMARK_REQUEST_PATH } from "../src/main/markProbe.js";

const ACTIVE = "880011223344";
const OTHER = "880099887766";
const ids = [ACTIVE, OTHER, "mall-77", "cs-55", "csid-66"];
const leaks = (rec: unknown) => ids.filter((id) => JSON.stringify(rec).includes(id));

const markReq = (color: unknown, uid = ACTIVE) => JSON.stringify({ data: { cmd: "mark_conversation", request_id: 1, color, uid, anti_content: "x" }, client: "web" });
const list = (result: Record<string, unknown>) => JSON.stringify({ success: true, result });
const conv = (fromUid: string, toUid: string) => ({ from: { role: "user", mall_id: "mall-77", uid: fromUid, cs_uid: "cs-55", csid: "csid-66" }, to: { role: "mall_cs", uid: toUid } });

describe("颜色数值分类：只有封闭候选集内的整数原样保留", () => {
  test("候选集内整数", () => {
    for (const v of [0, 1, 4, 9]) assert.equal(colorValue(v), v);
  });
  test("越界、小数、字符串、布尔、对象、缺失均只记类别", () => {
    assert.equal(colorValue(10), "out_of_set");
    assert.equal(colorValue(-1), "out_of_set");
    assert.equal(colorValue(880011223344), "out_of_set");
    assert.equal(colorValue(1.5), "not_integer");
    assert.equal(colorValue(Number.NaN), "not_integer");
    assert.equal(colorValue("2"), "str");
    assert.equal(colorValue(true), "bool");
    assert.equal(colorValue(null), "null");
    assert.equal(colorValue({ v: 1 }), "obj");
    assert.equal(colorValue([1]), "obj");
    assert.equal(colorValue(undefined), "missing");
  });
});

describe("标星请求：只认精确路由与 data.color / data.uid", () => {
  test("当前会话标星：记目标为当前会话与颜色数值，不含编号", () => {
    const rec = markRequestProbe(MARK_REQUEST_PATH, markReq(3), ACTIVE);
    assert.deepEqual(rec, { kind: "mark_request", parsed: true, active_known: true, target_is_active: true, color: 3 });
    assert.deepEqual(leaks(rec), []);
  });
  test("别的会话、当前会话未知：target_is_active 为 false", () => {
    assert.equal(markRequestProbe(MARK_REQUEST_PATH, markReq(3, OTHER), ACTIVE)?.target_is_active, false);
    const unknown = markRequestProbe(MARK_REQUEST_PATH, markReq(3), null);
    assert.equal(unknown?.target_is_active, false);
    assert.equal(unknown?.active_known, false);
  });
  test("越界/小数/字符串颜色只记类别；身份值作颜色不外泄", () => {
    assert.equal(markRequestProbe(MARK_REQUEST_PATH, markReq(12), ACTIVE)?.color, "out_of_set");
    assert.equal(markRequestProbe(MARK_REQUEST_PATH, markReq(2.5), ACTIVE)?.color, "not_integer");
    assert.equal(markRequestProbe(MARK_REQUEST_PATH, markReq("red"), ACTIVE)?.color, "str");
    const rec = markRequestProbe(MARK_REQUEST_PATH, markReq(Number(OTHER)), ACTIVE);
    assert.equal(rec?.color, "out_of_set");
    assert.deepEqual(leaks(rec), []);
  });
  test("color 不在 data 下（同名键放在别处）不认", () => {
    const body = JSON.stringify({ color: 2, data: { uid: ACTIVE, extra: { color: 2 } } });
    assert.equal(markRequestProbe(MARK_REQUEST_PATH, body, ACTIVE)?.color, "missing");
  });
  test("取消收藏只记目标是否为当前会话，不带颜色", () => {
    const rec = markRequestProbe(UNMARK_REQUEST_PATH, JSON.stringify({ data: { uid: ACTIVE } }), ACTIVE);
    assert.deepEqual(rec, { kind: "unmark_request", parsed: true, active_known: true, target_is_active: true });
  });
  test("无关路径、相似路径、非 JSON 一律不记或记为未解析", () => {
    assert.equal(markRequestProbe("/plateau/chat/mark_read", markReq(1), ACTIVE), null);
    assert.equal(markRequestProbe("/plateau/chat/mark_conversation/extra", markReq(1), ACTIVE), null);
    assert.equal(markRequestProbe("/latitude/mark_conversation", markReq(1), ACTIVE), null);
    assert.deepEqual(markRequestProbe(MARK_REQUEST_PATH, "not json", ACTIVE), { kind: "mark_request", parsed: false, active_known: true, target_is_active: false, color: "missing" });
  });
});

describe("收藏列表：只看 result.color_map 与 result.marked_conversations", () => {
  test("当前会话在 color_map 中：记数值与计数，不输出键、完整 map 或任何编号", () => {
    const body = list({ page: 1, has_more: false, color_map: { [ACTIVE]: 2, [OTHER]: 4 }, marked_conversations: [conv(ACTIVE, "cs-55"), conv(OTHER, "cs-55")] });
    const rec = markedListProbe(MARKED_LIST_PATH, body, ACTIVE);
    assert.deepEqual(rec, {
      kind: "marked_list", parsed: true, active_known: true,
      map_present: true, map_entries: 2, active_in_map: true, active_value: 2,
      list_present: true, list_count: 2, from_uid_active: 1, to_uid_active: 0, has_more: false,
    });
    assert.deepEqual(leaks(rec), []);
  });
  test("当前会话不在 map 中：active_in_map=false、数值 missing（不据此推出未收藏）", () => {
    const rec = markedListProbe(MARKED_LIST_PATH, list({ has_more: true, color_map: { [OTHER]: 1 }, marked_conversations: [] }), ACTIVE);
    assert.equal(rec?.active_in_map, false);
    assert.equal(rec?.active_value, "missing");
    assert.equal(rec?.has_more, true);
  });
  test("当前会话未知：不查 map；记录不含“与请求时同一会话”判断", () => {
    const body = list({ color_map: { [ACTIVE]: 1 }, marked_conversations: [] });
    const unknown = markedListProbe(MARKED_LIST_PATH, body, null);
    assert.deepEqual([unknown?.active_known, unknown?.active_in_map, unknown?.active_value], [false, false, "missing"]);
    assert.equal("active_same_as_request" in (unknown ?? {}), false);
  });
  test("map 中当前会话的值越界/小数/字符串只记类别", () => {
    for (const [v, want] of [[11, "out_of_set"], [0.5, "not_integer"], ["2", "str"], [{ c: 1 }, "obj"]] as const) {
      assert.equal(markedListProbe(MARKED_LIST_PATH, list({ color_map: { [ACTIVE]: v } }), ACTIVE)?.active_value, want);
    }
  });
  test("同名 color_map 嵌在别处、result 不是对象：不认", () => {
    const nested = JSON.stringify({ success: true, result: { extra: { color_map: { [ACTIVE]: 2 } } }, color_map: { [ACTIVE]: 3 } });
    const rec = markedListProbe(MARKED_LIST_PATH, nested, ACTIVE);
    assert.equal(rec?.map_present, false);
    assert.equal(rec?.active_in_map, false);
    assert.equal(markedListProbe(MARKED_LIST_PATH, JSON.stringify({ result: [1] }), ACTIVE)?.parsed, false);
    assert.equal(markedListProbe(MARKED_LIST_PATH, JSON.stringify({ result: { color_map: [2] } }), ACTIVE)?.map_present, false);
  });
  test("原型链上的键不算在 map 中", () => {
    const rec = markedListProbe(MARKED_LIST_PATH, list({ color_map: {} }), "toString");
    assert.equal(rec?.active_in_map, false);
  });
  test("无关路径不记", () => {
    assert.equal(markedListProbe("/plateau/chat/latest_conversations", list({ color_map: { [ACTIVE]: 2 } }), ACTIVE), null);
  });
});

describe("标星/取消收藏响应：只记取值分类与请求编号是否对应", () => {
  const resp = (v: Record<string, unknown>) => JSON.stringify(v);
  const ok = (rid: unknown, extra: Record<string, unknown> = {}) => resp({ success: true, result: { response: "mark_conversation", request_id: rid, result: "ok", success: true, ...extra } });
  test("成功形状：两层 success、编号对应、候选集内结果原样，其他文字只记长度", () => {
    const rec = markResponseProbe(MARK_REQUEST_PATH, markReq(1), ok(1));
    assert.deepEqual(rec, {
      kind: "mark_response", parsed: true, top_success: true, inner_present: true, inner_success: true,
      request_id_match: true, result_value: "ok", result_len: 2, response_value: "other", response_len: 17,
    });
    assert.deepEqual(leaks(rec), []);
  });
  test("取消收藏同样记录；编号不同或不是数字时不对应", () => {
    const unmark = JSON.stringify({ data: { cmd: "unmark_conversation", request_id: 5, uid: ACTIVE } });
    assert.equal(markResponseProbe(UNMARK_REQUEST_PATH, unmark, ok(5))?.kind, "unmark_response");
    assert.equal(markResponseProbe(UNMARK_REQUEST_PATH, unmark, ok(6))?.request_id_match, false);
    assert.equal(markResponseProbe(UNMARK_REQUEST_PATH, unmark, ok("5"))?.request_id_match, false);
    assert.equal(markResponseProbe(MARK_REQUEST_PATH, JSON.stringify({ data: { request_id: "1" } }), ok("1"))?.request_id_match, false);
  });
  test("失败与异常形状只记类别：false、缺失、类型不对、无法解析", () => {
    const fail = markResponseProbe(MARK_REQUEST_PATH, markReq(1), resp({ success: false, result: { request_id: 1, result: ACTIVE, success: "no" } }));
    assert.deepEqual([fail?.top_success, fail?.inner_success, fail?.result_value, fail?.result_len, fail?.response_value], [false, "string", "other", ACTIVE.length, "missing"]);
    assert.deepEqual(leaks(fail), []);
    const bad = markResponseProbe(MARK_REQUEST_PATH, markReq(1), "not json");
    assert.deepEqual([bad?.parsed, bad?.top_success, bad?.inner_present, bad?.inner_success, bad?.request_id_match], [false, "missing", false, "missing", false]);
    assert.equal(markResponseProbe(MARK_REQUEST_PATH, markReq(1), resp({ success: true, result: [1] }))?.inner_present, false);
  });
  test("无关路径不记", () => {
    assert.equal(markResponseProbe(MARKED_LIST_PATH, markReq(1), ok(1)), null);
  });
});
