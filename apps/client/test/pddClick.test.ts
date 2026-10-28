import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebContents } from "electron";
import { CLICK_COMMAND_TIMEOUT_MS, dispatchPageClick } from "../src/main/pddClick.js";

type Sent = { method: string; params: Record<string, unknown> };
type Responder = (sent: Sent) => Promise<unknown>;
type Contents = Parameters<typeof dispatchPageClick>[0];

/** 伪造 WebContents 的最小形状：记录每条命令，并按需成功/拒绝/挂起。 */
function fake(responder: Responder = () => Promise.resolve({})) {
  const sent: Sent[] = [];
  const state = { destroyed: false, attached: true };
  // 只实现被测代码用到的成员，其余 Debugger 成员在测试中不需要。
  const contents: Contents = {
    isDestroyed: () => state.destroyed,
    debugger: {
      isAttached: () => state.attached,
      sendCommand: (method: string, params: Record<string, unknown>) => {
        const s = { method, params };
        sent.push(s);
        return responder(s);
      },
    },
  } as unknown as Pick<WebContents, "isDestroyed" | "debugger">;
  return { contents, sent, state };
}

const never = () => new Promise<never>(() => undefined);
const types = (sent: Sent[]) => sent.map((s) => s.params.type);

test("dispatches press then release at exact CSS viewport coordinates", async () => {
  const { contents, sent } = fake();
  let calls = 0;
  const r = await dispatchPageClick(contents, { x: 412, y: 87 }, () => null, () => calls++);
  assert.deepEqual(r, { status: "dispatched" });
  assert.deepEqual(types(sent), ["mousePressed", "mouseReleased"]);
  assert.deepEqual(
    sent.map((s) => s.method),
    ["Input.dispatchMouseEvent", "Input.dispatchMouseEvent"],
  );
  for (const s of sent) assert.deepEqual(s.params, { type: s.params.type, x: 412, y: 87, button: "left", clickCount: 1 });
  assert.equal(calls, 1);
});

test("fractional and zero coordinates pass through unmodified", async () => {
  const { contents, sent } = fake();
  const r = await dispatchPageClick(contents, { x: 0, y: 12.5 }, () => null);
  assert.deepEqual(r, { status: "dispatched" });
  assert.equal(sent[0].params.x, 0);
  assert.equal(sent[1].params.y, 12.5);
});

test("recheck blocking reason returns not_sent with zero commands", async () => {
  const { contents, sent } = fake();
  let calls = 0;
  const r = await dispatchPageClick(contents, { x: 10, y: 10 }, () => "generation_changed", () => calls++);
  assert.deepEqual(r, { status: "not_sent", reason: "generation_changed" });
  assert.equal(sent.length, 0);
  assert.equal(calls, 0);
});

test("recheck blocking on current generation/owner/deadline state sends nothing", async () => {
  const { contents, sent, state } = fake();
  const r = await dispatchPageClick(contents, { x: 1, y: 1 }, () => {
    state.destroyed = true;
    return "owner_lost";
  });
  assert.deepEqual(r, { status: "not_sent", reason: "owner_lost" });
  assert.equal(sent.length, 0);
});

test("destroyed contents and detached debugger return not_sent", async () => {
  const destroyed = fake();
  destroyed.state.destroyed = true;
  assert.deepEqual(await dispatchPageClick(destroyed.contents, { x: 5, y: 5 }, () => null), { status: "not_sent", reason: "contents_destroyed" });
  assert.equal(destroyed.sent.length, 0);
  const detached = fake();
  detached.state.attached = false;
  assert.deepEqual(await dispatchPageClick(detached.contents, { x: 5, y: 5 }, () => null), { status: "not_sent", reason: "debugger_not_attached" });
  assert.equal(detached.sent.length, 0);
});

test("non-finite or negative points return invalid_point with zero commands", async () => {
  const { contents, sent } = fake();
  for (const p of [
    { x: Number.NaN, y: 1 },
    { x: 1, y: Number.POSITIVE_INFINITY },
    { x: -1, y: 1 },
    { x: 1, y: -0.5 },
  ]) {
    assert.deepEqual(await dispatchPageClick(contents, p, () => null), { status: "not_sent", reason: "invalid_point" });
  }
  assert.equal(sent.length, 0);
});

test("throwing preflight callbacks return not_sent with zero commands", async () => {
  const throwing = fake();
  throwing.contents.isDestroyed = () => {
    throw new Error("boom");
  };
  assert.deepEqual(await dispatchPageClick(throwing.contents, { x: 1, y: 2 }, () => null), { status: "not_sent", reason: "preflight_failed" });
  assert.equal(throwing.sent.length, 0);
  const recheckThrows = fake();
  assert.deepEqual(
    await dispatchPageClick(recheckThrows.contents, { x: 1, y: 2 }, () => {
      throw new Error("boom");
    }),
    { status: "not_sent", reason: "recheck_failed" },
  );
  assert.equal(recheckThrows.sent.length, 0);
  const beforeThrows = fake();
  assert.deepEqual(
    await dispatchPageClick(beforeThrows.contents, { x: 1, y: 2 }, () => null, () => {
      throw new Error("boom");
    }),
    { status: "not_sent", reason: "before_press_failed" },
  );
  assert.equal(beforeThrows.sent.length, 0);
});

test("press rejection is unknown, no release, beforePress ran once", async () => {
  const { contents, sent } = fake(() => Promise.reject(new Error("cdp")));
  let calls = 0;
  const r = await dispatchPageClick(contents, { x: 3, y: 4 }, () => null, () => calls++);
  assert.deepEqual(r, { status: "unknown", reason: "press_command_rejected" });
  assert.deepEqual(types(sent), ["mousePressed"]);
  assert.equal(calls, 1);
});

test("press timeout with late resolution is unknown and never sends release", { timeout: 5000 }, async () => {
  let resolvePress: (v: unknown) => void = () => undefined;
  const { contents, sent } = fake(() => new Promise<unknown>((res) => (resolvePress = res)));
  const started = Date.now();
  const r = await dispatchPageClick(contents, { x: 9, y: 9 }, () => null);
  const elapsed = Date.now() - started;
  assert.deepEqual(r, { status: "unknown", reason: "press_command_timeout" });
  assert.ok(elapsed >= CLICK_COMMAND_TIMEOUT_MS - 20 && elapsed < 3000, `elapsed ${elapsed}`);
  resolvePress({});
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(types(sent), ["mousePressed"]);
});

test("release rejection after successful press is unknown", { timeout: 5000 }, async () => {
  const { contents, sent } = fake((s) => (s.params.type === "mouseReleased" ? Promise.reject(new Error("cdp")) : Promise.resolve({})));
  const r = await dispatchPageClick(contents, { x: 7, y: 8 }, () => null);
  assert.deepEqual(r, { status: "unknown", reason: "release_command_rejected" });
  assert.deepEqual(types(sent), ["mousePressed", "mouseReleased"]);
});

test("release timeout is unknown and does not retry", { timeout: 5000 }, async () => {
  const { contents, sent } = fake((s) => (s.params.type === "mouseReleased" ? never() : Promise.resolve({})));
  const r = await dispatchPageClick(contents, { x: 2, y: 2 }, () => null);
  assert.deepEqual(r, { status: "unknown", reason: "release_command_timeout" });
  assert.deepEqual(types(sent), ["mousePressed", "mouseReleased"]);
});
