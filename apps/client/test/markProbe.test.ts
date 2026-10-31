import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { colorValue, MARKED_LIST_PATH, markedListProbe, markRequestProbe, MARK_REQUEST_PATH, UNMARK_REQUEST_PATH } from "../src/main/markProbe.js";

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
    const rec = markedListProbe(MARKED_LIST_PATH, body, ACTIVE, ACTIVE);
    assert.deepEqual(rec, {
      kind: "marked_list", parsed: true, active_known: true, active_same_as_request: true,
      map_present: true, map_entries: 2, active_in_map: true, active_value: 2,
      list_present: true, list_count: 2, from_uid_active: 1, to_uid_active: 0, has_more: false,
    });
    assert.deepEqual(leaks(rec), []);
  });
  test("当前会话不在 map 中：active_in_map=false、数值 missing（不据此推出未收藏）", () => {
    const rec = markedListProbe(MARKED_LIST_PATH, list({ has_more: true, color_map: { [OTHER]: 1 }, marked_conversations: [] }), ACTIVE, ACTIVE);
    assert.equal(rec?.active_in_map, false);
    assert.equal(rec?.active_value, "missing");
    assert.equal(rec?.has_more, true);
  });
  test("当前会话未知、请求与响应期间切换会话", () => {
    const body = list({ color_map: { [ACTIVE]: 1 }, marked_conversations: [] });
    const unknown = markedListProbe(MARKED_LIST_PATH, body, null, null);
    assert.equal(unknown?.active_in_map, false);
    assert.equal(unknown?.active_known, false);
    assert.equal(unknown?.active_same_as_request, false);
    assert.equal(markedListProbe(MARKED_LIST_PATH, body, ACTIVE, OTHER)?.active_same_as_request, false);
    assert.equal(markedListProbe(MARKED_LIST_PATH, body, ACTIVE, null)?.active_same_as_request, false);
  });
  test("map 中当前会话的值越界/小数/字符串只记类别", () => {
    for (const [v, want] of [[11, "out_of_set"], [0.5, "not_integer"], ["2", "str"], [{ c: 1 }, "obj"]] as const) {
      assert.equal(markedListProbe(MARKED_LIST_PATH, list({ color_map: { [ACTIVE]: v } }), ACTIVE, ACTIVE)?.active_value, want);
    }
  });
  test("同名 color_map 嵌在别处、result 不是对象：不认", () => {
    const nested = JSON.stringify({ success: true, result: { extra: { color_map: { [ACTIVE]: 2 } } }, color_map: { [ACTIVE]: 3 } });
    const rec = markedListProbe(MARKED_LIST_PATH, nested, ACTIVE, ACTIVE);
    assert.equal(rec?.map_present, false);
    assert.equal(rec?.active_in_map, false);
    assert.equal(markedListProbe(MARKED_LIST_PATH, JSON.stringify({ result: [1] }), ACTIVE, ACTIVE)?.parsed, false);
    assert.equal(markedListProbe(MARKED_LIST_PATH, JSON.stringify({ result: { color_map: [2] } }), ACTIVE, ACTIVE)?.map_present, false);
  });
  test("原型链上的键不算在 map 中", () => {
    const rec = markedListProbe(MARKED_LIST_PATH, list({ color_map: {} }), "toString", "toString");
    assert.equal(rec?.active_in_map, false);
  });
  test("无关路径不记", () => {
    assert.equal(markedListProbe("/plateau/chat/latest_conversations", list({ color_map: { [ACTIVE]: 2 } }), ACTIVE, ACTIVE), null);
  });
});
