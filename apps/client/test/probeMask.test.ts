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

test("诊断路径：已知词组成的段保留，其余段替换为 :id", () => {
  assert.equal(maskPath("/plateau/chat/send_message"), "/plateau/chat/send_message");
  assert.equal(maskPath("/janus/api/customService/queryCustomServiceInfo"), "/janus/api/customService/queryCustomServiceInfo");
  assert.equal(maskPath("/chats/9001234/messages"), "/chats/:id/messages");
  assert.equal(maskPath("/v2/api/list"), "/v2/api/list");
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
