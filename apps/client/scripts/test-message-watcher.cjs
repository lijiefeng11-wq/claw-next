// 本机 Electron 集成验收：只载入虚构 HTML；拒绝网络，不访问店铺、登录目录或发送接口。
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PddMessageWatcher } = require("../dist/src/main/pddMessageWatcher.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-watcher-test-"));
app.setPath("userData", dir);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw Error("fixture_wait_timeout"); await sleep(10); }
}
let watcher, win;
app.whenReady().then(async () => {
  const isolated = session.fromPartition(`watcher-test-${process.pid}`);
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_d, done) => done({ cancel: true }));
  win = new BrowserWindow({ show: false, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const wc = win.webContents;
  wc.debugger.attach("1.3");
  let scans = 0, running = 0, peak = 0, blocked = false, release = null, slow = false;
  const started = [];
  watcher = new PddMessageWatcher(wc, async () => {
    scans++; started.push(performance.now()); running++; peak = Math.max(peak, running);
    if (slow) { slow = false; await new Promise((r) => { release = r; }); }
    running--;
  }, () => blocked, () => {});
  const html = '<!doctype html><div class="all-chat-list"><li class="chat-item">虚构会话</li></div><ul class="msg-list"></ul><div id="other"></div>';
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await until(() => watcher.context !== null); await sleep(100);
  assert.equal(await wc.executeJavaScript('Object.keys(globalThis).some(k => k.startsWith("clawMessageChanged_"))'), false);
  const baseline = scans, at = performance.now();
  await wc.executeJavaScript('document.querySelector(".chat-item").classList.add("un-watch")');
  await until(() => scans > baseline);
  const wakeMs = started[baseline] - at;
  assert.ok(wakeMs <= 200, `idle wake ${wakeMs.toFixed(1)} ms > 200 ms`);
  blocked = true;
  const beforeBlocked = scans;
  await wc.executeJavaScript('for (let i=0;i<20;i++) document.querySelector("ul.msg-list").append(document.createElement("li"))');
  await sleep(100); assert.equal(scans, beforeBlocked);
  blocked = false; watcher.scheduler.resume(); await until(() => scans > beforeBlocked); await sleep(80);
  assert.equal(scans, beforeBlocked + 1);
  const beforeReplace = scans;
  await wc.executeJavaScript('document.querySelector(".all-chat-list").outerHTML = "<div class=all-chat-list><li class=chat-item>替换列表</li></div>"');
  await until(() => scans > beforeReplace);
  slow = true; watcher.scheduler.request(); await until(() => release !== null);
  const beforeSlow = scans;
  await sleep(1700); assert.equal(scans, beforeSlow);
  release(); await until(() => scans > beforeSlow); assert.equal(peak, 1);
  const oldContext = watcher.context;
  wc.reload(); await until(() => watcher.context !== null && watcher.context !== oldContext);
  wc.debugger.detach(); await sleep(30); assert.equal(watcher.context, null);
  const beforeFallback = scans;
  await until(() => scans > beforeFallback);
  wc.debugger.attach("1.3"); await until(() => watcher.context !== null);
  console.log(JSON.stringify({ passed: true, idle_change_to_scan_ms: Math.round(wakeMs), peak_scans: peak, main_world_binding_absent: true, sending_deferred_once: true, replacement: true, reload: true, detach_fallback_and_reattach: true, real_platform: false }));
}).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  watcher?.close(); win?.destroy(); app.quit();
});
app.on("will-quit", () => { fs.rmSync(dir, { recursive: true, force: true }); });
