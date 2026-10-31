import assert from "node:assert/strict";
import Module from "node:module";
import { describe, test } from "node:test";
import type { MarkResult } from "../src/core/adapter.js";
import type { MarkColor } from "../src/core/protocol.js";

// 用 Electron 替身实例化真实的 PddPageAdapter，经真实的网络监听（Fetch 拦截 + Network 响应）执行标星；
// 不创建真实窗口、不连接平台。全部为虚构编号与虚构响应。
const req = Module.createRequire(__filename);
const electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: { fromPartition: () => ({}) } } } as unknown as NodeModule;
const { PddPageAdapter, CONV_STAR_SNAPSHOT, starOptionsScript } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

const BUYER = "880011223344";
const OTHER = "880099887766";
const MARK = "/plateau/chat/mark_conversation";
const UNMARK = "/plateau/chat/unmark_conversation";
const REQ_ID = 1790000000123;
const okBody = (requestId: number = REQ_ID) => JSON.stringify({ success: true, result: { success: true, result: "ok", request_id: requestId, response: "虚构" } });

type Option = { color: string; checked: boolean; x: number; y: number };
type Page = {
  /** 同一次快照里打开的会话 key 与星标是否已收藏；字符串为脚本返回的原因。 */
  snap: { keys: unknown[]; active: boolean } | string;
  star: { x: number; y: number; active: boolean } | string;
  /** 悬停后第几次读取浮层才出现（之前返回 popover_missing）。 */
  popAfter: number;
  pop: { keys: unknown[]; active: boolean; options: Option[] } | string;
  owned: string;
  /** 点击后再读快照（页面观察）。 */
  after: { keys: unknown[]; active: boolean } | string;
};

const OPTIONS: Option[] = [
  { color: "orange", checked: false, x: 100, y: 200 },
  { color: "red", checked: false, x: 100, y: 230 },
  { color: "green", checked: false, x: 100, y: 260 },
  { color: "blue", checked: false, x: 100, y: 290 },
];
const PAGE: Page = {
  snap: { keys: [`${BUYER}-0`], active: false },
  star: { x: 50, y: 20, active: false },
  popAfter: 1,
  pop: { keys: [`${BUYER}-0`], active: false, options: OPTIONS },
  owned: "ok",
  after: { keys: [`${BUYER}-0`], active: true },
};

type Net = {
  /** 页面发出一条请求：先 Network.requestWillBeSent，再 Fetch.requestPaused。networkId=null 模拟拦截事件不带浏览器编号。 */
  request(id: string, path: string, data: unknown, networkId?: string | null): void;
  respond(id: string, body: string): void;
  /** 加载结束但取不到响应体。 */
  finishNoBody(id: string): void;
  fail(id: string): void;
};

