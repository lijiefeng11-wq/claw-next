import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import Module from "node:module";
import { test } from "node:test";

// 用 Electron 替身驱动真实的登录凭据过期时间跟踪：只读过期时间，凭据变化时刷新并发出状态事件；
// 日志不含 Cookie 值；读不到时不影响适配器。全部为虚构数据。
const req = Module.createRequire(__filename);
const electronPath = req.resolve("electron");
type FakeCookie = { name: string; value: string; expirationDate?: number; session?: boolean };
const jar: FakeCookie[] = [];
const cookies = Object.assign(new EventEmitter(), {
  get: async (filter: { url?: string; name?: string }) => jar.filter((c) => !filter.name || c.name === filter.name),
});
let fromPartitionCalls: string[] = [];
req.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { BrowserWindow: class {}, session: { fromPartition: (p: string) => (fromPartitionCalls.push(p), { cookies }) } },
} as unknown as NodeModule;
const { PddPageAdapter } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

const wait = async (cond: () => boolean) => {
  for (let t = Date.now(); !cond() && Date.now() - t < 2000; ) await new Promise((r) => setTimeout(r, 5));
};

test("读取本店分区 PASS_ID 的过期时间；凭据变化时刷新并发出状态事件；日志不含值", async () => {
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    jar.push({ name: "PASS_ID", value: "SECRET-VALUE-1", expirationDate: 1793760000 }, { name: "api_uid", value: "SECRET-OTHER", expirationDate: 1890000000 });
    const adapter = new PddPageAdapter("fixture-shop", "虚构店铺", null) as unknown as {
      watchLoginExpiry(): void;
      loginExpiresAt: number | null;
      onEvent(cb: (e: { type: string }) => void): void;
    };
    const events: string[] = [];
    adapter.onEvent((e) => void events.push(e.type));
    adapter.watchLoginExpiry();
    await wait(() => adapter.loginExpiresAt !== null);
    assert.equal(adapter.loginExpiresAt, 1793760000);
    assert.deepEqual(fromPartitionCalls, ["persist:claw-next-shop-fixture-shop"]);
    assert.ok(events.includes("status"));
    // 重新扫码：凭据换成新的过期时间。
    jar.splice(0, 1, { name: "PASS_ID", value: "SECRET-VALUE-2", expirationDate: 1794000000 });
    cookies.emit("changed", {}, jar[0], "explicit", false);
    await wait(() => adapter.loginExpiresAt === 1794000000);
    // 退出登录：凭据被删除。
    jar.splice(0, 1);
    cookies.emit("changed", {}, { name: "PASS_ID", value: "SECRET-VALUE-2" }, "explicit", true);
    await wait(() => adapter.loginExpiresAt === null);
    // 其他 Cookie 变化不触发重读。
    const before = events.length;
    cookies.emit("changed", {}, { name: "api_uid", value: "SECRET-OTHER" }, "explicit", false);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(events.length, before);
    // 只跟踪一次。
    adapter.watchLoginExpiry();
    assert.equal(fromPartitionCalls.length, 1);
  } finally {
    console.log = realLog;
  }
  const text = logs.join("\n");
  for (const secret of ["SECRET-VALUE-1", "SECRET-VALUE-2", "SECRET-OTHER"]) assert.ok(!text.includes(secret), `日志不得含 ${secret}`);
  assert.match(text, /platform login expires_at=/);
});
