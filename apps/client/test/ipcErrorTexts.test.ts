import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

const renderer = fs.readFileSync(path.join(__dirname, "../../src/renderer/app.ts"), "utf8");
const ipc = fs.readFileSync(path.join(__dirname, "../../src/core/ipc.ts"), "utf8");
const main = fs.readFileSync(path.join(__dirname, "../../src/main/main.ts"), "utf8");

function fixedCodes(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

function errorsKeys(): string[] {
  const block = renderer.match(/const ERRORS: Record<string, string> = \{([\s\S]*?)\n  \};/);
  assert.ok(block, "app.ts 里应能找到 ERRORS 对象");
  return [...block[1].matchAll(/^\s*([a-z][a-z0-9_]*):\s*"/gm)].map((m) => m[1]);
}

describe("IPC 错误提示", () => {
  test("ipc.ts 与 main.ts 的固定错误代码都能在 ERRORS 里找到中文说明", () => {
    const codes = [
      ...fixedCodes(ipc, /\bfail\("([^"]+)"\)/g),
      ...fixedCodes(main, /\bIpcValidationError\("([^"]+)"\)/g),
    ];
    assert.ok(codes.length > 0, "应至少提取到一个固定错误代码");
    const keys = errorsKeys();
    const missing = [...new Set(codes)].filter((code) => !keys.includes(code)).sort();
    assert.deepEqual(missing, [], `ERRORS 缺少这些错误代码：${missing.join("、")}`);
  });

  test("ERRORS 末尾新增的 16 条都在，且每条都是中文短句", () => {
    const keys = errorsKeys();
    const added = [
      "shop_not_found",
      "value_required",
      "invalid_adapter",
      "invalid_backend_url",
      "invalid_mode",
      "invalid_on",
      "invalid_kind",
      "invalid_stable_id",
      "invalid_action",
      "invalid_send_behavior",
      "invalid_nav_action",
      "invalid_startup_settings",
      "invalid_workspace_zoom",
      "invalid_workspace_bounds",
      "payload_not_object",
      "unknown_channel",
    ];
    for (const code of added) assert.ok(keys.includes(code), `ERRORS 缺少 ${code}`);
    const block = renderer.match(/const ERRORS: Record<string, string> = \{([\s\S]*?)\n  \};/);
    assert.ok(block);
    for (const code of added) {
      const line = block[1].match(new RegExp(`^\\s*${code}:\\s*"([^"]*)"`, "m"));
      assert.ok(line, `${code} 应有中文说明`);
      assert.ok(line[1].length <= 40, `${code} 的说明不应超过 40 字`);
      assert.ok(!/[。！？]$/.test(line[1]), `${code} 的说明句末不应加句号`);
      assert.match(line[1], /[\u4e00-\u9fff]/, `${code} 的说明应是中文`);
    }
  });

  test("app.ts 处理 unexpected_field: 前缀，两处调用都改用 errorText", () => {
    assert.match(renderer, /function errorText\(code: string \| undefined\): string/);
    assert.match(renderer, /code\?\.startsWith\("unexpected_field:"\)/);
    assert.ok(renderer.includes("请求格式不对（含不认识的字段），请更新客户端或查看日志"));
    assert.equal((renderer.match(/errorText\(r\.error\)/g) ?? []).length, 2);
    assert.ok(!renderer.includes('ERRORS[r.error ?? ""]'), "两处调用应全部替换");
  });
});
