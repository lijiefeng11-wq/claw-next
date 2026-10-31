import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 用 Electron 替身驱动真实的网络监听：诊断模式下标星请求与收藏列表响应写入 marked.jsonl，不含任何编号；
// “当前会话”取现场读取（编号＋页面代次＋对话变化代次），不用扫描缓存；非诊断模式不写。
const req = Module.createRequire(__filename);
const electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: { fromPartition: () => ({}) } } } as unknown as NodeModule;
const { PddPageAdapter } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

const A = "880011223344";
const B = "880099887766";
const URL_BASE = "https://mms.pinduoduo.com";
type Read = { uid: string | null; epoch: number; gen: number };

const appendModes: unknown[] = [];
const realAppend = fs.appendFile;
(fs as { appendFile: unknown }).appendFile = (file: fs.PathOrFileDescriptor, data: unknown, opts: unknown, cb: unknown) => {
  if (String(file).endsWith("marked.jsonl")) appendModes.push((opts as { mode?: number } | undefined)?.mode);
  return (realAppend as (...a: unknown[]) => void)(file, data, opts, cb);
};

function harness(probe: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-mark-probe-"));
  const bodies = new Map<string, string>();
  const dbg = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    attach: () => undefined,
    sendCommand: async (_m: string, p?: { requestId?: string }) => ({ body: bodies.get(p?.requestId ?? "") ?? "", base64Encoded: false }),
  });
  const page = { isDestroyed: () => false, webContents: { debugger: dbg } };
  const adapter = new PddPageAdapter("fixture", "虚构店铺", probe ? path.join(dir, "requests.jsonl") : null) as unknown as {
    attachNetwork(w: unknown): void;
    lastActiveUid: string | null;
    watchEpoch: number;
    freshActive(): Promise<Read>;
  };
  const reads: Read[] = [];
  let freshCalls = 0;
  adapter.freshActive = async () => {
    freshCalls++;
    return reads.shift() ?? { uid: null, epoch: adapter.watchEpoch, gen: 0 };
  };
  adapter.attachNetwork(page);
  const file = path.join(dir, "marked.jsonl");
  const request = (id: string, p: string, postData: string, response: string) => {
    bodies.set(id, response);
    dbg.emit("message", {}, "Network.requestWillBeSent", { requestId: id, request: { url: URL_BASE + p, postData } });
  };
  const finish = (id: string) => dbg.emit("message", {}, "Network.loadingFinished", { requestId: id });
  const send = (id: string, p: string, postData: string, response: string) => (request(id, p, postData, response), finish(id));
  const lines = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const records = async (n: number) => {
    for (let t = Date.now(); lines().length < n && Date.now() - t < 3000; ) await new Promise((r) => setTimeout(r, 10));
    return lines();
  };
  return { adapter, request, finish, send, records, file, reads, freshCalls: () => freshCalls };
}

const listBody = JSON.stringify({ success: true, result: { has_more: false, color_map: { [A]: 2, [B]: 7 }, marked_conversations: [{ from: { uid: A }, to: { uid: "cs-1" } }] } });
const LIST = "/plateau/chat/marked_lastest_conversations";
const markBody = (uid: string, color: number) => JSON.stringify({ data: { cmd: "mark_conversation", color, uid } });
const listOnce = async (before: Read, now: Read) => {
  const h = harness(true);
  h.adapter.lastActiveUid = A;
  h.reads.push(before, now);
  h.send("1", LIST, "{}", listBody);
  const [rec] = await h.records(1);
  return rec;
};

test("同一会话 A：记数值与计数，文件不含编号、请求权限 0600", async () => {
  const h = harness(true);
  h.adapter.lastActiveUid = A;
  h.reads.push({ uid: A, epoch: 0, gen: 1 }, { uid: A, epoch: 0, gen: 1 }, { uid: A, epoch: 0, gen: 1 });
  h.send("1", "/plateau/chat/mark_conversation", markBody(A, 2), JSON.stringify({ success: true }));
  h.send("2", LIST, "{}", listBody);
  h.send("3", "/plateau/chat/mark_read", JSON.stringify({ data: { conversation: { uid: A } } }), "{}");
  const recs = await h.records(2);
  const mark = recs.find((r) => r.kind === "mark_request");
  const list = recs.find((r) => r.kind === "marked_list");
  assert.equal(recs.length, 2);
  assert.deepEqual([mark.target_is_active, mark.color], [true, 2]);
  assert.deepEqual([list.active_same_as_request, list.active_in_map, list.active_value, list.from_uid_active], [true, true, 2, 1]);
  const text = fs.readFileSync(h.file, "utf8");
  for (const id of [A, B, "cs-1"]) assert.ok(!text.includes(id), `marked.jsonl 不得含编号 ${id}`);
  assert.ok(appendModes.length > 0 && appendModes.every((m) => m === 0o600), "写入须请求 0600");
  if (process.platform !== "win32") assert.equal(fs.statSync(h.file).mode & 0o777, 0o600);
});

