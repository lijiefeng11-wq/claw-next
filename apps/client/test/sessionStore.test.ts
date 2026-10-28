import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { MockPlatformAdapter } from "../src/core/mockAdapter.js";
import { ShopRuntime, type ShopConfig } from "../src/core/runtime.js";
import { SessionStore, restorePlan, runRestore } from "../src/core/sessionStore.js";
import { FAST, TOKEN_A, settle, startBackend, tempDir, waitFor, type TestBackend } from "./helpers.js";

// 启动恢复上次打开着的店铺：全部为虚构店铺配置与虚构消息，不含真实口令。

const shop = (shop_id: string, adapter: ShopConfig["adapter"], mode: ShopConfig["mode"] = "auto"): ShopConfig => ({ shop_id, display_name: shop_id, backend_url: "http://127.0.0.1:18880", platform_shop_id: `pdd-${shop_id}`, adapter, mode });

const withDir = async (fn: (dir: string) => void | Promise<void>) => {
  const dir = tempDir("claw-session-");
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** 可手动放行的异步操作，用来构造并发时序。 */
function gate() {
  let open!: () => void;
  const done = new Promise<void>((r) => (open = r));
  return { done, open };
}

const tick = () => new Promise((r) => setImmediate(r));

// ---------- 记录 ----------

test("记录随用户操作更新并落盘；重新打开后读回；未记录的店铺视为都没开", () =>
  withDir((dir) => {
    const a = new SessionStore(dir);
    assert.deepEqual(a.get("shop-a"), { connected: false, page_open: false });
    a.set("shop-a", { page_open: true });
    a.set("shop-a", { connected: true });
    a.set("shop-b", { connected: true });
    a.set("shop-b", { connected: false });
    const b = new SessionStore(dir);
    assert.deepEqual(b.get("shop-a"), { connected: true, page_open: true });
    assert.deepEqual(b.get("shop-b"), { connected: false, page_open: false });
    b.remove("shop-a");
    assert.deepEqual(new SessionStore(dir).get("shop-a"), { connected: false, page_open: false });
    const raw = fs.readFileSync(path.join(dir, "session.json"), "utf8");
    assert.ok(!/token|password|口令/i.test(raw));
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "session.json")).mode & 0o777, 0o600);
  }));

test("记录文件损坏：当作上次没有打开的店铺，不阻止启动", () =>
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, "session.json"), "{not json");
    assert.deepEqual(restorePlan([shop("shop-a", "pdd")], new SessionStore(dir), () => true), { steps: [], skipped: [] });
  }));

test("店铺编号为 __proto__、constructor 等特殊名字也能记录并恢复", () =>
  withDir((dir) => {
    const s = new SessionStore(dir);
    for (const id of ["__proto__", "constructor", "toString"]) s.set(id, { page_open: true, connected: true });
    const again = new SessionStore(dir);
    for (const id of ["__proto__", "constructor", "toString"]) assert.deepEqual(again.get(id), { connected: true, page_open: true });
    assert.deepEqual(new SessionStore(dir).get("hasOwnProperty"), { connected: false, page_open: false });
    assert.deepEqual(restorePlan([shop("__proto__", "pdd"), shop("constructor", "mock")], again, () => true).steps, [
      { shop_id: "__proto__", action: "connect" },
      { shop_id: "__proto__", action: "open_page" },
      { shop_id: "constructor", action: "connect" },
    ]);
    again.remove("__proto__");
    assert.deepEqual(new SessionStore(dir).get("__proto__"), { connected: false, page_open: false });
  }));

// ---------- 恢复计划 ----------

test("恢复计划：同一店先连后台再开平台页；模拟平台只连后台；缺口令只开平台页并记原因；已删除店铺忽略", () =>
  withDir((dir) => {
    const s = new SessionStore(dir);
    s.set("pdd-1", { page_open: true, connected: true });
    s.set("pdd-2", { page_open: true });
    s.set("mock-1", { page_open: true, connected: true });
    s.set("no-token", { connected: true, page_open: true });
    s.set("removed", { page_open: true, connected: true });
    s.set("closed", { page_open: false, connected: false });
    const configs = [shop("pdd-1", "pdd"), shop("pdd-2", "pdd", "observe"), shop("mock-1", "mock"), shop("no-token", "pdd"), shop("closed", "pdd")];
    const plan = restorePlan(configs, s, (id) => id !== "no-token");
    assert.deepEqual(plan.steps, [
      { shop_id: "pdd-1", action: "connect" },
      { shop_id: "pdd-1", action: "open_page" },
      { shop_id: "pdd-2", action: "open_page" },
      { shop_id: "mock-1", action: "connect" },
      { shop_id: "no-token", action: "open_page" },
    ]);
    assert.deepEqual(plan.skipped, [{ shop_id: "no-token", reason: "token_missing" }]);
    // 恢复只依据记录，不含改运行模式的步骤。
    assert.ok(plan.steps.every((x) => x.action === "open_page" || x.action === "connect"));
  }));

// ---------- 恢复执行（并发与取消） ----------

