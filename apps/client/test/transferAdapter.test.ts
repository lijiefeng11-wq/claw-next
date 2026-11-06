import assert from "node:assert/strict";
import Module from "node:module";
import vm from "node:vm";
import { test } from "node:test";
const req = Module.createRequire(__filename), electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: {} } } as unknown as NodeModule;
const { PddPageAdapter, transferDialogBlankScript } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

for (const [name, options, expected] of [
  ["owned backdrop", {}, "dispatched"],
  ["same buyer repeated", { keys: ["9001-a", "9001-b"] }, "dispatched"],
  ["dialog already gone", { count: 0 }, "missing"],
  ["two dialogs", { count: 2 }, "dialog_not_unique"],
  ["different buyer", { keys: ["9002-a"] }, "conversation_mismatch"],
  ["multiple buyers", { keys: ["9001-a", "9002-a"] }, "conversation_mismatch"],
  ["bad key", { keys: ["bad"] }, "conversation_mismatch"],
  ["no active buyer", { keys: [] }, "conversation_mismatch"],
  ["no owned wrapper", { noWrapper: true }, "missing"],
  ["underlying send button", { covered: true }, "covered"],
  ["late evaluation", { expired: true }, "expired"],
] as [string, { keys?: string[]; count?: number; noWrapper?: boolean; covered?: boolean; expired?: boolean }, string][]) {
  test(`actual blank-dismiss script: ${name}, never clicks underlying page`, () => {
    let clicks = 0, underlying = 0;
    const visible = { getClientRects: () => [{}] };
    const backdrop = { ...visible, click: () => clicks++, getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 700 }) };
    const dialog = { ...visible, querySelector: () => ({ innerText: "转移会话" }), closest: () => options.noWrapper ? null : backdrop,
      getBoundingClientRect: () => ({ left: 100, top: 100, right: 900, bottom: 600 }) };
    const button = { click: () => underlying++ };
    const document = { querySelectorAll: (s: string) => s === "div.el-dialog" ? Array(options.count ?? 1).fill(dialog) :
      (options.keys ?? ["9001-a"]).map(key => ({ ...visible, classList: { contains: () => true }, getAttribute: () => key })),
      elementFromPoint: () => options.covered ? button : backdrop };
    const result = vm.runInNewContext(transferDialogBlankScript("9001", options.expired ? 0 : Date.now() + 1000),
      { document, innerWidth: 1000, innerHeight: 700, getComputedStyle: () => ({ visibility: "visible" }) });
    assert.equal(result, expected); assert.equal(clicks, expected === "dispatched" ? 1 : 0); assert.equal(underlying, 0);
  });
}
const OPEN = { x: 100, y: 100 }, ROW = { x: 300, y: 200 }, CONFIRM = { x: 400, y: 260 };

function harness(opts: { names?: readonly string[]; changeOnRows?: boolean; hangingRows?: boolean; onRow?: (a: any) => void; blankDoesNothing?: boolean; blankResult?: string; blankThrows?: boolean; blankHangs?: boolean; disappearBeforeBlank?: boolean } = {}) {
  const a = new PddPageAdapter("fictional", "fictional") as any;
  const clicks: string[] = [], scripts: string[] = [];
  const keys: string[] = []; let dialogOpen = false, conversationOpen = true; let blanks = 0;
  const page = { isDestroyed: () => false, webContents: { isDestroyed: () => false, debugger: { isAttached: () => true, sendCommand: async (method: string, p: any) => {
    if (method === "Input.dispatchKeyEvent") {
      keys.push(p.type);
      conversationOpen = false; // Esc ends the fixture conversation, so cleanup must never reach here.
    }
    if (p.type === "mousePressed") {
      clicks.push(p.x === OPEN.x ? "open" : p.x === ROW.x ? "row" : p.x === CONFIRM.x ? "confirm" : "unexpected");
      if (p.x === OPEN.x) dialogOpen = true;
      if (p.x === ROW.x) opts.onRow?.(a);
    }
    return {};
  } } } };
  a.window = page; a.tracker = { status: () => ({ logged_in: true, identity: { platform_shop_id: "mall-1" } }) };
  a.freshActive = async () => "9001";
  a.scanKeepingFresh = async () => ({ items: [{ key: "9001-x", active: true }] });
  a.settleTransfer = async () => "unknown:left_list_observed";
  a.run = async (script: string) => {
    scripts.push(script);
    if (script.includes('"转移失败"')) return null;
    if (script.includes("const popovers")) return { dialogs: dialogOpen ? 1 : 0, popovers: 0 };
    if (script.includes("const backdrop =")) {
      if (opts.disappearBeforeBlank) dialogOpen = false;
      if (!dialogOpen) return "missing";
      if (opts.blankThrows) throw new Error("fictional_blank_error");
      if (opts.blankHangs) return new Promise(() => {});
      if (opts.blankResult) return opts.blankResult;
      clicks.push("blank"); blanks++;
      if (!opts.blankDoesNothing) dialogOpen = false;
      return "dispatched";
    }
    if (script.includes("return { cells")) {
      if (opts.changeOnRows) a.watchEpoch++;
      if (opts.hangingRows) return new Promise(() => {});
      return (opts.names ?? ["fictional-main"]).map(n => ({ cells: [n, "online"], button: ROW }));
    }
    if (script.includes("aria-describedby")) return script.includes("const check = null") ? [{ text: "无原因直接转移", ...CONFIRM }] : "ok";
    if (script.includes("target_button_not_unique")) return ROW;
    if (script.includes('"转移会话"')) return OPEN;
    if (script.includes("freshBuyer")) return { items: [{ key: "9001-x", active: true }] };
    return "unexpected_script";
  };
  return { a, page, clicks, scripts, keys, isDialogOpen: () => dialogOpen, isConversationOpen: () => conversationOpen, blanks: () => blanks, setDialogOpen: () => { dialogOpen = true; } };
}