function harness(opts: { page?: Partial<Page>; onClick?: (net: Net, a: any) => void; onScript?: (name: string, a: any) => void } = {}) {
  const page = { ...PAGE, ...opts.page };
  const adapter = new PddPageAdapter("shop-x", "虚构店铺") as any;
  let listener: (e: unknown, method: string, params: any) => void = () => undefined;
  let attached = false;
  const bodies = new Map<string, string>();
  const log = { clicks: [] as { x: number; y: number }[], hovers: [] as { x: number; y: number }[], continued: [] as string[], failed: [] as string[], fetchPatterns: [] as string[], scripts: [] as string[] };
  let pops = 0;
  const net: Net = {
    request(id, path, data, networkId) {
      const url = "https://mms.pinduoduo.com" + path;
      const postData = JSON.stringify({ data });
      listener(null, "Network.requestWillBeSent", { requestId: id, request: { url, postData } });
      listener(null, "Fetch.requestPaused", { requestId: `f-${id}`, ...(networkId === null ? {} : { networkId: networkId ?? id }), request: { url, postData } });
    },
    respond(id, body) {
      bodies.set(id, body);
      listener(null, "Network.loadingFinished", { requestId: id });
    },
    finishNoBody(id) {
      listener(null, "Network.loadingFinished", { requestId: id });
    },
    fail(id) {
      listener(null, "Network.loadingFailed", { requestId: id });
    },
  };
  const dbg = {
    isAttached: () => attached,
    attach: () => void (attached = true),
    on: (_e: string, fn: typeof listener) => void (listener = fn),
    sendCommand: async (method: string, params: any) => {
      if (method === "Fetch.enable") log.fetchPatterns.push(...params.patterns.map((p: any) => p.urlPattern));
      if (method === "Fetch.continueRequest") log.continued.push(params.requestId);
      if (method === "Fetch.failRequest") log.failed.push(params.requestId);
      if (method === "Network.getResponseBody") {
        const body = bodies.get(params.requestId);
        if (body === undefined) throw new Error("no body");
        return { body, base64Encoded: false };
      }
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") log.hovers.push({ x: params.x, y: params.y });
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
        log.clicks.push({ x: params.x, y: params.y });
        opts.onClick?.(net, adapter);
      }
      return {};
    },
  };
  const script = (code: string): unknown => {
    if (code.includes("freshBuyer")) return { items: [{ key: `${BUYER}-0`, unread: false, active: true }], freshBuyer: false };
    if (code.includes("all-chat-list")) return true;
    if (code === CONV_STAR_SNAPSHOT) return log.clicks.length ? page.after : page.snap;
    if (code.includes("aria-describedby")) {
      if (code.includes("const check = null")) return ++pops < page.popAfter ? "popover_missing" : page.pop;
      return page.owned;
    }
    if (code.includes("收藏该用户")) return page.star;
    return null;
  };
  const webContents = {
    isDestroyed: () => false,
    getURL: () => "https://mms.pinduoduo.com/chat-merchant/index.html",
    debugger: dbg,
    executeJavaScriptInIsolatedWorld: async (_world: number, [{ code }]: { code: string }[]) => {
      const name = code === CONV_STAR_SNAPSHOT ? (log.clicks.length ? "after" : "snap") : code.includes("aria-describedby") ? (code.includes("const check = null") ? "pop" : "owned") : code.includes("收藏该用户") ? "star" : "other";
      log.scripts.push(name);
      opts.onScript?.(name, adapter);
      return script(code);
    },
  };
  const win = { isDestroyed: () => false, webContents };
  adapter.window = win;
  adapter.tracker = { status: () => ({ logged_in: true }), history: () => ({ messages: [] }) };
  adapter.attachNetwork(win);
  const mark = (color: MarkColor = "red", seconds = 3, recheck: () => string | null = () => null): Promise<MarkResult> =>
    adapter.markConversation({ conversation_id: BUYER, color, attempt_id: "att-1", deadline: Date.now() / 1000 + seconds, recheck });
  return { adapter, log, net, mark };
}

/** 页面对点击的正常反应：发出一条与本次一致的标星请求，稍后得到响应。 */
const pageSends = (color = 2, body = okBody(), uid = BUYER) => (net: Net) => {
  net.request("n-1", MARK, { uid, color, request_id: REQ_ID });
  setTimeout(() => net.respond("n-1", body), 30);
};

describe("标星：点击与成功判据（Electron 替身）", () => {
  test("拦截规则包含标星与取消收藏接口", () => {
    const h = harness();
    for (const p of [MARK, UNMARK]) assert.ok(h.log.fetchPatterns.includes(`*://mms.pinduoduo.com${p}*`));
  });

  test("全部满足：只点目标颜色项一次，放行一条请求，按它自己的响应确认；不点星标本身", async () => {
    const h = harness({ onClick: pageSends() });
    const r = await h.mark("red");
    assert.deepEqual(r, { status: "confirmed", page_observed: "marked" });
    assert.deepEqual(h.log.clicks, [{ x: 100, y: 230 }]);
    assert.deepEqual(h.log.continued, ["f-n-1"]);
    assert.deepEqual(h.log.failed, []);
    // 先悬停星标，再移到目标颜色项，结束后移开鼠标。
    assert.deepEqual(h.log.hovers, [{ x: 50, y: 20 }, { x: 100, y: 230 }, { x: 1, y: 1 }]);
    assert.equal(h.adapter.markWatch, null);
    assert.equal(h.adapter.sending, false);
  });

  test("默认色（黄色）用数值 1 核对", async () => {
    const h = harness({ onClick: pageSends(1) });
    assert.equal((await h.mark("orange")).status, "confirmed");
    assert.deepEqual(h.log.clicks, [{ x: 100, y: 200 }]);
  });

  test("同一买家同时出现在两个列表：按买家去重后视为唯一", async () => {
    const keys = [`${BUYER}-0`, `${BUYER}-1`];
    const h = harness({ page: { snap: { keys, active: false }, pop: { keys, active: false, options: OPTIONS } }, onClick: pageSends() });
    assert.equal((await h.mark()).status, "confirmed");
  });

  test("页面观察只供显示：确认成功但星标读不到时观察为 unknown，仍按响应确认", async () => {
    const h = harness({ page: { after: "star_missing" }, onClick: pageSends() });
    assert.deepEqual(await h.mark(), { status: "confirmed", page_observed: "unknown" });
  });
});