test("扫描未执行、响应先到且页面已切到 B：以现场读取为准，记 B 的值、same=false", async () => {
  const rec = await listOnce({ uid: A, epoch: 0, gen: 1 }, { uid: B, epoch: 0, gen: 2 });
  assert.deepEqual([rec.active_same_as_request, rec.active_value], [false, 7]);
});

test("扫描缓存仍是 A、B 自己发出的标星：按现场读取判定为当前会话", async () => {
  const h = harness(true);
  h.adapter.lastActiveUid = A;
  h.reads.push({ uid: B, epoch: 0, gen: 2 });
  h.send("1", "/plateau/chat/mark_conversation", markBody(B, 4), "{}");
  const [rec] = await h.records(1);
  assert.deepEqual([rec.target_is_active, rec.color], [true, 4]);
});

test("A→B→A：终点同为 A 但对话变化代次不同，same=false", async () => {
  const rec = await listOnce({ uid: A, epoch: 0, gen: 1 }, { uid: A, epoch: 0, gen: 3 });
  assert.deepEqual([rec.active_same_as_request, rec.active_value], [false, 2]);
});

test("页面重建后同 uid 再出现：旧请求的响应记为未知", async () => {
  const rec = await listOnce({ uid: A, epoch: 0, gen: 1 }, { uid: A, epoch: 1, gen: 1 });
  assert.deepEqual([rec.active_known, rec.active_same_as_request, rec.active_in_map, rec.active_value], [false, false, false, "missing"]);
});

test("请求发出后、现场读取前页面代次变化：标星请求记为未知", async () => {
  const h = harness(true);
  h.adapter.lastActiveUid = A;
  h.reads.push({ uid: A, epoch: 5, gen: 1 });
  h.send("1", "/plateau/chat/mark_conversation", markBody(A, 2), "{}");
  const [rec] = await h.records(1);
  assert.deepEqual([rec.active_known, rec.target_is_active], [false, false]);
});

test("现场读不到唯一打开的对话：记为未知，不用扫描缓存兜底", async () => {
  const h = harness(true);
  h.adapter.lastActiveUid = A;
  h.reads.push({ uid: null, epoch: 0, gen: 1 }, { uid: null, epoch: 0, gen: 1 }, { uid: null, epoch: 0, gen: 1 });
  h.send("1", "/plateau/chat/mark_conversation", markBody(A, 2), "{}");
  h.send("2", LIST, "{}", listBody);
  const recs = await h.records(2);
  const mark = recs.find((r) => r.kind === "mark_request");
  const list = recs.find((r) => r.kind === "marked_list");
  assert.deepEqual([mark.active_known, mark.target_is_active], [false, false]);
  assert.deepEqual([list.active_known, list.active_in_map, list.active_value], [false, false, "missing"]);
});

test("真实 freshActive：重复读同一会话代次不变；A→B→A 代次递增；读取期间页面代次变化或多个打开对话记为未知", async () => {
  const adapter = new PddPageAdapter("fixture", "虚构店铺", null) as unknown as {
    freshActive(): Promise<Read>;
    scanKeepingFresh(): Promise<unknown>;
    watchEpoch: number;
  };
  const item = (uid: string, active: boolean) => ({ key: `${uid}-x`, active, unread: false });
  let next: { items: unknown[] } = { items: [item(A, true), item(B, false)] };
  let bump = false;
  adapter.scanKeepingFresh = async () => {
    if (bump) adapter.watchEpoch++;
    return next;
  };
  const r1 = await adapter.freshActive();
  const r2 = await adapter.freshActive();
  assert.equal(r1.uid, A);
  assert.equal(r2.gen, r1.gen);
  next = { items: [item(A, false), item(B, true)] };
  const r3 = await adapter.freshActive();
  next = { items: [item(A, true), item(B, false)] };
  const r4 = await adapter.freshActive();
  assert.equal(r3.uid, B);
  assert.equal(r4.uid, A);
  assert.ok(r4.gen > r3.gen && r3.gen > r1.gen);
  next = { items: [item(A, true), item(B, true)] };
  assert.equal((await adapter.freshActive()).uid, null);
  next = { items: [item(A, true)] };
  bump = true;
  const r6 = await adapter.freshActive();
  assert.equal(r6.uid, null);
  assert.equal(r6.epoch, adapter.watchEpoch);
});

test("非诊断模式：不现场读取、不写 marked.jsonl", async () => {
  const h = harness(false);
  h.adapter.lastActiveUid = A;
  h.send("1", "/plateau/chat/mark_conversation", markBody(A, 2), "{}");
  h.send("2", LIST, "{}", listBody);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.existsSync(h.file), false);
  assert.equal(h.freshCalls(), 0);
});
