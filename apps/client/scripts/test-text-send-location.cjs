// 真实适配器与 Electron 命中测试；仅虚构 data: 页面，平台回执替身，不联网、不读取用户资料。
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-send-location-"));
app.setPath("userData", temp);
const { PddPageAdapter } = require("../dist/src/main/pddAdapter.js");
const results = [];
const watchdog = setTimeout(() => app.exit(2), 45_000);

function html(s) {
  const button = '<div class="send-btn" onclick="clicks++"><span>发送</span></div>';
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0} .reply-box{position:absolute;left:120px;top:100px;width:300px}
    textarea{width:200px;height:60px} .reply-footer{position:relative}
    .send-btn{position:relative;display:inline-block;width:100px;height:40px;background:#69f}
    ${s.css || ""}${s.revealButton ? '#composer .send-btn{visibility:hidden}' : ""}</style>
    <ul><li class="chat-item"><div class="chat-item-box active" data-random="${s.otherBuyer ? "9002" : "9001"}-fixture"></div></li></ul>
    ${s.offscreenDuplicate ? '<div class="reply-box" style="left:-1200px"><div class="reply-footer">' + button + '</div></div>' : ""}
    <div class="reply-box" id="composer"><div class="reply-input"><textarea></textarea></div>
      <div class="reply-footer">${s.hiddenDuplicate ? '<div class="send-btn" style="display:none"></div>' : ""}
      ${button}${s.ambiguous ? button : ""}</div></div>
    ${s.mask ? '<div style="position:fixed;inset:0;background:#fff;z-index:10"></div>' : ""}
    <script>window.clicks=0;${s.changeDraft ? 'document.querySelector("textarea").addEventListener("input",e=>{if(e.target.value)e.target.value="人工草稿"})' : ""}
    ${s.revealButton ? 'document.querySelector("textarea").addEventListener("input",()=>{document.querySelector("#composer .send-btn").style.visibility="visible"})' : ""}</script>`;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const wc = win.webContents;
  wc.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("data:") }));
  wc.debugger.attach("1.3");
  const scenarios = [
    { name: "normal", status: "confirmed" },
    { name: "button_appears_after_input", revealButton: true, status: "confirmed" },
    { name: "hidden_first_button", hiddenDuplicate: true, status: "confirmed" },
    { name: "offscreen_button_in_other_composer", offscreenDuplicate: true, status: "confirmed" },
    { name: "partly_clipped_button", css: "#composer{left:-80px}", status: "confirmed" },
    { name: "center_covered_but_same_button_has_clear_point", css: ".reply-footer::after{content:'';position:absolute;left:40px;top:0;width:20px;height:40px;background:#fff;z-index:1}", status: "confirmed" },
    { name: "zoom80", zoom: 0.8, status: "confirmed" },
    { name: "fully_covered", mask: true, status: "not_sent", reason: "pdd_send_button_covered" },
    { name: "two_visible_buttons_are_ambiguous", ambiguous: true, status: "not_sent", reason: "pdd_input_missing" },
    { name: "different_conversation", otherBuyer: true, status: "not_sent", reason: "pdd_conversation_changed" },
    { name: "human_draft_changed", changeDraft: true, status: "not_sent", reason: "pdd_input_mismatch" },
    { name: "page_changed_after_location", pageChanged: true, status: "not_sent", reason: "pdd_page_changed" },
    { name: "deadline_recheck_blocks_click", recheck: "reply_deadline_exceeded", status: "not_sent", reason: "reply_deadline_exceeded" },
  ];
  try {
    for (const s of scenarios) {
      await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html(s)));
      wc.setZoomFactor(s.zoom || 1);
      const commands = [];
      const adapter = new PddPageAdapter("fixture", "虚构店铺");
      const debug = {
        isAttached: () => wc.debugger.isAttached(),
        sendCommand: async (method, params) => {
          commands.push(params.type);
          const result = await wc.debugger.sendCommand(method, params);
          if (params.type === "mouseReleased") {
            const clicked = await wc.executeJavaScript("window.clicks");
            adapter.outgoing?.resolve(clicked === 1 ? { status: "confirmed", platform_message_id: "fixture-only" } : { status: "unknown", reason: "fixture_click_missed" });
          }
          return result;
        },
      };
      adapter.window = { isDestroyed: () => win.isDestroyed(), webContents: { isDestroyed: () => wc.isDestroyed(), debugger: debug, executeJavaScriptInIsolatedWorld: (...args) => wc.executeJavaScriptInIsolatedWorld(...args) } };
      adapter.tracker = { status: () => ({ logged_in: true }) };
      adapter.openConversation = async () => null;
      if (s.pageChanged) {
        const run = adapter.run.bind(adapter);
        adapter.run = async code => { const value = await run(code); if (code.includes("pdd_send_button_covered")) adapter.watchEpoch++; return value; };
      }
      const result = await adapter.send({ conversation_id: "9001", text: "虚构回复", attempt_id: "fixture-only", deadline: Date.now() / 1000 + 10, recheck: () => s.recheck || null });
      const clicks = await wc.executeJavaScript("window.clicks");
      try {
        assert.equal(result.status, s.status);
        if (s.reason) assert.equal(result.reason, s.reason);
        assert.equal(clicks, s.status === "confirmed" ? 1 : 0);
        assert.deepEqual(commands, s.status === "confirmed" ? ["mousePressed", "mouseReleased"] : []);
        assert.equal(adapter.sending, false);
        assert.equal(adapter.outgoing, null);
        if (s.changeDraft) assert.equal(await wc.executeJavaScript('document.querySelector("textarea").value'), "人工草稿");
        results.push({ name: s.name, ok: true, result, clicks, commands });
      } catch (error) {
        results.push({ name: s.name, ok: false, result, clicks, commands, error: error.message });
      }
    }
  } catch (error) {
    results.push({ name: "fixture", ok: false, error: String(error.stack || error) });
  } finally {
    win.destroy();
    clearTimeout(watchdog);
    fs.rmSync(temp, { recursive: true, force: true });
  }
  const ok = results.length === scenarios.length && results.every(r => r.ok);
  console.log(JSON.stringify({ ok, fictional_data_page_only: true, real_adapter_and_native_hit_test: true, platform_receipt_stubbed: true, results }));
  app.exit(ok ? 0 : 1);
});