test("hung active-conversation scan releases discovery busy without opening a dialog", async () => {
  const h = harness(); h.a.freshActive = () => new Promise(() => {});
  const start = Date.now(); assert.deepEqual(await h.a.readTransferTargets("9001", 1800), []);
  assert(Date.now() - start < 1500); assert.equal(h.a.sending, false); assert.deepEqual(h.clicks, []);
});

test("hung formal gate releases busy without a transfer or a later retry", async () => {
  const h = harness(); const targets = await h.a.readTransferTargets("9001", 1800); h.clicks.length = 0;
  h.a.actionGate = () => new Promise(() => {});
  const start = Date.now(), result = await h.a.transferConversation(request(h, targets[0].target_id));
  assert.equal(result.status, "not_sent"); assert(Date.now() - start < 1500); assert.equal(h.a.sending, false); assert.deepEqual(h.clicks, []);
});
function request(h: ReturnType<typeof harness>, id: string) { return { conversation_id: "9001", target_id: id, allow_unmark: false, attempt_id: "fictional-attempt", deadline: Date.now() / 1000 + 8, recheck: (): string | null => null }; }

test("read-only target discovery is page-bound, does not click a target, and releases busy", async () => {
  const h = harness(); const targets = await h.a.readTransferTargets("9001", 1800);
  assert.equal(targets.length, 1); assert.equal(targets[0].name, "fictional-main"); assert.match(targets[0].target_id, /^[0-9a-f]{32}$/);
  assert.deepEqual(h.clicks, ["open", "blank"]); assert.equal(h.a.sending, false);
});

test("ordinary messages reuse the still-fresh account list without reopening a dialog or renewing its timestamp", async () => {
  const h = harness(), first = await h.a.readTransferTargets("9001", 1800); h.clicks.length = 0;
  const second = await h.a.readTransferTargets("9001", 1800);
  assert.deepEqual(second, first); assert.deepEqual(h.clicks, []); assert.equal(h.a.sending, false);
});

test("target discovery closes only its backdrop, keeps the conversation and never sends keys", async () => {
  const h = harness(); const targets = await h.a.readTransferTargets("9001", 1800);
  assert.equal(targets.length, 1); assert.equal(h.isDialogOpen(), false);
  assert.deepEqual(h.keys, []); assert.equal(h.isConversationOpen(), true);
  assert.deepEqual(h.clicks, ["open", "blank"]); assert.equal(h.blanks(), 1);
});

test("a dialog opened before discovery is left alone", async () => {
  const h = harness(); h.setDialogOpen();
  assert.deepEqual(await h.a.readTransferTargets("9001", 1800), []);
  assert.equal(h.isDialogOpen(), true); assert.deepEqual(h.clicks, []); assert.deepEqual(h.keys, []);
  assert.equal(h.a.sending, false);
});

test("unconfirmed blank cleanup does not cache targets or reopen the leftover dialog", async () => {
  const h = harness({ blankDoesNothing: true });
  assert.deepEqual(await h.a.readTransferTargets("9001", 1800), []);
  assert.equal(h.isDialogOpen(), true); assert.equal(h.a.formalTransferTargets.size, 0);
  assert.deepEqual(h.keys, []); assert.deepEqual(h.clicks, ["open", "blank"]);
  h.clicks.length = 0;
  assert.deepEqual(await h.a.readTransferTargets("9001", 1800), []);
  assert.deepEqual(h.clicks, []); assert.equal(h.a.sending, false); assert.equal(h.isConversationOpen(), true);
});

for (const opts of [{ blankThrows: true }, { blankHangs: true }, { blankResult: "covered" }]) {
  test(`blank discovery cleanup ${Object.keys(opts)[0]} is bounded and releases busy without keys or retry`, async () => {
    const h = harness(opts), started = Date.now();
    assert.deepEqual(await h.a.readTransferTargets("9001", 1800), []);
    assert(Date.now() - started < 1600); assert.equal(h.a.sending, false);
    assert.deepEqual(h.keys, []); assert.equal(h.a.formalTransferTargets.size, 0);
    assert.deepEqual(h.clicks, ["open"]); assert.equal(h.isConversationOpen(), true);
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(h.keys, []); assert.deepEqual(h.clicks, ["open"]);
  });
}

