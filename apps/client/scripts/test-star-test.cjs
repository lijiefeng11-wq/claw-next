/**
 * 诊断模式收藏颜色测试（starTest）：真实 Electron 渲染进程 + 虚构 data: 页面（不联网、不连接平台或后台）。
 * 用法：npm run build 后 `npx --no-install electron scripts/test-star-test.cjs`（Linux CI 加 --no-sandbox）。
 *
 * 覆盖：未收藏时只点红色项（不点星标本身）并以页面状态确认；已是红色时不点击；无已打开对话时不执行；
 * 非诊断模式不执行；点击前写本地尝试记录；
 * 反例（均零点击）：只有无关红/蓝菜单、两个颜色浮层候选、颜色项被遮挡、取令牌后切换对话、悬停后（点击前）切换对话。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-star-test-"));
app.setPath("userData", temp);
const { PddPageAdapter } = require("../dist/src/main/pddAdapter.js");

const colors = { red: "rgb(240, 90, 90)", orange: "rgb(245, 170, 50)", blue: "rgb(100, 160, 220)", green: "rgb(90, 180, 100)" };
const dots = (names) => names.map((n) => `<li style="width:30px;height:24px"><span style="display:inline-block;width:16px;height:16px;border-radius:8px;background:${colors[n]}"></span></li>`).join("");

/** opts: active 有打开的对话；unrelated 页面上另有一个无关红/蓝菜单；noStarPop 星标悬停不出颜色浮层；
 *  twin 星标旁另有一个同样的颜色浮层；cover 颜色浮层被遮挡；switchOnHover 悬停星标时切到另一个对话。 */
const page = (opts = {}) => `<!doctype html><meta charset="utf-8"><body style="font:14px sans-serif;margin:0">
  <ul class="chat-list">
    <li class="chat-item"><div class="chat-item-box ${opts.active === false ? "" : "active"}" data-random="9001-x">虚构买家</div></li>
    <li class="chat-item"><div class="chat-item-box" data-random="9002-x">虚构买家2</div></li>
  </ul>
  <div style="position:absolute;left:400px;top:40px"><span><i id="star" title="收藏该用户" style="display:inline-block;width:20px;height:20px;background:#eee"></i></span></div>
  <div id="pop" class="el-popover" style="display:none;position:absolute;left:300px;top:70px;width:220px;height:40px"><ul style="display:flex;gap:10px;margin:0;padding:8px;list-style:none"></ul></div>
  ${opts.unrelated ? `<div class="el-popover" style="position:absolute;left:330px;top:200px;width:120px;height:40px"><ul style="display:flex;gap:10px;margin:0;padding:8px;list-style:none">${dots(["red", "blue"])}</ul></div>` : ""}
  ${opts.twin ? `<div class="el-popover" style="position:absolute;left:300px;top:120px;width:220px;height:40px"><ul style="display:flex;gap:10px;margin:0;padding:8px;list-style:none">${dots(["red", "orange", "blue", "green"])}</ul></div>` : ""}
  ${opts.cover ? `<div id="cover" style="display:none;position:absolute;left:290px;top:60px;width:260px;height:60px;background:rgba(0,0,0,.01);z-index:9"></div>` : ""}
  <script>
    window.clicks = [];
    const colors = ${JSON.stringify(colors)};
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
    star.addEventListener("mouseenter", () => {
      if (!${!!opts.noStarPop}) document.getElementById("pop").style.display = "block";
      if (${!!opts.cover}) document.getElementById("cover").style.display = "block";
      if (${!!opts.switchOnHover}) { const [a, b] = document.querySelectorAll(".chat-item-box"); a.classList.remove("active"); b.classList.add("active"); }
    });
    document.body.addEventListener("mousemove", (e) => { if (e.clientX < 50 && e.clientY < 50) document.getElementById("pop").style.display = "none"; });
    function render() {
      star.classList.toggle("active", !!fav);
      [...ul.children].forEach((li, i) => { li.querySelector("i").style.display = Object.keys(colors)[i] === fav ? "inline-block" : "none"; });
    }
    window.setFav = (c) => { fav = c; render(); };
    window.switchConv = () => { const [a, b] = document.querySelectorAll(".chat-item-box"); a.classList.remove("active"); b.classList.add("active"); };
  </script></body>`;

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
const watchdog = setTimeout(() => {
  console.log(JSON.stringify({ ok: false, error: "timeout", results }));
  app.exit(2);
}, 180_000);