describe("标星：点击前核对不通过一律不点击", () => {
  for (const [name, page, reason] of [
    ["打开的是另一个买家", { snap: { keys: [`${OTHER}-0`], active: false } }, "conv_state_changed"],
    ["两个不同买家都打开", { snap: { keys: [`${BUYER}-0`, `${OTHER}-0`], active: false } }, "conv_state_changed"],
    ["打开项混入坏 key", { snap: { keys: [`${BUYER}-0`, null], active: false } }, "conv_state_changed"],
    ["已收藏", { snap: { keys: [`${BUYER}-0`], active: true } }, "conv_state_changed"],
    ["星标缺失", { snap: "star_missing" }, "conv_state_unavailable"],
    ["星标不唯一", { snap: "star_not_unique" }, "conv_state_unavailable"],
    ["快照格式不对", { snap: { keys: `${BUYER}-0`, active: false } }, "conv_state_unavailable"],
    ["星标坐标取不到", { star: "star_missing" }, "conv_state_unavailable"],
    ["浮层始终没有出现", { popAfter: 99 }, "conv_state_unavailable"],
    ["浮层不能证明属于星标", { pop: "popover_unlinked" }, "conv_state_unavailable"],
    ["浮层不唯一", { pop: "popover_not_unique" }, "conv_state_unavailable"],
    ["悬停后打开的会话变了", { pop: { keys: [`${OTHER}-0`], active: false, options: OPTIONS } }, "conv_state_changed"],
    ["悬停后发现已收藏", { pop: { keys: [`${BUYER}-0`], active: true, options: OPTIONS } }, "conv_state_changed"],
    ["目标颜色缺失", { pop: { keys: [`${BUYER}-0`], active: false, options: OPTIONS.filter((o) => o.color !== "red") } }, "conv_state_unavailable"],
    ["目标颜色重复", { pop: { keys: [`${BUYER}-0`], active: false, options: [...OPTIONS, OPTIONS[1]] } }, "conv_state_unavailable"],
    ["目标颜色已勾选", { pop: { keys: [`${BUYER}-0`], active: false, options: OPTIONS.map((o) => (o.color === "red" ? { ...o, checked: true } : o)) } }, "conv_state_unavailable"],
    ["目标点不在星标浮层内", { owned: "target_not_in_star_popover" }, "conv_state_unavailable"],
    ["目标点颜色不符", { owned: "target_color_mismatch" }, "conv_state_unavailable"],
  ] as const) {
    test(`${name}：not_sent（${reason}），不点击`, async () => {
      const h = harness({ page: page as Partial<Page> });
      assert.deepEqual(await h.mark(), { status: "not_sent", reason });
      assert.equal(h.log.clicks.length, 0);
      assert.equal(h.adapter.sending, false);
    });
  }

  for (const at of ["snap", "star", "pop", "owned"]) {
    test(`核对期间页面代次变化（${at}）：not_sent conv_state_changed，不点击`, async () => {
      const h = harness({ onScript: (name, a) => void (name === at && a.watchEpoch++) });
      assert.deepEqual(await h.mark(), { status: "not_sent", reason: "conv_state_changed" });
      assert.equal(h.log.clicks.length, 0);
    });
  }

  test("运行时再核验不通过：按其原因 not_sent，不点击", async () => {
    const h = harness();
    assert.deepEqual(await h.mark("red", 3, () => "superseded"), { status: "not_sent", reason: "superseded" });
    assert.equal(h.log.clicks.length, 0);
  });

  test("离确认截止不足 1.5 秒：not_sent，不点击", async () => {
    const h = harness();
    assert.deepEqual(await h.mark("red", 1.2), { status: "not_sent", reason: "claim_expiring" });
    assert.equal(h.log.clicks.length, 0);
  });

  test("页面正忙（发送进行中）：not_sent，不碰页面", async () => {
    const h = harness();
    h.adapter.sending = true;
    assert.deepEqual(await h.mark(), { status: "not_sent", reason: "pdd_send_busy" });
    assert.equal(h.log.scripts.length, 0);
  });
});