test("dialog disappearing before cleanup never clicks through or ends the conversation", async () => {
  const h = harness({ disappearBeforeBlank: true });
  assert.equal((await h.a.readTransferTargets("9001", 1800)).length, 1);
  assert.deepEqual(h.clicks, ["open"]); assert.deepEqual(h.keys, []);
  assert.equal(h.isConversationOpen(), true); assert.equal(h.a.sending, false);
});

for (const [label, opts] of [["duplicate accounts", { names: ["same", "same"] }], ["oversize account", { names: ["x".repeat(41)] }], ["page change", { changeOnRows: true }]] as const) {
  test(`${label}: no guessed target and no action`, async () => { const h = harness(opts); const targets = await h.a.readTransferTargets("9001", 1000); assert.deepEqual(targets, []); assert(!h.clicks.includes("row")); assert.equal(h.a.sending, false); });
}

test("hung target read returns within a bound and releases busy", async () => {
  const h = harness({ hangingRows: true }); const start = Date.now();
  const targets = await h.a.readTransferTargets("9001", 700).catch(() => []);
  assert.deepEqual(targets, []); assert(Date.now() - start < 1800); assert.equal(h.a.sending, false); assert(!h.clicks.includes("row"));
});

test("formal transfer reuses exact row/owned-confirm checks, always unknown after one attempt and never cancels favorite", async () => {
  const h = harness(); const targets = await h.a.readTransferTargets("9001", 1800); h.clicks.length = 0;
  const result = await h.a.transferConversation(request(h, targets[0].target_id));
  assert.equal(result.status, "unknown"); assert.equal(result.reason, "transfer_binding_unproven"); assert.equal(result.page_observed, "left_list");
  assert.equal(h.clicks.filter(x => x === "row").length, 1); assert.equal(h.clicks.filter(x => x === "confirm").length, 1);
  assert.equal(h.a.sending, false); assert.equal(h.a.markWatch, null);
  assert(h.scripts.some(s => s.includes('"text":"无原因直接转移","buyer":"9001"')));
});

for (const scenario of ["stale", "wrong_shop", "new_page", "unmark", "claim_revoked"] as const) {
  test(`${scenario}: zero transfer click`, async () => {
    const h = harness(); const targets = await h.a.readTransferTargets("9001", 1800); h.clicks.length = 0;
    const r = request(h, targets[0].target_id), t = h.a.formalTransferTargets.get(r.target_id);
    if (scenario === "stale") t.at -= 31000;
    if (scenario === "wrong_shop") t.shop = "other-mall";
    if (scenario === "new_page") h.a.watchEpoch++;
    if (scenario === "unmark") r.allow_unmark = true;
    if (scenario === "claim_revoked") r.recheck = () => "superseded";
    const result = await h.a.transferConversation(r); assert.equal(result.status, "not_sent"); assert(!h.clicks.includes("row")); assert(!h.clicks.includes("confirm"));
  });
}

test("actual generated row script checks unique buyer in its own DOM snapshot, including ABA/malformed active keys", async () => {
  const h = harness(); const targets = await h.a.readTransferTargets("9001", 1800); await h.a.transferConversation(request(h, targets[0].target_id));
  const script = h.scripts.find(s => s.includes("target_button_not_unique") && s.includes("scrollIntoView"))!; assert(script);
  const button: any = { innerText: "转移", children: [], getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 200, top: 100, width: 80, height: 30 }), scrollIntoView() {}, contains: (e: unknown) => e === button };
  const row = { querySelector: () => ({ innerText: "fictional-main" }), querySelectorAll: () => [button], getClientRects: () => [{}] };
  const dlg = { querySelector: () => ({ innerText: "转移会话" }), querySelectorAll: () => [row], getClientRects: () => [{}] };
  for (const [keys, ok] of [[["9001-a"], true], [["9001-a", "9001-b"], true], [["9002-a"], false], [["9001-a", "9002-a"], false], [["bad"], false], [[], false]] as const) {
    const doc = { querySelectorAll: (selector: string) => selector === "div.el-dialog" ? [dlg] : keys.map(key => ({ classList: { contains: () => true }, getAttribute: () => key })), elementFromPoint: () => button };
    const result = vm.runInNewContext(script, { document: doc, getComputedStyle: () => ({ visibility: "visible" }) });
    if (ok) assert.equal(typeof result.x, "number"); else assert.equal(result, "conversation_mismatch");
  }
});

for (const scenario of ["page", "login", "target_expiry"] as const) {
  test(`after row ${scenario} changes: unknown with no confirmation click or retry`, async () => {
    const h = harness({ onRow: a => {
      if (scenario === "page") a.watchEpoch++;
      if (scenario === "login") a.tracker = { status: () => ({ logged_in: false }) };
      if (scenario === "target_expiry") for (const t of a.formalTransferTargets.values()) t.at -= 31000;
    } });
    const targets = await h.a.readTransferTargets("9001", 1800); h.clicks.length = 0;
    const result = await h.a.transferConversation(request(h, targets[0].target_id));
    assert.equal(result.status, "unknown"); assert.equal(h.clicks.filter(x => x === "row").length, 1); assert(!h.clicks.includes("confirm")); assert.equal(h.a.sending, false);
  });
}
