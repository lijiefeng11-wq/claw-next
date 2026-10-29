/**
 * 诊断点击记录（CLAW_NEXT_PDD_PROBE=1）的隐私与覆盖：真实 Electron 渲染进程 + 虚构 data: 页面（不联网、不连接平台或后台）。
 * 用法：npm run build 后 `npx --no-install electron scripts/test-ui-recorder.cjs`（Linux CI 加 --no-sandbox）；
 * 界面端到端测试（scripts/e2e.mjs）会自动运行。输出一行 JSON，全部通过时退出码 0。
 *
 * 覆盖：会话列表内的收藏/标星图标能记录（标签只取操作类 title），选会话、点昵称不记录，昵称作 title 的头像不带出昵称；
 * 工具栏“转移会话”及其弹窗标题能记录，弹窗里的客服名不记录；不由已知词组成的类名（含数字或全字母标识）、消息区与输入框内的点击不记录；
 * 按钮地图包含会话列表图标且不含昵称。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-ui-recorder-"));
app.setPath("userData", temp);
const { UI_RECORDER, UI_MAP } = require("../dist/src/main/pddAdapter.js");

const NICK = "虚构买家甲";
const NICK2 = "小星星";
const NICK3 = "转转好物";
const AGENT = "虚构客服乙";
const HTML = `<!doctype html><meta charset="utf-8"><body style="font:14px sans-serif">
  <ul class="chat-list">
    <li class="chat-item active fictionalBuyerAlice redGreen"><div class="chat-item-box u-7731942 alicebuyer online-staff userData icon-redGreen" data-random="9001-x">
      <span class="nickname" title="${NICK}">${NICK}</span>
      <img class="avatar" title="${NICK}" style="width:20px;height:20px">
      <img class="avatar2" title="${NICK2}" style="width:20px;height:20px">
      <img class="avatar3" title="${NICK3}" style="width:20px;height:20px">
      <span class="op" title="收藏"><i id="fav" class="icon icon-collect" style="display:inline-block;width:12px;height:12px"></i></span>
      <i id="star" class="icon icon-star star-c3f9a2" title="标星" style="display:inline-block;width:12px;height:12px"></i>
    </div></li>
  </ul>
  <ul class="msg-list"><li><button id="msgbtn">${NICK}</button></li></ul>
  <textarea id="ta"></textarea>
  <div class="toolbar"><button id="transfer" class="btn btn-transfer">转移会话</button></div>
  <div id="dlg" class="el-dialog" style="display:none;width:200px"><div class="el-dialog__title">转移会话</div><ul><li class="agent">${AGENT}（在线）</li></ul></div>
  <script>document.getElementById("transfer").onclick = () => { document.getElementById("dlg").style.display = "block"; };</script>
</body>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

const watchdog = setTimeout(() => {
  console.log(JSON.stringify({ ok: false, error: "timeout", results }));
  app.exit(2);
}, 60_000);

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(HTML));
    const wc = win.webContents;
    const iso = (code) => wc.executeJavaScriptInIsolatedWorld(1001, [{ code }]);
    await iso(UI_RECORDER);
    for (const sel of ["#fav", "#star", ".nickname", ".avatar", ".avatar2", ".avatar3", ".chat-item-box", "#msgbtn", "#ta", "#transfer"]) {
      await wc.executeJavaScript(`document.querySelector(${JSON.stringify(sel)}).click()`);
      await sleep(50);
    }
    await sleep(3300);
    const clicks = (await iso("window.__clawUi.queue.splice(0)")) || [];
    const map = (await iso(UI_MAP)) || [];
    const all = JSON.stringify({ clicks, map });
    check("会话列表收藏图标：标签取外层 title", clicks.some((c) => c.area === "chat_list" && c.label === "收藏" && c.icon === "i.icon.icon-collect"), clicks);
    check("会话列表标星图标：标签取 title，含数字的类名被去掉", clicks.some((c) => c.area === "chat_list" && c.label === "标星" && c.chain.endsWith("i.icon.icon-star")), clicks);
    check("工具栏转移会话：记录按钮与弹窗标题", clicks.some((c) => c.label === "转移会话" && c.opened.includes("转移会话")), clicks);
    const listLabels = clicks.filter((c) => c.area === "chat_list").map((c) => c.label ?? "-").sort();
    check("会话列表：选会话、点昵称不记录；头像只记图标、不取昵称 title（含“星”“转”的昵称也不取）", JSON.stringify(listLabels) === JSON.stringify(["-", "-", "-", "收藏", "标星"].sort()), clicks);
    check("消息区、输入框内的点击不记录", clicks.length <= 6 && !clicks.some((c) => /msg-list|textarea/.test(c.chain)), clicks);
    check("记录与按钮地图不含昵称、客服名、动态编号", ![NICK, NICK2, NICK3, AGENT].some((s) => all.includes(s)) && !/7731942|9001|c3f9a2|fictionalBuyerAlice|alicebuyer|redGreen|online-staff|userData/i.test(all), all.slice(0, 400));
    check("按钮地图包含会话列表图标", map.some((m) => m.area === "chat_list" && m.label === "标星") && map.some((m) => m.area === "chat_list" && m.label === "收藏"), map);
    win.destroy();
  } catch (err) {
    check("运行", false, String((err && err.stack) || err).slice(0, 400));
  }
  clearTimeout(watchdog);
  const ok = results.length > 0 && results.every((r) => r.ok);
  console.log(JSON.stringify({ ok, results }));
  fs.rmSync(temp, { recursive: true, force: true });
  app.exit(ok ? 0 : 1);
});
