import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 诊断转移（transferTest）的点击前后核对：全部用虚构页面替身，只驱动坐标读取与点击记录，不连真实页面。
const req = Module.createRequire(__filename);
const electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: {} } } as unknown as NodeModule;
const { PddPageAdapter } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

const NAME = "主账号";
type Pt = { x: number; y: number };
type Click = { status: "dispatched" } | { status: "not_sent" | "unknown"; reason: string };
const OPEN: Pt = { x: 100, y: 100 };
const ROW: Pt = { x: 300, y: 200 };
const CLOSE: Pt = { x: 900, y: 50 };
const CANCEL: Pt = { x: 320, y: 260 };
const CONFIRM: Pt = { x: 400, y: 260 };
const same = (a: Pt, b: Pt) => a.x === b.x && a.y === b.y;

type Opts = {
  leftovers?: { dialogs: number; popovers: number };
  /** 每次读“转移”按钮（带滚动与遮挡核对）依次返回的坐标。 */
  positions: (Pt | string)[];
  /** 点行后只读位置的结果。 */
  rect?: Pt | string;
  /** 点行之后 gate 的返回（模拟切到别的会话、过期）。 */
  gateAfterRow?: string;
  /** 点“取消”前的命中核对结果。 */
  cancelCheck?: string;
  /** 点“取消”的结果。 */
  cancelClick?: Click;
  /** 收尾读完气泡后的那次会话核对期间，“取消”所在位置变成别的控件（核对改为遮挡）。 */
  changeDuringFinalGate?: boolean;
};

function harness(opts: Opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-transfer-test-"));
  const a = new PddPageAdapter("fictional", "虚构", path.join(dir, "requests.jsonl")) as any;
  const clicks: Pt[] = [];
  const positions = [...opts.positions];
  let last: Pt | string = "missing";
  let gateValue: string | null = null;
  let cancelCheck = opts.cancelCheck ?? "ok";
  let listReads = 0;
  let armed = false;
  a.window = { isDestroyed: () => false };
  a.tracker = { status: () => ({ logged_in: true }) };
  a.actionGate = async () => {
    if (armed) {
      armed = false;
      cancelCheck = "confirm_covered";
    }
    return gateValue;
  };
  a.activeConvToken = async () => "conv-1";
  a.scanKeepingFresh = async () => ({ items: [{ key: "9001-x", active: true, unread: false }] });
  a.nativeClick = async (pt: Pt): Promise<Click> => {
    clicks.push({ x: pt.x, y: pt.y });
    if (same(pt, ROW) && opts.gateAfterRow) gateValue = opts.gateAfterRow;
    if (same(pt, CANCEL) && opts.cancelClick) return opts.cancelClick;
    return { status: "dispatched" };
  };
  a.run = async (script: string) => {
    if (script.includes("const popovers")) return opts.leftovers ?? { dialogs: 0, popovers: 0 };
    if (script.includes("el-dialog__headerbtn")) return CLOSE;
    if (script.includes("cells")) return [{ cells: [NAME, "在线"], button: ROW }];
    if (script.includes("aria-describedby")) {
      if (script.includes("const check = null")) {
        // 第 1 次是主流程读气泡，第 2 次是收尾“取消”读气泡；之后的那次会话核对期间页面发生变化。
        if (++listReads === 2 && opts.changeDuringFinalGate) armed = true;
        return [{ text: "无原因直接转移", ...CONFIRM }, { text: "取消", ...CANCEL }];
      }
      if (script.includes('"text":"取消"')) return cancelCheck;
      return "ok";
    }
    if (script.includes("target_button_not_unique") && script.includes("scrollIntoView")) {
      if (positions.length) last = positions.shift()!;
      return last;
    }
    if (script.includes("target_button_not_unique")) return opts.rect ?? last;
    if (script.includes('"转移会话"')) return OPEN;
    return "unexpected_script";
  };
  const logFile = path.join(dir, "transfer-test.jsonl");
  const logs = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { a, clicks, logs, logFile };
}

const run = (h: ReturnType<typeof harness>, confirm = false) => h.a.transferTest(NAME, confirm, "conv-1", Date.now() / 1000 + 120) as Promise<string>;
const stable = { positions: [ROW, ROW], rect: ROW };
const cancelResult = (h: ReturnType<typeof harness>) => h.logs().find((r) => r.phase === "inspect_cancel" || (r.phase === "cleanup" && "popover_cancel" in r));
const cancelResultOf = (h: ReturnType<typeof harness>) => {
  const r = cancelResult(h);
  return r?.result ?? r?.popover_cancel;
};

test("上次留下的转移对话框或确认气泡还开着：不开始、不点击", async () => {
  for (const leftovers of [{ dialogs: 1, popovers: 0 }, { dialogs: 0, popovers: 1 }]) {
    const h = harness({ leftovers, positions: [ROW] });
    assert.equal(await run(h), "not_executed:leftover_popup");
    assert.deepEqual(h.clicks, []);
    assert.equal(h.logs().at(-1).reason, "leftover_popup");
  }
});

