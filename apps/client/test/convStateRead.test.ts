import assert from "node:assert/strict";
import Module from "node:module";
import { test } from "node:test";

// 只读收藏状态：真实 readConvState / freshActive，只替换底层列表扫描与页面脚本执行。全部为虚构编号。
const req = Module.createRequire(__filename);
const electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: { fromPartition: () => ({}) } } } as unknown as NodeModule;
const { PddPageAdapter } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

const A = "880011223344";
const B = "880099887766";
type Item = { key: string; active: boolean; unread: boolean };
const open = (...uids: string[]): Item[] => uids.map((u, i) => ({ key: `${u}-${i}`, active: true, unread: false }));

function harness(opts: { scans: Item[][]; star: unknown; bumpOnStar?: boolean; sending?: boolean; destroyed?: boolean }) {
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
  let scans = 0;
  a.scanKeepingFresh = async () => ({ items: opts.scans[Math.min(scans++, opts.scans.length - 1)] });
  a.run = async () => {
    if (opts.bumpOnStar) a.watchEpoch++;
    return opts.star;
  };
  return { a, scans: () => scans };
}
const STAR = (active: boolean) => ({ x: 10, y: 10, active });

test("该买家是唯一打开的会话：按星标 active 报 marked，颜色不读", async () => {
  for (const active of [true, false]) {
    const { a, scans } = harness({ scans: [open(A)], star: STAR(active) });
    assert.deepEqual(await a.readConvState(A, 1000), { marked: active, color: null });
    assert.equal(scans(), 2, "读取前后各核对一次打开的会话");
  }
});

test("同一买家同时出现在两个列表：去重后视为唯一", async () => {
  const { a } = harness({ scans: [open(A, A)], star: STAR(true) });
  assert.deepEqual(await a.readConvState(A, 1000), { marked: true, color: null });
});

for (const [name, opts] of [
  ["打开的是另一个买家", { scans: [open(B)], star: STAR(true) }],
  ["两个不同买家都打开", { scans: [open(A, B)], star: STAR(true) }],
  ["读星标后切到另一个买家", { scans: [open(A), open(B)], star: STAR(true) }],
  ["读星标期间页面重建", { scans: [open(A)], star: STAR(true), bumpOnStar: true }],
  ["星标缺失或不唯一", { scans: [open(A)], star: "star_missing" }],
  ["脚本返回格式不对", { scans: [open(A)], star: { x: 1, y: 1 } }],
  ["正在发送", { scans: [open(A)], star: STAR(true), sending: true }],
  ["页面已关闭", { scans: [open(A)], star: STAR(true), destroyed: true }],
] as const) {
  test(`${name}：marked=null`, async () => {
    const { a } = harness(opts as unknown as Parameters<typeof harness>[0]);
    assert.deepEqual(await a.readConvState(A, 1000), { marked: null, color: null });
  });
}
