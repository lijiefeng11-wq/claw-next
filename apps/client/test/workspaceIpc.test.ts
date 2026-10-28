import assert from "node:assert/strict";
import { test } from "node:test";
import { validateIpc } from "../src/core/ipc.js";

test("平台布局 IPC 仅接受有效店铺与有限边界，关闭必须成对为空", () => {
  const bounds = { x: 230, y: 200, width: 900, height: 400 };
  assert.deepEqual(validateIpc("workspace:present", { shop_id: "fixture-a", bounds }), { channel: "workspace:present", shop_id: "fixture-a", bounds });
  assert.deepEqual(validateIpc("workspace:present", { shop_id: null, bounds: null }), { channel: "workspace:present", shop_id: null, bounds: null });
  for (const payload of [
    { shop_id: "../x", bounds }, { shop_id: null, bounds }, { shop_id: "fixture-a", bounds: null },
    ...[NaN, Infinity, -1, "900", 20001].map(width => ({ shop_id: "fixture-a", bounds: { ...bounds, width } })),
    { shop_id: "fixture-a", bounds, url: "https://example.invalid" },
    { shop_id: "fixture-a", bounds: { ...bounds, token: "not-allowed" } },
  ]) assert.throws(() => validateIpc("workspace:present", payload));
});
