/**
 * 诊断模式收藏颜色测试（starTest）：真实 Electron 渲染进程 + 虚构 data: 页面（不联网、不连接平台或后台）。
 * 用法：npm run build 后 `npx --no-install electron scripts/test-star-test.cjs`（Linux CI 加 --no-sandbox）。
 *
 * 覆盖：未收藏时只点红色项（不点星标本身）并以页面状态确认；已是红色时不点击；无已打开对话时不执行；
 * 非诊断模式不执行；点击前写本地尝试记录。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-star-test-"));
app.setPath("userData", temp);
const { PddPageAdapter } = require("../dist/src/main/pddAdapter.js");

const page = (active) => `<!doctype html><meta charset="utf-8"><body style="font:14px sans-serif;margin:0">
  <ul class="chat-list"><li class="chat-item"><div class="chat-item-box ${active ? "active" : ""}" data-random="9001-x">虚构买家</div></li></ul>
  <div style="position:absolute;left:400px;top:40px"><span><i id="star" title="收藏该用户" style="display:inline-block;width:20px;height:20px;background:#eee"></i></span></div>
  <div id="pop" class="el-popover" style="display:none;position:absolute;left:300px;top:70px;width:220px;height:40px"><ul style="display:flex;gap:10px;margin:0;padding:8px;list-style:none"></ul></div>
  <script>
    window.clicks = [];
    const colors = { red: "rgb(240, 90, 90)", orange: "rgb(245, 170, 50)", blue: "rgb(100, 160, 220)", green: "rgb(90, 180, 100)" };
    let fav = null;
    const ul = document.querySelector("#pop ul");
    for (const [name, bg] of Object.entries(colors)) {
      const li = document.createElement("li");
      li.style.cssText = "width:30px;height:24px";
      li.innerHTML = '<span style="display:inline-block;width:16px;height:16px;border-radius:8px;background:' + bg + '"></span><i class="chat-icon-check" style="display:none;width:8px;height:8px"></i>';
      li.addEventListener("click", () => { clicks.push(name); fav = name; render(); });
      ul.appendChild(li);
    }
    const star = document.getElementById("star");
    star.addEventListener("click", () => { clicks.push("star"); fav = fav ? null : "red"; render(); });
    star.addEventListener("mouseenter", () => { document.getElementById("pop").style.display = "block"; });
    document.body.addEventListener("mousemove", (e) => { if (e.clientX < 50 && e.clientY < 50) document.getElementById("pop").style.display = "none"; });
    function render() {
      star.classList.toggle("active", !!fav);
      [...ul.children].forEach((li, i) => { li.querySelector("i").style.display = Object.keys(colors)[i] === fav ? "inline-block" : "none"; });
    }
    window.setFav = (c) => { fav = c; render(); };
  </script></body>`;

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
const watchdog = setTimeout(() => {
  console.log(JSON.stringify({ ok: false, error: "timeout", results }));
  app.exit(2);
}, 60_000);

async function adapterFor(win, html, probe = true) {
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const wc = win.webContents;
  if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
  const pg = { webContents: wc, isDestroyed: () => win.isDestroyed() || wc.isDestroyed(), loadURL: (u) => wc.loadURL(u), close: () => win.destroy(), on: () => undefined };
  const adapter = new PddPageAdapter("fixture", "虚构店铺", probe ? path.join(temp, "diag", "fixture", "requests.jsonl") : null, () => pg);
  fs.mkdirSync(path.join(temp, "diag", "fixture"), { recursive: true });
  adapter.window = pg;
  adapter.tracker = { status: () => ({ logged_in: true }), end() {} };
  return { wc, adapter };
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.showInactive();
    const logFile = path.join(temp, "diag", "fixture", "star-test.jsonl");
    {
      const { wc, adapter } = await adapterFor(win, page(true));
      const r = await adapter.starTest("red");
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
      check("未收藏：只点红色项并以页面状态确认", r === "confirmed" && JSON.stringify(clicks) === '["red"]', { r, clicks });
      check("点击前写尝试记录，结束写确认记录", log.length === 2 && log[0].phase === "attempt" && log[1].phase === "confirmed", log);
    }
    {
      const { wc, adapter } = await adapterFor(win, page(true));
      await wc.executeJavaScript("setFav('red')");
      const r = await adapter.starTest("red");
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      check("已是红色：不点击", r === "already" && clicks.length === 0, { r, clicks });
    }
    {
      const { wc, adapter } = await adapterFor(win, page(true));
      await wc.executeJavaScript("setFav('blue')");
      const r = await adapter.starTest("red");
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      check("已收藏为蓝色：改为红色，不点星标", r === "confirmed" && JSON.stringify(clicks) === '["red"]', { r, clicks });
    }
    {
      const { wc, adapter } = await adapterFor(win, page(false));
      const r = await adapter.starTest("red");
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      check("无已打开对话：不执行", r === "not_executed:no_active_conversation" && clicks.length === 0, { r, clicks });
    }
    {
      const { wc, adapter } = await adapterFor(win, page(true), false);
      const r = await adapter.starTest("red");
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      check("非诊断模式：不执行", r === "not_executed:probe_mode_required" && clicks.length === 0, { r, clicks });
    }
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
