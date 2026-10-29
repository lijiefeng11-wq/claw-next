import assert from "node:assert/strict";
import { test } from "node:test";
import { actionProbePath, maskPath } from "../src/main/pddAdapter.js";

test("诊断路径：含长数字或长编号的段替换为 :id，普通段保留", () => {
  assert.equal(maskPath("/plateau/chat/send_message"), "/plateau/chat/send_message");
  assert.equal(maskPath("/chats/9001234/messages"), "/chats/:id/messages");
  assert.equal(maskPath("/a/x9f3k2m8q7w1e5r4t6/b"), "/a/:id/b");
  assert.equal(maskPath("/v2/api/h5"), "/v2/api/h5");
});

test("会话操作候选接口：仅限平台域名，按关键词匹配并打码", () => {
  assert.equal(actionProbePath("https://mms.pinduoduo.com/fake/conv/transfer/12345678?uid=1"), "/fake/conv/transfer/:id");
  assert.equal(actionProbePath("https://mms.pinduoduo.com/fake/chat/star"), "/fake/chat/star");
  assert.equal(actionProbePath("https://mms.pinduoduo.com/fake/chat/list"), null);
  assert.equal(actionProbePath("https://example.invalid/fake/chat/star"), null);
  assert.equal(actionProbePath("not a url"), null);
  assert.equal(actionProbePath(undefined), null);
});
