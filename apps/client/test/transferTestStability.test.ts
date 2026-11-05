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
  /** 最后一次页面快照期间：切到别的买家（快照自己核对出来），或时间越过期限（快照返回 ok 后才发现）。 */
  duringFinalSnapshot?: "switch" | "expire";
  /** 开始核对之后的残留读数（收尾时）；省略时与 leftovers 相同。 */
  leftoversLater?: { dialogs: number; popovers: number };
  /** 收尾按 Esc 的 CDP 命令替身：同步抛错、挂起或返回。 */
  sendCommand?: (method: string, params: { type: string }) => Promise<unknown>;
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
  const keys: string[] = [];
  a.window = {
    isDestroyed: () => false,
    webContents: {
      debugger: {
        sendCommand: (method: string, params: { type: string }) => {
          keys.push(params.type);
          return opts.sendCommand ? opts.sendCommand(method, params) : Promise.resolve({});
        },
      },
    },
  };
  let leftoverReads = 0;
  a.tracker = { status: () => ({ logged_in: true }) };
  a.actionGate = async () => {
    if (armed) {
      armed = false;
      cancelCheck = "confirm_covered";
    }
    return gateValue;
  };
  a.activeConvToken = async () => "conv-1";
  a.convTokenFor = (b: string) => (b === "9001" ? "conv-1" : `other-${b}`);
  const checks: string[] = [];
  a.scanKeepingFresh = async () => ({ items: [{ key: "9001-x", active: true, unread: false }] });
  a.nativeClick = async (pt: Pt): Promise<Click> => {
    clicks.push({ x: pt.x, y: pt.y });
    if (same(pt, ROW) && opts.gateAfterRow) gateValue = opts.gateAfterRow;
    if (same(pt, CANCEL) && opts.cancelClick) return opts.cancelClick;
    return { status: "dispatched" };
  };
  a.run = async (script: string) => {
    if (script.includes("const popovers")) {
      const start = opts.leftovers ?? { dialogs: 0, popovers: 0 };
      return leftoverReads++ === 0 ? start : (opts.leftoversLater ?? start);
    }
    if (script.includes("el-dialog__headerbtn")) return CLOSE;
    if (script.includes("cells")) return [{ cells: [NAME, "在线"], button: ROW }];
    if (script.includes("aria-describedby")) {
      if (script.includes("const check = null")) {
        // 第 1 次是主流程读气泡，第 2 次是收尾“取消”读气泡；之后的那次会话核对期间页面发生变化。
        if (++listReads === 2 && opts.changeDuringFinalGate) armed = true;
        return [{ text: "无原因直接转移", ...CONFIRM }, { text: "取消", ...CANCEL }];
      }
      if (script.includes('"text":"取消"')) {
        checks.push(script);
        if (opts.duringFinalSnapshot === "switch") return "conversation_mismatch";
        if (opts.duringFinalSnapshot === "expire") clock.offset += 200_000;
        return cancelCheck;
      }
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
  return { a, clicks, logs, logFile, checks, keys };
}

// 期限与 Date.now() 同为毫秒；“到期”用时钟偏移模拟。
const clock = { offset: 0 };
const realNow = Date.now;
Date.now = () => realNow() + clock.offset;
const run = (h: ReturnType<typeof harness>, confirm = false) => ((clock.offset = 0), h.a.transferTest(NAME, confirm, "conv-1", Date.now() + 120_000) as Promise<string>);
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

test("点行后快照发现买家已切换：保留会话不符原因，不误归为目标行挪位", async () => {
  const h = harness({ ...stable, rect: "conversation_mismatch" });
  assert.equal(await run(h, true), "not_executed:conversation_mismatch");
  assert.equal(h.clicks.some(c => same(c, CONFIRM)), false);
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

test("复审反例：最后一次页面快照期间切到别的买家——快照里同时核对买家，不点", async () => {
  const h = harness({ ...stable, duringFinalSnapshot: "switch" });
  assert.equal(await run(h), "inspected:rows=1,confirm_buttons=1");
  assert.equal(h.clicks.some((c) => same(c, CANCEL) || same(c, CONFIRM)), false);
  assert.equal(cancelResultOf(h), "skipped:conversation_mismatch");
  assert.ok(h.checks.every((s) => s.includes('"buyer":"9001"')), "最后快照须带本次买家");
});

test("复审反例：最后一次页面快照期间到期——快照之后同步复核期限，不点", async () => {
  const h = harness({ ...stable, duringFinalSnapshot: "expire" });
  assert.equal(await run(h), "inspected:rows=1,confirm_buttons=1");
  assert.equal(h.clicks.some((c) => same(c, CANCEL) || same(c, CONFIRM)), false);
  assert.equal(cancelResultOf(h), "skipped:expired");
});

test("扫描读到的买家与请求携带的对话令牌不一致：一开始就不执行，不点任何东西", async () => {
  const h = harness(stable);
  h.a.convTokenFor = () => "conv-other";
  assert.equal(await run(h), "not_executed:conversation_mismatch");
  assert.deepEqual(h.clicks, []);
});

test("复审反例：收尾按 Esc 时 CDP 同步抛错、按下挂起、松开挂起——都在有界时间内返回并释放忙碌，只记固定分类", async () => {
  const hang = () => new Promise<unknown>(() => undefined);
  const cases: [string, NonNullable<Opts["sendCommand"]>, string, string[]][] = [
    ["同步抛错", () => {
      throw new Error("debugger detached");
    }, "keydown_failed", ["keyDown"]],
    ["按下挂起", hang, "keydown_timeout", ["keyDown"]],
    ["松开挂起", (_m, p) => (p.type === "keyDown" ? Promise.resolve({}) : hang()), "keyup_timeout", ["keyDown", "keyUp"]],
    ["按下被拒", () => Promise.reject(new Error("x")), "keydown_failed", ["keyDown"]],
  ];
  for (const [name, sendCommand, result, keys] of cases) {
    // 对话框关不掉（关闭按钮无效）才会走到 Esc。
    const h = harness({ ...stable, leftoversLater: { dialogs: 1, popovers: 0 }, sendCommand });
    const started = realNow();
    assert.equal(await run(h), "inspected:rows=1,confirm_buttons=1", name);
    assert.ok(realNow() - started < 8_000, `${name}：收尾有界`);
    assert.equal(h.a.sending, false, `${name}：释放忙碌`);
    assert.deepEqual(h.keys, keys, `${name}：不重试按键`);
    const cleanup = h.logs().filter((r) => r.phase === "cleanup").at(-1);
    assert.equal(cleanup.steps.at(-1).step, "escape", name);
    assert.equal(cleanup.steps.at(-1).result, result, name);
    // 下一次诊断不再因忙碌被拒（残留仍在，按既有规则以 leftover_popup 拒绝开始）。
    assert.equal(await run(h), "not_executed:leftover_popup", `${name}：后续请求不是 busy`);
  }
});

test("复审反例：收尾过程抛异常——仍释放忙碌，记固定分类", async () => {
  const h = harness({ ...stable });
  const orig = h.a.nativeClick;
  h.a.nativeClick = async (pt: Pt) => {
    // 收尾点关闭按钮时抛出（读脚本自带 catch，点击没有）。
    if (same(pt, CLOSE)) throw new Error("boom");
    return orig(pt);
  };
  assert.equal(await run(h), "inspected:rows=1,confirm_buttons=1");
  assert.equal(h.a.sending, false);
  assert.equal(h.logs().filter((r) => r.phase === "cleanup").at(-1).result, "cleanup_failed");
});