async function adapterFor(win, html, probe = true) {
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const wc = win.webContents;
  if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
  const pg = { webContents: wc, isDestroyed: () => win.isDestroyed() || wc.isDestroyed(), loadURL: (u) => wc.loadURL(u), close: () => win.destroy(), on: () => undefined };
  const adapter = new PddPageAdapter("fixture", "虚构店铺", probe ? path.join(temp, "diag", "fixture", "requests.jsonl") : null, () => pg);
  fs.mkdirSync(path.join(temp, "diag", "fixture"), { recursive: true });
  adapter.window = pg;
  adapter.tracker = { status: () => ({ logged_in: true }), end() {} };
  const conv = probe ? await adapter.activeConversationToken() : "0123456789abcdef";
  return { wc, adapter, conv };
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.showInactive();
    const logFile = path.join(temp, "diag", "fixture", "star-test.jsonl");
    const zero = async (name, opts, expect, before) => {
      const { wc, adapter, conv } = await adapterFor(win, page(opts));
      if (before) await wc.executeJavaScript(before);
      const r = await adapter.starTest("red", conv);
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      check(name, r === expect && clicks.length === 0, { r, clicks });
    };
    {
      const { wc, adapter, conv } = await adapterFor(win, page());
      check("对话令牌：16 位摘要，不含可读身份", /^[0-9a-f]{16}$/.test(conv ?? "") && !String(conv).includes("9001"), conv);
      const r = await adapter.starTest("red", conv);
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
      check("未收藏：只点红色项并以页面状态确认", r === "confirmed" && JSON.stringify(clicks) === '["red"]', { r, clicks });
      check("点击前写尝试记录，结束写确认记录", log.length === 2 && log[0].phase === "attempt" && log[1].phase === "confirmed", log);
    }
    {
      const { wc, adapter, conv } = await adapterFor(win, page());
      await wc.executeJavaScript("setFav('red')");
      const r = await adapter.starTest("red", conv);
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      check("已是红色：不点击", r === "already" && clicks.length === 0, { r, clicks });
    }
    {
      const { wc, adapter, conv } = await adapterFor(win, page());
      await wc.executeJavaScript("setFav('blue')");
      const r = await adapter.starTest("red", conv);
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      check("已收藏为蓝色：改为红色，不点星标", r === "confirmed" && JSON.stringify(clicks) === '["red"]', { r, clicks });
    }
    {
      const { wc, adapter } = await adapterFor(win, page({ active: false }));
      const r = await adapter.starTest("red", "0123456789abcdef");
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      check("无已打开对话：不执行", r === "not_executed:conversation_mismatch" && clicks.length === 0, { r, clicks });
    }
    {
      const { wc, adapter, conv } = await adapterFor(win, page(), false);
      const r = await adapter.starTest("red", conv);
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      check("非诊断模式：不执行", r === "not_executed:probe_mode_required" && clicks.length === 0, { r, clicks });
    }
    await zero("只有无关红/蓝菜单、星标浮层未打开：不点", { unrelated: true, noStarPop: true }, "not_executed:popover_missing");
    await zero("两个颜色浮层候选：报歧义不点", { twin: true }, "not_executed:popover_not_unique");
    await zero("颜色项被遮挡：点击前核对不通过不点", { cover: true }, "not_executed:target_not_in_star_popover");
    await zero("取令牌后切换对话：不点", {}, "not_executed:conversation_mismatch", "switchConv()");
    await zero("悬停后、点击前切换对话：不点", { switchOnHover: true }, "not_executed:conversation_mismatch");
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