test("不同店铺并行恢复：一家后台连接慢，不拖住其他店铺", () =>
  withDir(async (dir) => {
    const sessions = new SessionStore(dir);
    for (const id of ["slow", "fast"]) sessions.set(id, { connected: true, page_open: true });
    const calls: string[] = [];
    const slow = gate();
    const running = runRestore(restorePlan([shop("slow", "pdd"), shop("fast", "pdd")], sessions, () => true).steps, {
      sessions,
      touched: () => false,
      openPage: async (id) => void calls.push(`open:${id}`),
      connect: async (id) => {
        calls.push(`connect:${id}`);
        if (id === "slow") await slow.done;
      },
      log: () => undefined,
    });
    await tick();
    assert.deepEqual(calls, ["connect:slow", "connect:fast", "open:fast"], "slow 还在连接时 fast 已完成恢复");
    slow.open();
    await running;
    assert.deepEqual(calls, ["connect:slow", "connect:fast", "open:fast", "open:slow"]);
  }));

test("恢复中某店正在连接时用户断开/关闭了它：该店后续步骤不再执行，其他店照常", () =>
  withDir(async (dir) => {
    const sessions = new SessionStore(dir);
    sessions.set("shop-a", { connected: true, page_open: true });
    sessions.set("shop-b", { connected: true, page_open: true });
    const touched = new Set<string>();
    const calls: string[] = [];
    const connecting = gate();
    const logs: string[] = [];
    const running = runRestore(restorePlan([shop("shop-a", "pdd"), shop("shop-b", "pdd")], sessions, () => true).steps, {
      sessions,
      touched: (id) => touched.has(id),
      openPage: async (id) => void calls.push(`open:${id}`),
      connect: async (id) => {
        calls.push(`connect:${id}`);
        if (id === "shop-a") await connecting.done;
      },
      log: (l) => logs.push(l),
    });
    await tick();
    // 界面上对 A 手动断开：与 main.ts 的 shop:disconnect 一致，先标记再清记录。
    touched.add("shop-a");
    sessions.set("shop-a", { connected: false, page_open: false });
    connecting.open();
    await running;
    assert.deepEqual(calls, ["connect:shop-a", "connect:shop-b", "open:shop-b"]);
    assert.ok(logs.some((l) => l.includes("[shop-a] restore open_page skipped reason=user_changed")));
  }));

test("恢复执行前记录已被改成关闭：跳过该店；单步失败不影响其他店铺与该店后续步骤", () =>
  withDir(async (dir) => {
    const sessions = new SessionStore(dir);
    sessions.set("shop-a", { connected: true, page_open: true });
    sessions.set("shop-b", { connected: true });
    sessions.set("shop-c", { connected: true });
    const steps = restorePlan([shop("shop-a", "pdd"), shop("shop-b", "mock"), shop("shop-c", "mock")], sessions, () => true).steps;
    sessions.set("shop-b", { connected: false });
    const calls: string[] = [];
    await runRestore(steps, {
      sessions,
      touched: () => false,
      openPage: async (id) => void calls.push(`open:${id}`),
      connect: async (id) => {
        calls.push(`connect:${id}`);
        if (id === "shop-a") throw new Error("backend_unreachable");
      },
      log: () => undefined,
    });
    assert.deepEqual(calls.sort(), ["connect:shop-a", "connect:shop-c", "open:shop-a"]);
  }));

// ---------- 手动操作的代次 ----------

/** 按 main.ts 的写法模拟一次手动操作：开始时声明会改的项并领代次，await 后按代次提交。 */
async function op(sessions: SessionStore, shopId: string, fields: ("connected" | "page_open")[], work: Promise<void>, patch: { connected?: boolean; page_open?: boolean }) {
  const g = sessions.begin(shopId, fields);
  await work;
  return sessions.commit(shopId, g, patch);
}
const LOGIN = ["page_open"] as ("connected" | "page_open")[];
const LOGOUT = LOGIN;
const CONNECT = ["connected"] as ("connected" | "page_open")[];
const DISCONNECT = ["connected", "page_open"] as ("connected" | "page_open")[];

test("较早的打开平台页在关闭/断开之后才完成：不把记录改回 page_open", async () => {
  for (const [fields, later] of [[LOGOUT, { page_open: false }], [DISCONNECT, { connected: false, page_open: false }]] as const) {
    await withDir(async (dir) => {
      const sessions = new SessionStore(dir);
      const loading = gate();
      const login = op(sessions, "shop-a", LOGIN, loading.done, { page_open: true });
      assert.equal(await op(sessions, "shop-a", [...fields], Promise.resolve(), later), true);
      loading.open();
      assert.equal(await login, false, "旧操作被丢弃");
      assert.deepEqual(new SessionStore(dir).get("shop-a"), { connected: false, page_open: false });
      assert.deepEqual(restorePlan([shop("shop-a", "pdd")], new SessionStore(dir), () => true).steps, []);
    });
  }
});

