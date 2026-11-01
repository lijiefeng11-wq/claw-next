import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 用 Electron 替身驱动真实的网络监听（只替换底层列表扫描与调试通道）：诊断模式下转移取证写入 transfer-probe.jsonl。
// 关联规则：请求发出时冻结页面代次与诊断批次；异步读取前后页面或诊断批次变了，记 stale 且不关联目标与尝试时间。
const req = Module.createRequire(__filename);
const electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: { fromPartition: () => ({}) } } } as unknown as NodeModule;
const { PddPageAdapter } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

const A = "880011223344";
const CSID = "cs-9f3a71";
const NAME = "主账号";
const URL_BASE = "https://mms.pinduoduo.com";
const MOVE = "/plateau/chat/move_conversation";
const ASSIGN = "/latitude/assign/getCsList";
type Item = { key: string; active: boolean; unread: boolean };
const only = (uid: string): Item[] => [{ key: `${uid}-x`, active: true, unread: false }];
const moveBody = JSON.stringify({ data: { cmd: "move_conversation", conversation: { csid: CSID, uid: A, need_wx: false, remark: "" } } });
const assignBody = JSON.stringify({ result: { list: [{ id: CSID, username: NAME, nickname: "小王" }] } });
const okBody = JSON.stringify({ success: true, result: { result: "ok" } });

const wait = async (cond: () => boolean) => {
  for (let t = Date.now(); !cond() && Date.now() - t < 3000; ) await new Promise((r) => setTimeout(r, 10));
};

function harness(probe: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-transfer-probe-"));
  const bodies = new Map<string, string>();
  // 同一请求可能有多路读取（原有动作结构记录与本取证各一次）：挂起时全部挂起，释放时一起放行。
  const held = new Map<string, (() => void)[]>();
  const hold = new Set<string>();
  const bodyReads: string[] = [];
  const dbg = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    attach: () => undefined,
    sendCommand: async (m: string, p?: { requestId?: string }) => {
      const id = p?.requestId ?? "";
      if (m === "Network.getResponseBody") bodyReads.push(id);
      if (hold.has(id)) await new Promise<void>((r) => held.set(id, [...(held.get(id) ?? []), r]));
      return { body: bodies.get(id) ?? "", base64Encoded: false };
    },
  });
  const page = { isDestroyed: () => false, webContents: { debugger: dbg, on: () => undefined } };
  const adapter = new PddPageAdapter("fixture", "虚构店铺", probe ? path.join(dir, "requests.jsonl") : null) as unknown as {
    attachNetwork(w: unknown): void;
    watchEpoch: number;
    transferProbeCtx: { seq: number; target: string; epoch: number; startedAt: number; attemptAt: number | null } | null;
    scanKeepingFresh(): Promise<unknown>;
  };
  // 每次扫描依次取一项；gate 为 Promise 时等它完成再返回（模拟扫描进行中发生变化）。
  const scans: { items: Item[]; gate?: Promise<void> }[] = [];
  adapter.scanKeepingFresh = async () => {
    const next = scans.shift() ?? { items: [] };
    if (next.gate) await next.gate;
    return { items: next.items };
  };
  adapter.attachNetwork(page);
  const file = path.join(dir, "transfer-probe.jsonl");
  const request = (id: string, p: string, postData: string, response: string) => {
    bodies.set(id, response);
    dbg.emit("message", {}, "Network.requestWillBeSent", { requestId: id, request: { url: URL_BASE + p, postData } });
  };
  const finish = (id: string) => dbg.emit("message", {}, "Network.loadingFinished", { requestId: id });
  const lines = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const records = async (n: number) => (await wait(() => lines().length >= n), lines());
  const diag = (seq: number, attemptAgoMs: number | null = 50) => {
    adapter.transferProbeCtx = { seq, target: NAME, epoch: adapter.watchEpoch, startedAt: Date.now(), attemptAt: attemptAgoMs === null ? null : Date.now() - attemptAgoMs };
  };
  const release = (id: string) => {
    hold.delete(id);
    for (const r of held.get(id) ?? []) r();
  };
  return { adapter, request, finish, records, file, scans, hold, release, diag, bodyReads: () => bodyReads };
}

