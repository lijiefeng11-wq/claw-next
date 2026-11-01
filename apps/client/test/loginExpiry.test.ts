import assert from "node:assert/strict";
import { test } from "node:test";
import { LOGIN_COOKIE_NAME, loginExpiryOf, loginExpiryText } from "../src/core/loginExpiry.js";

// 只用登录凭据的过期时间（虚构数据，不含任何 Cookie 值）。

test("取 PASS_ID 的过期时间；多个同名取最早；会话 Cookie、其他名字、坏值忽略", () => {
  assert.equal(loginExpiryOf([{ name: LOGIN_COOKIE_NAME, expirationDate: 1793760000 }]), 1793760000);
  assert.equal(loginExpiryOf([{ name: "PASS_ID", expirationDate: 1793760000 }, { name: "PASS_ID", expirationDate: 1793700000 }]), 1793700000);
  assert.equal(loginExpiryOf([{ name: "PASS_ID", session: true, expirationDate: 1793760000 }]), null);
  assert.equal(loginExpiryOf([{ name: "api_uid", expirationDate: 1793760000 }]), null);
  for (const bad of [undefined, NaN, Infinity, 0, -1]) assert.equal(loginExpiryOf([{ name: "PASS_ID", expirationDate: bad }]), null);
  assert.equal(loginExpiryOf([]), null);
});

test("界面文字：有效至 / 已过期 / 没有时为空", () => {
  const at = new Date(2026, 10, 4, 9, 58).getTime() / 1000;
  assert.equal(loginExpiryText(at, new Date(2026, 10, 1, 23, 0).getTime()), "平台登录有效至 11-04 09:58");
  assert.equal(loginExpiryText(at, new Date(2026, 10, 4, 10, 0).getTime()), "平台登录已于 11-04 09:58 过期");
  assert.equal(loginExpiryText(null), "");
  assert.equal(loginExpiryText(undefined), "");
});
