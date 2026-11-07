import assert from "node:assert/strict";
import Module from "node:module";
import { test } from "node:test";

const req = Module.createRequire(__filename), electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: {} } } as unknown as NodeModule;
const { nextOpenRetryDelay, OPEN_CONVERSATION_WAIT_MAX_MS } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

test("未读会话退避：2s 起、指数增长、30s 封顶", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(nextOpenRetryDelay), [2000, 4000, 8000, 16000, 30000]);
  assert.equal(nextOpenRetryDelay(99), 30000);
  assert.equal(nextOpenRetryDelay(0), 2000);
});

test("找会话等待上限为 4 秒", () => {
  assert.equal(OPEN_CONVERSATION_WAIT_MAX_MS, 4000);
});