test("对照：诊断进行中、页面未变——bound，关联账号名与尝试时间；日志只有匿名序号，不含编号与名称", async () => {
  const h = harness(true);
  h.diag(1);
  h.request("REQ-assign-77abc", ASSIGN, "{}", assignBody);
  h.finish("REQ-assign-77abc");
  await h.records(1);
  h.scans.push({ items: only(A) });
  h.request("REQ-move-88def", MOVE, moveBody, okBody);
  h.finish("REQ-move-88def");
  const recs = await h.records(3);
  const assign = recs.find((r) => r.kind === "assign_response");
  const move = recs.find((r) => r.kind === "move_request");
  const resp = recs.find((r) => r.kind === "move_response");
  assert.deepEqual([assign.candidates, assign.candidates_complete, assign.cached], [1, true, true]);
  assert.deepEqual([move.binding, move.target_known, move.target_is_active, move.candidate_name_eq_username, move.csid_eq_id_of_username_candidate], ["bound", true, true, 1, true]);
  assert.equal(typeof move.ms_after_attempt, "number");
  assert.deepEqual([resp.binding, resp.inner_result, resp.req_seq], ["bound", "ok", move.req_seq]);
  assert.notEqual(assign.req_seq, move.req_seq);
  const text = fs.readFileSync(h.file, "utf8");
  for (const s of [A, CSID, NAME, "小王", "REQ-assign-77abc", "REQ-move-88def"]) assert.ok(!text.includes(s), `日志不得含 ${s}`);
  if (process.platform !== "win32") assert.equal(fs.statSync(h.file).mode & 0o777, 0o600);
});

test("反例：页面 1 的响应读取挂起，期间切到页面 2 并开始新诊断——旧响应记 stale，不套用新诊断的尝试时间", async () => {
  const h = harness(true);
  h.diag(1);
  h.scans.push({ items: only(A) });
  h.hold.add("old");
  h.request("old", MOVE, moveBody, okBody);
  h.finish("old");
  await h.records(1);
  h.adapter.watchEpoch++;
  h.diag(2, 10);
  h.release("old");
  const recs = await h.records(2);
  const resp = recs.find((r) => r.kind === "move_response");
  assert.deepEqual([resp.binding, resp.diag_seq, resp.ms_after_attempt], ["stale", 1, null]);
});

test("反例：请求时没有诊断，现场读取进行中才开始诊断——unbound，不套用新诊断的账号名", async () => {
  const h = harness(true);
  let open!: () => void;
  h.scans.push({ items: only(A), gate: new Promise<void>((r) => (open = r)) });
  h.request("early", MOVE, moveBody, okBody);
  h.diag(5);
  open();
  const [rec] = (await h.records(1)).filter((r) => r.kind === "move_request");
  assert.deepEqual([rec.binding, rec.target_known, rec.diag_seq, rec.ms_after_attempt], ["unbound", false, null, null]);
  assert.equal(rec.candidate_name_eq_username, 0);
});

test("反例：请求时有诊断，现场读取进行中换了诊断批次——stale，不关联账号名", async () => {
  const h = harness(true);
  h.diag(1);
  let open!: () => void;
  h.scans.push({ items: only(A), gate: new Promise<void>((r) => (open = r)) });
  h.request("m", MOVE, moveBody, okBody);
  h.diag(2);
  open();
  const [rec] = (await h.records(1)).filter((r) => r.kind === "move_request");
  assert.deepEqual([rec.binding, rec.target_known, rec.diag_seq], ["stale", false, 1]);
});

test("页面已变后才到的客服列表不缓存，后续转移请求不拿它比较", async () => {
  const h = harness(true);
  h.diag(1);
  h.hold.add("a");
  h.request("a", ASSIGN, "{}", assignBody);
  h.finish("a");
  h.adapter.watchEpoch++;
  h.release("a");
  const [assign] = await h.records(1);
  assert.deepEqual([assign.kind, assign.cached, assign.binding], ["assign_response", false, "stale"]);
  h.diag(2);
  h.scans.push({ items: only(A) });
  h.request("m", MOVE, moveBody, okBody);
  const move = (await h.records(2)).find((r) => r.kind === "move_request");
  assert.deepEqual([move.candidates_known, move.candidates], [false, 0]);
});

test("诊断模式关闭：不写文件，读取与改动前完全相同（转移接口在原有 /plateau/chat/ 观察范围内本就读一次，客服列表不读）", async () => {
  const h = harness(false);
  h.request("m", MOVE, moveBody, okBody);
  h.finish("m");
  h.request("a", ASSIGN, "{}", assignBody);
  h.finish("a");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(h.bodyReads(), ["m"]);
  assert.equal(fs.existsSync(h.file), false);
});