test("对话框还在动画中、按钮位置一直在变：不点行内“转移”，关闭对话框", async () => {
  const h = harness({ positions: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ x: 300, y: 260 - i * 10 })) });
  assert.equal(await run(h), "not_executed:target_unstable");
  assert.deepEqual(h.clicks, [OPEN, CLOSE]);
});

test("位置稳定后才点；点行后确认气泡盖住按钮也不误判为挪位；inspect 只点一次“取消”，记实际点击状态", async () => {
  const h = harness({ positions: [{ x: 300, y: 230 }, ROW, ROW], rect: ROW });
  assert.equal(await run(h), "inspected:rows=1,confirm_buttons=1");
  assert.deepEqual(h.clicks, [OPEN, ROW, CANCEL, CLOSE]);
  assert.equal(cancelResultOf(h), "dispatched");
  assert.equal(h.logs().filter((r) => r.phase === "cleanup" && "popover_cancel" in r).length, 0);
  assert.deepEqual(h.logs().filter((r) => r.phase === "cleanup").at(-1).leftover, { dialogs: 0, popovers: 0 });
});

test("点行后行真的挪了：不继续，记位移；收尾核对后点一次气泡“取消”再关对话框", async () => {
  const h = harness({ positions: [ROW, ROW], rect: { x: 300, y: 240 } });
  assert.equal(await run(h), "not_executed:target_moved");
  assert.deepEqual(h.clicks, [OPEN, ROW, CANCEL, CLOSE]);
  const moved = h.logs().find((r) => r.reason === "target_moved");
  assert.deepEqual([moved.detail, moved.dx, moved.dy], ["moved", 0, 40]);
  assert.equal(cancelResultOf(h), "dispatched");
  assert.ok(!fs.readFileSync(h.logFile, "utf8").includes(NAME), "日志不得含账号名");
});

test("点行后读不到目标行：记具体原因，不点确认", async () => {
  const h = harness({ positions: [ROW, ROW], rect: "target_missing" });
  assert.equal(await run(h, true), "not_executed:target_moved");
  const moved = h.logs().find((r) => r.reason === "target_moved");
  assert.deepEqual([moved.detail, moved.dx, moved.dy], ["target_missing", null, null]);
  assert.equal(h.clicks.some((c) => same(c, CONFIRM)), false);
});

test("复审反例：点行后切到别的会话或已过期——收尾不点“取消”，只记跳过原因", async () => {
  for (const g of ["conversation_mismatch", "expired"]) {
    for (const confirm of [false, true]) {
      const h = harness({ ...stable, gateAfterRow: g });
      const result = await run(h, confirm);
      assert.equal(h.clicks.some((c) => same(c, CANCEL) || same(c, CONFIRM)), false, `${g}/${confirm} 不得点取消或确认`);
      if (confirm) assert.equal(result, `not_executed:${g}`);
      assert.equal(cancelResultOf(h), `skipped:${g}`);
    }
  }
});

test("复审反例：“取消”的命中点被别的控件盖住或不在关联气泡里——不点，只记原因", async () => {
  for (const check of ["confirm_covered", "confirm_not_unique", "popover_missing"]) {
    const h = harness({ ...stable, cancelCheck: check });
    assert.equal(await run(h), "inspected:rows=1,confirm_buttons=1");
    assert.equal(h.clicks.some((c) => same(c, CANCEL) || same(c, CONFIRM)), false);
    assert.equal(cancelResultOf(h), `skipped:${check}`);
  }
});

test("复审反例：点“取消”没发出或结果不明——如实记录，不补点、不重试", async () => {
  for (const click of [{ status: "not_sent", reason: "pdd_page_changed" }, { status: "unknown", reason: "release_failed" }] as Click[]) {
    for (const rect of [ROW, { x: 300, y: 240 }]) {
      const h = harness({ positions: [ROW, ROW], rect, cancelClick: click });
      await run(h);
      assert.equal(h.clicks.filter((c) => same(c, CANCEL)).length, 1, "只尝试一次");
      assert.equal(cancelResultOf(h), `${click.status}:${(click as { reason: string }).reason}`);
      assert.equal(JSON.stringify(h.logs()).includes("cancelled"), false);
    }
  }
});

test("复审反例：读完气泡后的会话核对期间“取消”位置被换成别的控件——命中核对在最后，不点", async () => {
  const h = harness({ ...stable, changeDuringFinalGate: true });
  assert.equal(await run(h), "inspected:rows=1,confirm_buttons=1");
  assert.equal(h.clicks.some((c) => same(c, CANCEL) || same(c, CONFIRM)), false);
  assert.equal(cancelResultOf(h), "skipped:confirm_covered");
});
