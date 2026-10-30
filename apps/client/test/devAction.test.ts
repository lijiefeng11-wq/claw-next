import assert from "node:assert/strict";
import { test } from "node:test";
import { DEV_ACTION_MAX_TTL_MS, parseDevAction } from "../src/core/devAction.js";

const now = 1_000_000;
const base = { id: "req-0001-abcd", conv: "0123456789abcdef", exp: now + 30_000 };
const parse = (v: unknown, consumed: string[] = []) => parseDevAction(JSON.stringify(v), now, new Set(consumed));

test("诊断测试请求：合法的收藏与转移请求被接受", () => {
  assert.deepEqual(parse({ ...base, action: "star", color: "red" }), { id: base.id, conv: base.conv, exp: base.exp, action: "star", color: "red" });
  assert.deepEqual(parse({ ...base, action: "transfer", target: " 主账号 " }), { id: base.id, conv: base.conv, exp: base.exp, action: "transfer", target: "主账号", allowUnfavorite: false });
  assert.equal((parse({ ...base, action: "transfer", target: "主账号", allow_unfavorite: true }) as { allowUnfavorite: boolean }).allowUnfavorite, true);
  assert.equal(parse({ ...base, action: "transfer", target: "主账号", allow_unfavorite: "yes" }), "bad_allow_unfavorite");
  assert.equal((parse({ ...base, action: "transfer_inspect", target: "主账号" }) as { action: string }).action, "transfer_inspect");
});

test("诊断测试请求：过期、有效期过长、重复 id 一律不执行", () => {
  assert.equal(parse({ ...base, exp: now - 1, action: "star", color: "red" }), "expired");
  assert.equal(parse({ ...base, exp: now + DEV_ACTION_MAX_TTL_MS + 1, action: "star", color: "red" }), "exp_too_far");
  assert.equal(parse({ ...base, action: "star", color: "red" }, [base.id]), "id_already_used");
});

test("诊断测试请求：有效期随请求带出，供执行链在每次点击前核对", () => {
  assert.equal((parse({ ...base, action: "star", color: "red" }) as { exp: number }).exp, base.exp);
  assert.equal((parse({ ...base, action: "transfer", target: "主账号" }) as { exp: number }).exp, base.exp);
});

test("诊断测试请求：缺对话令牌或格式不符不执行", () => {
  assert.equal(parse({ ...base, conv: undefined, action: "star", color: "red" }), "bad_conv");
  assert.equal(parse({ ...base, conv: "uid-123", action: "star", color: "red" }), "bad_conv");
  assert.equal(parse({ ...base, id: "x", action: "star", color: "red" }), "bad_id");
  assert.equal(parse({ ...base, action: "star", color: "purple" }), "bad_color");
  assert.equal(parse({ ...base, action: "transfer", target: "" }), "bad_target");
  assert.equal(parse({ ...base, action: "send", target: "主账号" }), "bad_action");
  assert.equal(parseDevAction("red", now, new Set()), "bad_json");
  assert.equal(parse(["x"]), "bad_shape");
});