describe("标星：点击窗口内的请求核对", () => {
  for (const [name, color, uid, reason] of [
    ["目标买家不符", 2, OTHER, "mark_request_blocked"],
    ["颜色不符", 1, BUYER, "mark_request_blocked"],
  ] as const) {
    test(`${name}：在本机拦截，不到达平台；unknown`, async () => {
      const h = harness({ onClick: pageSends(color, okBody(), uid) });
      const r = await h.mark("red", 2);
      assert.deepEqual([r.status, r.status !== "confirmed" && r.reason], ["unknown", reason]);
      assert.deepEqual(h.log.failed, ["f-n-1"]);
      assert.deepEqual(h.log.continued, []);
    });
  }

  test("第二条 mark 与任何 unmark 都拦截；放行的第一条照常按自己的响应确认", async () => {
    const h = harness({
      onClick: (net) => {
        net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID });
        net.request("n-2", MARK, { uid: BUYER, color: 2, request_id: REQ_ID + 1 });
        net.request("n-3", UNMARK, { uid: BUYER, request_id: REQ_ID + 2 });
        setTimeout(() => net.respond("n-1", okBody()), 30);
      },
    });
    assert.equal((await h.mark()).status, "confirmed");
    assert.deepEqual(h.log.continued, ["f-n-1"]);
    assert.deepEqual(h.log.failed, ["f-n-2", "f-n-3"]);
  });

  test("点击后页面代次变化：随后的请求拦截；unknown", async () => {
    const h = harness({
      onClick: (net, a) => {
        a.watchEpoch++;
        net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID });
      },
    });
    const r = await h.mark("red", 2);
    assert.deepEqual(r.status === "unknown" && r.reason, "mark_request_blocked");
    assert.deepEqual(h.log.failed, ["f-n-1"]);
  });

  test("拦截事件不带浏览器请求编号：无法配对响应，拦截；unknown", async () => {
    const h = harness({ onClick: (net) => net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID }, null) });
    const r = await h.mark("red", 2);
    assert.deepEqual(r.status === "unknown" && r.reason, "mark_request_blocked");
  });

  test("点击后页面没有发出请求：unknown（不判 not_sent）", async () => {
    const h = harness();
    const r = await h.mark("red", 2);
    assert.deepEqual(r.status === "unknown" && r.reason, "mark_request_not_observed");
    assert.equal(h.log.clicks.length, 1);
  });

  test("窗口外不受影响：没有进行中的标星，或已进入标星但尚未点击时，页面的标星 / 取消收藏请求照常放行", async () => {
    const h = harness({
      onScript: (name, a) => {
        // 核对期间（窗口尚未打开）店主手动操作。
        if (name === "owned") h.net.request("m-2", UNMARK, { uid: OTHER, request_id: 2 });
        void a;
      },
      onClick: pageSends(),
    });
    h.net.request("m-1", MARK, { uid: OTHER, color: 4, request_id: 1 });
    assert.equal((await h.mark()).status, "confirmed");
    h.net.request("m-3", MARK, { uid: OTHER, color: 3, request_id: 3 });
    assert.deepEqual(h.log.continued, ["f-m-1", "f-m-2", "f-n-1", "f-m-3"]);
    assert.deepEqual(h.log.failed, []);
  });
});

describe("标星：响应判定一律按放行请求自己的编号", () => {
  for (const [name, body, reason] of [
    ["外层 success 为 false", JSON.stringify({ success: false, result: { success: true, result: "ok", request_id: REQ_ID } }), "mark_response_not_ok"],
    ["result.success 缺失", JSON.stringify({ success: true, result: { result: "ok", request_id: REQ_ID } }), "mark_response_not_ok"],
    ["result.result 不是 ok", JSON.stringify({ success: true, result: { success: true, result: "fail", request_id: REQ_ID } }), "mark_response_not_ok"],
    ["request_id 不等", okBody(REQ_ID + 1), "mark_response_not_ok"],
    ["不是 JSON", "<html>", "mark_response_not_ok"],
  ] as const) {
    test(`${name}：unknown（${reason}）`, async () => {
      const h = harness({ onClick: pageSends(2, body) });
      const r = await h.mark();
      assert.deepEqual(r.status === "unknown" && r.reason, reason);
    });
  }

  test("响应加载失败：unknown", async () => {
    const h = harness({ onClick: (net) => (net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID }), setTimeout(() => net.fail("n-1"), 30)) });
    const r = await h.mark();
    assert.deepEqual(r.status === "unknown" && r.reason, "mark_request_failed");
  });

  test("取不到响应体：unknown", async () => {
    const h = harness({ onClick: (net) => (net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID }), setTimeout(() => net.finishNoBody("n-1"), 30)) });
    const r = await h.mark();
    assert.deepEqual(r.status === "unknown" && r.reason, "mark_request_failed");
  });

  test("确认截止前没有响应：unknown；截止后才到的成功响应不改变结论", async () => {
    let later: (() => void) | null = null;
    const h = harness({ onClick: (net) => (net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID }), (later = () => net.respond("n-1", okBody()))) });
    const r = await h.mark("red", 2);
    assert.deepEqual(r.status === "unknown" && r.reason, "mark_response_timeout");
    later!();
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(h.adapter.markWatch, null);
  });

  test("乱序到达也不串：先到的是另一条（被拦截请求）的成功响应，不算；放行请求自己的失败响应决定结论", async () => {
    const h = harness({
      onClick: (net) => {
        net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID });
        net.request("n-2", MARK, { uid: BUYER, color: 2, request_id: REQ_ID });
        setTimeout(() => net.respond("n-2", okBody()), 10);
        setTimeout(() => net.respond("n-1", JSON.stringify({ success: false })), 60);
      },
    });
    const r = await h.mark();
    assert.deepEqual(r.status === "unknown" && r.reason, "mark_response_not_ok");
  });

  test("乱序到达也不串：放行请求的成功响应晚于其他请求的失败响应，仍按自己的响应确认", async () => {
    const h = harness({
      onClick: (net) => {
        net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID });
        net.request("n-2", UNMARK, { uid: BUYER, request_id: REQ_ID });
        setTimeout(() => net.fail("n-2"), 10);
        setTimeout(() => net.respond("n-1", okBody()), 60);
      },
    });
    assert.equal((await h.mark()).status, "confirmed");
  });
});