test("较早的连接在断开之后才完成：不把记录改回 connected", () =>
  withDir(async (dir) => {
    const sessions = new SessionStore(dir);
    const connecting = gate();
    const connect = op(sessions, "shop-a", CONNECT, connecting.done, { connected: true });
    await op(sessions, "shop-a", DISCONNECT, Promise.resolve(), { connected: false, page_open: false });
    connecting.open();
    assert.equal(await connect, false);
    assert.deepEqual(new SessionStore(dir).get("shop-a"), { connected: false, page_open: false });
  }));

test("打开平台页与连接后台同时进行：两者都成功时两项都保存（正反两种重叠）", async () => {
  // 打开挂起 → 连接完成 → 打开完成；以及连接挂起 → 打开完成 → 连接完成。
  for (const first of ["login", "connect"] as const) {
    await withDir(async (dir) => {
      const sessions = new SessionStore(dir);
      const slow = gate();
      const a = first === "login" ? op(sessions, "shop-a", LOGIN, slow.done, { page_open: true }) : op(sessions, "shop-a", CONNECT, slow.done, { connected: true });
      const b = first === "login" ? op(sessions, "shop-a", CONNECT, Promise.resolve(), { connected: true }) : op(sessions, "shop-a", LOGIN, Promise.resolve(), { page_open: true });
      assert.equal(await b, true);
      slow.open();
      assert.equal(await a, true);
      assert.deepEqual(new SessionStore(dir).get("shop-a"), { connected: true, page_open: true });
      assert.deepEqual(restorePlan([shop("shop-a", "pdd")], new SessionStore(dir), () => true).steps, [
        { shop_id: "shop-a", action: "connect" },
        { shop_id: "shop-a", action: "open_page" },
      ]);
    });
  }
});

test("打开过程中删除店铺：旧操作完成后不重新写回已删除的记录", () =>
  withDir(async (dir) => {
    const sessions = new SessionStore(dir);
    sessions.set("shop-a", { connected: true });
    const loading = gate();
    const login = op(sessions, "shop-a", LOGIN, loading.done, { page_open: true });
    sessions.remove("shop-a");
    loading.open();
    assert.equal(await login, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8")).shops, []);
  }));

test("另一家店的操作互不影响", () =>
  withDir(async (dir) => {
    const sessions = new SessionStore(dir);
    const slowB = gate();
    const b = op(sessions, "shop-b", CONNECT, slowB.done, { connected: true });
    assert.equal(await op(sessions, "shop-a", DISCONNECT, Promise.resolve(), { connected: false, page_open: false }), true);
    slowB.open();
    assert.equal(await b, true);
    assert.deepEqual(sessions.get("shop-b"), { connected: true, page_open: false });
  }));

// ---------- 接线回归：真实运行时 + 模拟平台 + 虚构后台 ----------

describe("恢复顺序与消息接收（真实 ShopRuntime）", () => {
  let backend: TestBackend;
  before(async () => {
    backend = await startBackend();
    await backend.settings("shop-a", true);
  });
  after(async () => backend.stop());

  /** 按恢复执行器走一遍：平台页“加载”期间（login 已完成、页面请求未结束）到达一条实时买家消息。 */
  async function restoreWithMessageDuringLoad(order: "planned" | "page_first") {
    const dir = tempDir("claw-restore-wire-");
    const sessions = new SessionStore(path.join(dir, "config"));
    sessions.set("shop-a", { connected: true, page_open: true });
    const config: ShopConfig = { shop_id: "shop-a", display_name: "shop-a", backend_url: backend.url, platform_shop_id: "pdd-shop-a", adapter: "mock", mode: "observe" };
    const mock = new MockPlatformAdapter({ platformShopId: config.platform_shop_id, displayName: "shop-a" });
    let rt: ShopRuntime | null = null;
    const connect = async () => {
      rt = new ShopRuntime({ config, token: TOKEN_A, adapter: mock, dataDir: path.join(dir, "data"), timing: FAST });
      await rt.start();
    };
    const openPage = async () => {
      await mock.login();
      // 页面已登录、仍在加载时平台推来一条新消息。
      mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "加载期间的虚构消息" });
      await new Promise((r) => setTimeout(r, 50));
    };
    // 计划里 pdd 店才有 open_page；这里用 pdd 配置生成计划，执行时用模拟平台。
    const steps = restorePlan([{ ...config, adapter: "pdd" }], sessions, () => true).steps;
    const ordered = order === "planned" ? steps : [...steps].sort((a) => (a.action === "open_page" ? -1 : 1));
    await runRestore(ordered, { sessions, touched: () => false, openPage, connect, log: () => undefined });
    await waitFor(() => rt !== null, "runtime");
    const r = rt as unknown as ShopRuntime;
    await settle(r);
    const seen = r.journal.conversations.get("buyer-1")?.messages.some((m) => m.content === "加载期间的虚构消息") ?? false;
    await r.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    return seen;
  }

  test("按恢复计划（先连接后台再开平台页）：页面加载期间到达的消息被运行时记录", async () => {
    assert.equal(await restoreWithMessageDuringLoad("planned"), true);
  });

  test("对照：若先开平台页再连接，加载期间的消息无人接收而丢失（说明顺序的必要性）", async () => {
    assert.equal(await restoreWithMessageDuringLoad("page_first"), false);
  });
});
