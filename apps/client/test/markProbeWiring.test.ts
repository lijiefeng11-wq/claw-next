import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 用 Electron 替身驱动真实的网络监听与真实的现场读取（只替换底层列表扫描）：诊断模式下标星请求与收藏列表响应
// 写入 marked.jsonl，不含任何编号；“当前会话”须是现场读取、且页面代次仍是请求发出时的代次，否则记为未知。
const req = Module.createRequire(__filename);
const electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: { fromPartition: () => ({}) } } } as unknown as NodeModule;
const { PddPageAdapter } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

const A = "880011223344";
const B = "880099887766";
const URL_BASE = "https://mms.pinduoduo.com";
type Item = { key: string; active: boolean; unread: boolean };
const only = (uid: string): Item[] => [
  { key: `${uid}-x`, active: true, unread: false },
  { key: `${uid === A ? B : A}-x`, active: false, unread: false },
];

const appendModes: unknown[] = [];
const realAppend = fs.appendFile;
(fs as { appendFile: unknown }).appendFile = (file: fs.PathOrFileDescriptor, data: unknown, opts: unknown, cb: unknown) => {
  if (String(file).endsWith("marked.jsonl")) appendModes.push((opts as { mode?: number } | undefined)?.mode);
  return (realAppend as (...a: unknown[]) => void)(file, data, opts, cb);
};

const wait = async (cond: () => boolean) => {
  for (let t = Date.now(); !cond() && Date.now() - t < 3000; ) await new Promise((r) => setTimeout(r, 10));
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
    scanKeepingFresh(): Promise<unknown>;
  };
  // 每次扫描依次取一项：items 为扫描结果；bump 表示扫描进行中页面重建。
  const scans: { items: Item[]; bump?: boolean }[] = [];
  let scanCalls = 0;
  adapter.scanKeepingFresh = async () => {
    scanCalls++;
    const next = scans.shift() ?? { items: [] };
    if (next.bump) adapter.watchEpoch++;
    return { items: next.items };
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
  // 默认只看请求与列表记录；响应记录另由 withResponses 取，避免写入先后影响取第一条。
  const pick = (all: boolean) => lines().filter((r) => all || !String(r.kind).endsWith("_response"));
  const records = async (n: number, withResponses = false) => (await wait(() => pick(withResponses).length >= n), pick(withResponses));
  return { adapter, request, finish, send, records, file, scans, scanCalls: () => scanCalls };
}

const listBody = JSON.stringify({ success: true, result: { has_more: false, color_map: { [A]: 2, [B]: 7 }, marked_conversations: [{ from: { uid: A }, to: { uid: "cs-1" } }] } });
const LIST = "/plateau/chat/marked_lastest_conversations";
const MARK = "/plateau/chat/mark_conversation";
const markBody = (uid: string, color: number) => JSON.stringify({ data: { cmd: "mark_conversation", request_id: 1, color, uid } });

test("同一会话 A：记数值与计数，文件不含编号、请求权限 0600；记录不含“与请求时同一会话”判断", async () => {
  const h = harness(true);
  h.adapter.lastActiveUid = A;
  h.scans.push({ items: only(A) }, { items: only(A) });
  h.send("1", MARK, markBody(A, 2), JSON.stringify({ success: true, result: { response: A, request_id: 1, result: "ok", success: true } }));
  h.send("2", LIST, "{}", listBody);
  h.send("3", "/plateau/chat/mark_read", JSON.stringify({ data: { conversation: { uid: A } } }), "{}");
  const recs = await h.records(3, true);
  const mark = recs.find((r) => r.kind === "mark_request");
  const list = recs.find((r) => r.kind === "marked_list");
  const resp = recs.find((r) => r.kind === "mark_response");
  assert.equal(recs.length, 3);
  assert.deepEqual([resp.top_success, resp.inner_success, resp.request_id_match, resp.result_value, resp.response_value], [true, true, true, "ok", "other"]);
  assert.deepEqual([mark.active_known, mark.target_is_active, mark.color], [true, true, 2]);
  assert.deepEqual([list.active_known, list.active_in_map, list.active_value, list.from_uid_active], [true, true, 2, 1]);
  assert.equal("active_same_as_request" in list, false);
  const text = fs.readFileSync(h.file, "utf8");
  for (const id of [A, B, "cs-1"]) assert.ok(!text.includes(id), `marked.jsonl 不得含编号 ${id}`);
  assert.ok(appendModes.length > 0 && appendModes.every((m) => m === 0o600), "写入须请求 0600");
  if (process.platform !== "win32") assert.equal(fs.statSync(h.file).mode & 0o777, 0o600);
});

