import assert from "node:assert/strict";
import { test } from "node:test";
import { actionProbePath, actionSchemaOf, maskPath } from "../src/main/pddAdapter.js";

const IDS = ["fictionalBuyerAlice", "alice", "ab", "x9f3k2", "chat-alice", "客服小乙"];

test("会话操作接口结构：未知键匿名、保留已知字段名，输出不含任何标识", () => {
  const body = {
    success: true,
    result: {
      status: "ok",
      fictionalBuyerAlice: { status: "offline" },
      alice: { status: "online" },
      ab: 1,
      x9f3k2: [{ uid: "fictional-uid", nick: "虚构" }],
      "chat-alice": { deep: { 客服小乙: { busy: true } } },
    },
    list: [{ fictionalBuyerAlice: 1, target_id: "fictional" }],
  };
  const out = JSON.stringify(actionSchemaOf(JSON.stringify(body)));
  for (const id of IDS) assert.ok(!out.includes(id), "结构输出含有虚构标识");
  assert.ok(!out.includes("fictional") && !out.includes("虚构"), "结构输出含有值");
  const schema = actionSchemaOf(JSON.stringify(body)) as Record<string, any>;
  assert.equal(schema.success, "bool");
  assert.equal(schema.result.status, "str");
  assert.equal(schema.result["<keys>"], 5);
  assert.deepEqual(schema.result["<key>"], { status: "str" });
  assert.deepEqual(schema.list, [{ target_id: "str", "<key>": "num", "<keys>": 1 }]);
  assert.equal(actionSchemaOf("a=1&b=2"), "non_json");
  assert.equal(actionSchemaOf(null), "non_text");
});

test("会话操作接口结构：由常用词拼成的标识键同样匿名（实体字典、静态与实体键混合、嵌套字典）", () => {
  const ENTITY = ["redGreen", "onlineStaff", "userData", "chatList", "statusInfo"];
  const body = {
    participants: { redGreen: { status: "offline" }, onlineStaff: { status: "online" }, userData: { status: "busy" } },
    result: { status: "ok", total: 2, chatList: { statusInfo: { online: true } } },
  };
  const out = JSON.stringify(actionSchemaOf(JSON.stringify(body)));
  for (const id of ENTITY) assert.ok(!out.includes(id), "结构输出含有词表词拼成的虚构标识");
  const schema = actionSchemaOf(JSON.stringify(body)) as Record<string, any>;
  assert.deepEqual(schema["<key>"], { "<key>": { status: "str" }, "<keys>": 3 });
  assert.equal(schema.result.status, "str");
  assert.equal(schema.result.total, "num");
  assert.deepEqual(schema.result["<key>"], { "<key>": { online: "bool" }, "<keys>": 1 });
});

test("会话操作接口结构：深层嵌套数组/对象有界返回，不抛异常", () => {
  const arrays = "[".repeat(20000) + "]".repeat(20000);
  const mixed = '{"data":['.repeat(5000) + "1" + "]}".repeat(5000);
  for (const text of [arrays, mixed]) {
    let out: unknown;
    assert.doesNotThrow(() => (out = actionSchemaOf(text)));
    const s = JSON.stringify(out);
    assert.ok(s.length < 2000, "深层嵌套输出未截断");
    assert.ok(s.includes("deep") || s === '"error"' || s === '"non_json"', "深层嵌套未按上限结束");
  }
  const wide = JSON.stringify({ list: Array.from({ length: 50 }, () => Object.fromEntries(Array.from({ length: 80 }, (_, i) => ["k" + i, { a: [[[1]]] }]))) });
  assert.doesNotThrow(() => actionSchemaOf(wide));
});

test("诊断路径：已确认静态接口与单个已知词保留，其余段替换为 :id", () => {
  for (const p of ["/plateau/chat/send_message", "/janus/api/customService/queryCustomServiceInfo", "/earth/api/mallInfo/commonMallInfo", "/latitude/goodsInstruct/sendToUser", "/plateau/message/send/mallGoodsCard", "/chats/shippingDetail"]) {
    assert.equal(maskPath(p), p);
  }
  assert.equal(maskPath("/chats/9001234/messages"), "/chats/:id/messages");
  assert.equal(maskPath("/v2/api/list"), "/v2/api/list");
});

test("诊断路径隐私反例：常用词拼成的段（驼峰、下划线、连字符）一律匿名", () => {
  for (const id of ["redGreen", "onlineStaff", "userData", "online_staff", "red-green", "chatList", "starMark"]) {
    assert.equal(maskPath(`/conv/transfer/${id}`), "/conv/transfer/:id");
    assert.equal(actionProbePath(`https://mms.pinduoduo.com/conv/transfer/${id}`), "/conv/transfer/:id");
  }
});

test("诊断路径隐私反例：全字母、短标识、编码段、混合编号都不原样保留", () => {
  assert.equal(maskPath("/conv/transfer/fictionalBuyerAlice"), "/conv/transfer/:id");
  assert.equal(maskPath("/conv/transfer/alice"), "/conv/transfer/:id");
  assert.equal(maskPath("/conv/star/ab"), "/conv/star/:id");
  assert.equal(maskPath("/conv/star/%E5%B0%8F%E6%98%8E"), "/conv/star/:id");
  assert.equal(maskPath("/conv/star/x9f3k2"), "/conv/star/:id");
  assert.equal(maskPath("/conv/star/chat-alice"), "/conv/star/:id");
});

test("会话操作候选接口：仅限平台域名，按关键词匹配并打码", () => {
  assert.equal(actionProbePath("https://mms.pinduoduo.com/fake/conv/transfer/fictionalBuyerAlice?uid=1"), "/:id/conv/transfer/:id");
  assert.equal(actionProbePath("https://mms.pinduoduo.com/plateau/chat/star"), "/plateau/chat/star");
  assert.equal(actionProbePath("https://mms.pinduoduo.com/plateau/chat/list"), null);
  assert.equal(actionProbePath("https://example.invalid/plateau/chat/star"), null);
  assert.equal(actionProbePath("not a url"), null);
  assert.equal(actionProbePath(undefined), null);
});