// 极简虚构 DOM：只实现 starOptionsScript 用到的接口。
function fakeDom(opts: { linked?: boolean; activeKeys: string[]; hit?: "red" | "other" | "outside" }) {
  const colors: Record<string, string> = { orange: "rgb(250, 170, 40)", red: "rgb(240, 60, 60)", green: "rgb(60, 180, 90)", blue: "rgb(50, 120, 230)" };
  const lis = Object.entries(colors).map(([name, bg], i) => {
    const dot = { style: bg, querySelectorAll: () => [] };
    const li: any = {
      name,
      style: "rgba(0, 0, 0, 0)",
      querySelectorAll: () => [dot],
      querySelector: () => null,
      getBoundingClientRect: () => ({ left: 90, top: 190 + i * 30, width: 20, height: 20 }),
      closest: () => li,
    };
    return li;
  });
  const pop: any = { id: "el-popover-1", getClientRects: () => [{}], querySelectorAll: () => lis, contains: (e: unknown) => lis.includes(e), style: "rgba(0, 0, 0, 0)" };
  const star: any = { getClientRects: () => [{}], getAttribute: (n: string) => (n === "aria-describedby" && opts.linked !== false ? "el-popover-1" : null), querySelectorAll: () => [], parentElement: null, matches: () => true, classList: { contains: () => false }, querySelector: () => null };
  const items = opts.activeKeys.map((k) => ({ classList: { contains: (c: string) => c === "active" }, getAttribute: () => k }));
  const outside = { closest: () => null };
  const document = {
    querySelectorAll: (s: string) => (s.includes("收藏该用户") ? [star] : s === "div.el-popover" ? [pop] : items),
    elementFromPoint: () => (opts.hit === "outside" ? outside : opts.hit === "other" ? lis[0] : lis[1]),
  };
  const getComputedStyle = (e: any) => ({ backgroundColor: e.style, visibility: "visible" });
  return { document, getComputedStyle };
}
const runStar = (dom: ReturnType<typeof fakeDom>, check?: { x: number; y: number; color: "red" }) =>
  new Function("document", "getComputedStyle", `return ${starOptionsScript(check)};`)(dom.document, dom.getComputedStyle);

describe("真实浮层脚本（虚构 DOM）", () => {
  test("快照返回全部打开项 key（由调用方按买家去重）、星标状态与各颜色项", () => {
    const r = runStar(fakeDom({ activeKeys: [`${BUYER}-0`, `${BUYER}-1`] }));
    assert.deepEqual(r.keys, [`${BUYER}-0`, `${BUYER}-1`]);
    assert.equal(r.active, false);
    assert.deepEqual(r.options.map((o: Option) => o.color), ["orange", "red", "green", "blue"]);
    assert.deepEqual([r.options[1].x, r.options[1].y], [100, 230]);
  });

  test("浮层没有由星标关联：不认", () => {
    assert.equal(runStar(fakeDom({ linked: false, activeKeys: [] })), "popover_unlinked");
  });

  test("点击前核对：目标点须是星标浮层中的目标颜色项", () => {
    assert.equal(runStar(fakeDom({ activeKeys: [] }), { x: 100, y: 230, color: "red" }), "ok");
    assert.equal(runStar(fakeDom({ activeKeys: [], hit: "other" }), { x: 100, y: 230, color: "red" }), "target_color_mismatch");
    assert.equal(runStar(fakeDom({ activeKeys: [], hit: "outside" }), { x: 100, y: 230, color: "red" }), "target_not_in_star_popover");
  });
});