test("扫描缓存仍是 A、B 自己发出的标星：按现场读取判定为当前会话", async () => {
  const h = harness(true);
  h.adapter.lastActiveUid = A;
  h.scans.push({ items: only(B) });
  h.send("1", MARK, markBody(B, 4), "{}");
  const [rec] = await h.records(1);
  assert.deepEqual([rec.target_is_active, rec.color], [true, 4]);
});

test("响应到达时已切到 B（同一页面）：按响应时现场读取记 B 的值", async () => {
  const h = harness(true);
  h.adapter.lastActiveUid = A;
  h.scans.push({ items: only(B) });
  h.send("1", LIST, "{}", listBody);
  const [rec] = await h.records(1);
  assert.deepEqual([rec.active_known, rec.active_value], [true, 7]);
});

for (const when of ["请求发出后、响应到达前", "响应现场读取进行中"] as const) {
  test(`收藏列表：${when}页面重建、同 uid A 仍打开，旧响应记为未知`, async () => {
    const h = harness(true);
    h.request("1", LIST, "{}", listBody);
    if (when === "请求发出后、响应到达前") {
      h.adapter.watchEpoch++;
      h.scans.push({ items: only(A) });
    } else {
      h.scans.push({ items: only(A), bump: true });
    }
    h.finish("1");
    const [rec] = await h.records(1);
    assert.deepEqual([rec.active_known, rec.active_in_map, rec.active_value], [false, false, "missing"]);
    assert.equal(h.scanCalls(), when === "请求发出后、响应到达前" ? 0 : 1);
  });
}

test("收藏列表：页面未变的对照例记为已知", async () => {
  const h = harness(true);
  h.request("1", LIST, "{}", listBody);
  h.scans.push({ items: only(A) });
  h.finish("1");
  const [rec] = await h.records(1);
  assert.deepEqual([rec.active_known, rec.active_value], [true, 2]);
});

test("标星请求：现场读取进行中页面重建，记为未知", async () => {
  const h = harness(true);
  h.scans.push({ items: only(A), bump: true });
  h.send("1", MARK, markBody(A, 2), "{}");
  const [rec] = await h.records(1);
  assert.deepEqual([rec.active_known, rec.target_is_active], [false, false]);
});

test("同一买家同时出现在“待回复”与“全部”列表且都打开：按买家去重，判定为当前会话", async () => {
  const h = harness(true);
  h.scans.push({ items: [{ key: `${A}-x`, active: true, unread: false }, { key: `${A}-y`, active: true, unread: false }, { key: `${B}-x`, active: false, unread: false }] });
  h.send("1", MARK, markBody(A, 2), "{}");
  const [rec] = await h.records(1);
  assert.deepEqual([rec.active_known, rec.target_is_active, rec.color], [true, true, 2]);
});

test("现场读不到唯一打开的对话（无或多个）：记为未知，不用扫描缓存兜底", async () => {
  const h = harness(true);
  h.adapter.lastActiveUid = A;
  h.scans.push({ items: [] }, { items: [...only(A).slice(0, 1), ...only(B).slice(0, 1)] });
  h.send("1", MARK, markBody(A, 2), "{}");
  await h.records(1);
  h.send("2", LIST, "{}", listBody);
  const recs = await h.records(2);
  const mark = recs.find((r) => r.kind === "mark_request");
  const list = recs.find((r) => r.kind === "marked_list");
  assert.deepEqual([mark.active_known, mark.target_is_active], [false, false]);
  assert.deepEqual([list.active_known, list.active_in_map, list.active_value], [false, false, "missing"]);
});

test("非诊断模式：不现场读取、不写 marked.jsonl", async () => {
  const h = harness(false);
  h.adapter.lastActiveUid = A;
  h.send("1", MARK, markBody(A, 2), "{}");
  h.send("2", LIST, "{}", listBody);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.existsSync(h.file), false);
  assert.equal(h.scanCalls(), 0);
});
