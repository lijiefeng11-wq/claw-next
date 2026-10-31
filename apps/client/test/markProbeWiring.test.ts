import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 用 Electron 替身驱动真实的网络监听：诊断模式下标星请求与收藏列表响应写入 marked.jsonl，且不含任何编号；非诊断模式不写。
const req = Module.createRequire(__filename);
const electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: { fromPartition: () => ({}) } } } as unknown as NodeModule;
const { PddPageAdapter } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

const ACTIVE = "880011223344";
const OTHER = "880099887766";
const URL_BASE = "https://mms.pinduoduo.com";

function harness(probe: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-mark-probe-"));
  const bodies = new Map<string, string>();
  const dbg = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    attach: () => undefined,
    sendCommand: async (_m: string, p?: { requestId?: string }) => ({ body: bodies.get(p?.requestId ?? "") ?? "", base64Encoded: false }),
  });
  const page = { isDestroyed: () => false, webContents: { debugger: dbg } };
  const adapter = new PddPageAdapter("fixture", "虚构店铺", probe ? path.join(dir, "requests.jsonl") : null) as unknown as { attachNetwork(w: unknown): void; lastActiveUid: string | null };
  adapter.attachNetwork(page);
  const send = (id: string, p: string, postData: string, response: string) => {
    bodies.set(id, response);
    dbg.emit("message", {}, "Network.requestWillBeSent", { requestId: id, request: { url: URL_BASE + p, postData } });
    dbg.emit("message", {}, "Network.loadingFinished", { requestId: id });
  };
  const records = async () => {
    await new Promise((r) => setTimeout(r, 50));
    const file = path.join(dir, "marked.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { adapter, send, records, dir };
}

test("诊断模式：标星请求与收藏列表响应写入 marked.jsonl，只含布尔/计数/候选数值", async () => {
  const h = harness(true);
  h.adapter.lastActiveUid = ACTIVE;
  h.send("1", "/plateau/chat/mark_conversation", JSON.stringify({ data: { cmd: "mark_conversation", color: 2, uid: ACTIVE } }), JSON.stringify({ success: true, result: { success: true } }));
  h.send("2", "/plateau/chat/marked_lastest_conversations", JSON.stringify({ data: { cmd: "x" } }), JSON.stringify({ success: true, result: { has_more: false, color_map: { [ACTIVE]: 2, [OTHER]: 3 }, marked_conversations: [{ from: { uid: ACTIVE }, to: { uid: "cs-1" } }] } }));
  h.send("3", "/plateau/chat/mark_read", JSON.stringify({ data: { conversation: { uid: ACTIVE } } }), "{}");
  const recs = await h.records();
  assert.deepEqual(recs.map((r) => r.kind), ["mark_request", "marked_list"]);
  assert.equal(recs[0].target_is_active, true);
  assert.equal(recs[0].color, 2);
  assert.equal(recs[1].active_in_map, true);
  assert.equal(recs[1].active_value, 2);
  assert.equal(recs[1].from_uid_active, 1);
  const text = fs.readFileSync(path.join(h.dir, "marked.jsonl"), "utf8");
  for (const id of [ACTIVE, OTHER, "cs-1"]) assert.ok(!text.includes(id), `marked.jsonl 不得含编号 ${id}`);
  assert.equal(fs.statSync(path.join(h.dir, "marked.jsonl")).mode & 0o777, 0o600);
});

test("非诊断模式：不写 marked.jsonl", async () => {
  const h = harness(false);
  h.adapter.lastActiveUid = ACTIVE;
  h.send("1", "/plateau/chat/mark_conversation", JSON.stringify({ data: { color: 2, uid: ACTIVE } }), "{}");
  assert.deepEqual(await h.records(), []);
});
