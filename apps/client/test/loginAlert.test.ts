import assert from "node:assert/strict";
import { test } from "node:test";
import { shopAlert, NOT_LOGGED_IN_ALERT_MS, LOGIN_EXPIRY_WARN_MS } from "../src/core/pageHealth.js";
import type { PageHealthView, PageState } from "../src/core/pageHealth.js";

function page(overrides: Partial<PageHealthView> = {}): PageHealthView {
  return {
    state: "ok",
    detail: "",
    since: 1_000,
    reloads: 0,
    gave_up: false,
    session_lost: false,
    ...overrides,
  };
}

test("常量值符合需求", () => {
  assert.equal(NOT_LOGGED_IN_ALERT_MS, 60000);
  assert.equal(LOGIN_EXPIRY_WARN_MS, 12 * 3600 * 1000);
});

test("未传 now 时新规则不生效", () => {
  const notLoggedIn = page({ since: 0 });
  assert.equal(shopAlert({ adapter: "pdd", pageOpen: true, logged_in: false, page: notLoggedIn }), null);

  const expiring = page({ since: 0 });
  assert.equal(shopAlert({ adapter: "pdd", pageOpen: true, logged_in: true, page: expiring, login_expires_at: 1 }), null);
});

test("未登录提醒：59999 ms 不提醒，60000 ms 提醒", () => {
  const since = 1_000_000;
  const base = { adapter: "pdd" as const, pageOpen: true, logged_in: false, page: page({ since }) };
  assert.equal(shopAlert({ ...base, now: since + NOT_LOGGED_IN_ALERT_MS - 1 }), null);
  assert.deepEqual(shopAlert({ ...base, now: since + NOT_LOGGED_IN_ALERT_MS }), { level: "warn", text: "平台未登录，请扫码登录" });
});

test("页面 state 不是 ok 时不发未登录提醒", () => {
  const since = 0;
  const now = NOT_LOGGED_IN_ALERT_MS + 1;
  const states: PageState[] = ["loading", "load_failed", "crashed", "unresponsive"];
  for (const state of states) {
    const alert = shopAlert({ adapter: "pdd", pageOpen: true, logged_in: false, page: page({ state, since }), now });
    assert.notEqual(alert?.text, "平台未登录，请扫码登录", state);
  }
  assert.equal(shopAlert({ adapter: "pdd", pageOpen: true, logged_in: false, page: page({ state: "loading", since }), now }), null);
});

test("session_lost 优先于未登录提醒，仍返回原 error 文字", () => {
  const p = page({ since: 0, session_lost: true });
  assert.deepEqual(
    shopAlert({ adapter: "pdd", pageOpen: true, logged_in: false, page: p, now: NOT_LOGGED_IN_ALERT_MS + 1 }),
    { level: "error", text: "平台登录已失效，请重新扫码" },
  );
});

test("登录即将过期：12 小时整提醒，12 小时零 1 秒不提醒，已过期也提醒", () => {
  const expiresAt = 2_000_000;
  const expiresAtMs = expiresAt * 1000;
  const p = page({ since: 0 });
  const input = (now: number) => ({
    adapter: "pdd" as const,
    pageOpen: true,
    logged_in: true,
    page: p,
    now,
    login_expires_at: expiresAt,
  });
  assert.deepEqual(shopAlert(input(expiresAtMs - LOGIN_EXPIRY_WARN_MS)), { level: "warn", text: "平台登录 12 小时内过期，方便时请重新扫码" });
  assert.equal(shopAlert(input(expiresAtMs - LOGIN_EXPIRY_WARN_MS - 1_000)), null);
  assert.deepEqual(shopAlert(input(expiresAtMs + 1)), { level: "warn", text: "平台登录 12 小时内过期，方便时请重新扫码" });
});

test("login_expires_at 为 null 或 NaN 时不提醒", () => {
  const p = page({ since: 0 });
  assert.equal(shopAlert({ adapter: "pdd", pageOpen: true, logged_in: true, page: p, now: 1_000_000, login_expires_at: null }), null);
  assert.equal(shopAlert({ adapter: "pdd", pageOpen: true, logged_in: true, page: p, now: 1_000_000, login_expires_at: Number.NaN }), null);
  assert.equal(shopAlert({ adapter: "pdd", pageOpen: true, logged_in: true, page: p, now: 1_000_000 }), null);
});

test("模拟店铺、页面关闭或页面为空时不提醒", () => {
  const p = page({ since: 0 });
  assert.equal(shopAlert({ adapter: "mock", pageOpen: true, logged_in: false, page: p, now: NOT_LOGGED_IN_ALERT_MS }), null);
  assert.equal(shopAlert({ adapter: "mock", pageOpen: true, logged_in: true, page: p, now: 1_000, login_expires_at: 1 }), null);
  assert.equal(shopAlert({ adapter: "pdd", pageOpen: false, logged_in: false, page: p, now: NOT_LOGGED_IN_ALERT_MS }), null);
  assert.equal(shopAlert({ adapter: "pdd", pageOpen: false, logged_in: true, page: p, now: 1_000, login_expires_at: 1 }), null);
  assert.equal(shopAlert({ adapter: "pdd", pageOpen: true, logged_in: false, page: null, now: NOT_LOGGED_IN_ALERT_MS }), null);
});

test("gave_up 优先于新规则", () => {
  const p = page({ since: 0, gave_up: true });
  assert.deepEqual(
    shopAlert({ adapter: "pdd", pageOpen: true, logged_in: false, page: p, now: NOT_LOGGED_IN_ALERT_MS }),
    { level: "error", text: "平台页面异常，自动恢复失败" },
  );
  assert.deepEqual(
    shopAlert({ adapter: "pdd", pageOpen: true, logged_in: true, page: p, now: 1_000, login_expires_at: 1 }),
    { level: "error", text: "平台页面异常，自动恢复失败" },
  );
});
