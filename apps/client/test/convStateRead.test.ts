import assert from "node:assert/strict";
import Module from "node:module";
import { test } from "node:test";

// 只读收藏状态：真实 readConvState，只替换页面脚本执行；另用虚构 DOM 真实执行快照脚本。全部为虚构编号。
const req = Module.createRequire(__filename);
const electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: { fromPartition: () => ({}) } } } as unknown as NodeModule;
const { PddPageAdapter, CONV_STAR_SNAPSHOT } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

const A = "880011223344";
const B = "880099887766";
type Snap = { keys: unknown[]; active: boolean } | string | unknown;

function harness(opts: { snap: Snap; bumpOnRun?: boolean; sending?: boolean; destroyed?: boolean }) {
  const a = new PddPageAdapter("fixture", "虚构店铺", null) as unknown as {
    window: unknown;
    sending: boolean;
    watchEpoch: number;
    scanKeepingFresh(): Promise<unknown>;
    run(script: string): Promise<unknown>;
    readConvState(conv: string, ms: number): Promise<{ marked: boolean | null; color: null }>;
  };
  a.window = { isDestroyed: () => !!opts.destroyed };
  a.sending = !!opts.sending;
  let runs = 0;
  let scans = 0;
  // 旧实现的分步扫描会一直看到 A；新实现不得依赖它。
  a.scanKeepingFresh = async () => (scans++, { items: [{ key: `${A}-0`, active: true, unread: false }] });
  a.run = async (script) => {
    runs++;
    assert.equal(script, CONV_STAR_SNAPSHOT);
    if (opts.bumpOnRun) a.watchEpoch++;
    return opts.snap;
  };
  return { a, runs: () => runs, scans: () => scans };
}

test("快照里唯一打开的是该买家：按星标 active 报 marked，颜色不读，只读一次页面", async () => {
  for (const active of [true, false]) {
    const h = harness({ snap: { keys: [`${A}-0`], active } });
    assert.deepEqual(await h.a.readConvState(A, 1000), { marked: active, color: null });
    assert.deepEqual([h.runs(), h.scans()], [1, 0]);
  }
});

test("同一买家同时出现在两个列表：去重后视为唯一", async () => {
  const h = harness({ snap: { keys: [`${A}-0`, `${A}-1`], active: true } });
  assert.deepEqual(await h.a.readConvState(A, 1000), { marked: true, color: null });
});

test("A→B→A：同一快照里打开的是 B、星标是 B 的已收藏，即使前后分步扫描都是 A，也报未知", async () => {
  const h = harness({ snap: { keys: [`${B}-0`], active: true } });
  assert.deepEqual(await h.a.readConvState(A, 1000), { marked: null, color: null });
  assert.equal(h.scans(), 0);
});

for (const [name, opts] of [
  ["快照目标不符（另一个买家）", { snap: { keys: [`${B}-0`], active: false } }],
  ["两个不同买家都打开", { snap: { keys: [`${A}-0`, `${B}-0`], active: true } }],
  ["重复项中混入缺失或坏 key", { snap: { keys: [`${A}-0`, null], active: true } }],
  ["只有坏 key", { snap: { keys: ["bad"], active: true } }],
  ["没有打开的会话", { snap: { keys: [], active: false } }],
  ["读取期间页面重建", { snap: { keys: [`${A}-0`], active: true }, bumpOnRun: true }],
  ["星标缺失或不唯一", { snap: "star_missing" }],
  ["脚本返回格式不对", { snap: { keys: `${A}-0`, active: true } }],
  ["正在发送", { snap: { keys: [`${A}-0`], active: true }, sending: true }],
  ["页面已关闭", { snap: { keys: [`${A}-0`], active: true }, destroyed: true }],
] as const) {
  test(`${name}：marked=null`, async () => {
    const h = harness(opts as unknown as Parameters<typeof harness>[0]);
    assert.deepEqual(await h.a.readConvState(A, 1000), { marked: null, color: null });
  });
}

// 极简虚构 DOM：只实现快照脚本用到的接口。
function el(opts: { cls?: string[]; attrs?: Record<string, string>; visible?: boolean; tag?: string; child?: any }) {
  const cls = new Set(opts.cls ?? []);
  return {
    classList: { contains: (c: string) => cls.has(c) },
    getAttribute: (n: string) => opts.attrs?.[n] ?? null,
    getClientRects: () => (opts.visible === false ? [] : [{}]),
    matches: (s: string) => s === (opts.tag ?? "span"),
    querySelector: () => opts.child ?? null,
  };
}
function runScript(items: any[], stars: any[]) {
  const document = { querySelectorAll: (s: string) => (s.includes("收藏该用户") ? stars : items) };
  return new Function("document", `return ${CONV_STAR_SNAPSHOT};`)(document);
}

test("真实快照脚本：同一次读取返回打开项 key 与星标状态", () => {
  const items = [el({ cls: ["active"], attrs: { "data-random": `${A}-0` } }), el({ attrs: { "data-random": `${B}-0` } })];
  assert.deepEqual(runScript(items, [el({ tag: "i", cls: ["active"] })]), { keys: [`${A}-0`], active: true });
  assert.deepEqual(runScript(items, [el({ child: el({ tag: "i" }) })]), { keys: [`${A}-0`], active: false });
  assert.equal(runScript(items, []), "star_missing");
  assert.equal(runScript(items, [el({}), el({})]), "star_not_unique");
  assert.deepEqual(runScript(items, [el({ visible: false }), el({ tag: "i" })]), { keys: [`${A}-0`], active: false });
});
