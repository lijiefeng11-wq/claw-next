import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { PLATFORM_ZOOM_LEVELS, validateIpc } from "../src/core/ipc.js";

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

test("平台页面缩放只接受固定档位；关闭工作台时也可带上（被忽略）", () => {
  const bounds = { x: 230, y: 200, width: 900, height: 400 };
  for (const zoom of PLATFORM_ZOOM_LEVELS) {
    assert.deepEqual(validateIpc("workspace:present", { shop_id: "fixture-a", bounds, zoom }), { channel: "workspace:present", shop_id: "fixture-a", bounds, zoom });
  }
  assert.deepEqual(validateIpc("workspace:present", { shop_id: null, bounds: null, zoom: 1 }), { channel: "workspace:present", shop_id: null, bounds: null });
  for (const zoom of [0.5, 0.85, 1.2, 0, -1, NaN, "0.8", null]) assert.throws(() => validateIpc("workspace:present", { shop_id: "fixture-a", bounds, zoom }), /invalid_workspace_zoom/);
});

test("清理弹窗只接受店铺编号", () => {
  assert.deepEqual(validateIpc("shop:dismissPopups", { shop_id: "fixture-a" }), { channel: "shop:dismissPopups", shop_id: "fixture-a" });
  assert.throws(() => validateIpc("shop:dismissPopups", { shop_id: "../x" }), /invalid_shop_id/);
  assert.throws(() => validateIpc("shop:dismissPopups", { shop_id: "fixture-a", mode: "all" }), /unexpected_field/);
});

test("渲染页面的缩放档位与主进程一致", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "renderer", "app.ts"), "utf8");
  const m = /const ZOOM_LEVELS = \[([^\]]+)\]/.exec(src);
  assert.ok(m);
  assert.deepEqual(m[1].split(",").map(Number), [...PLATFORM_ZOOM_LEVELS]);
});
