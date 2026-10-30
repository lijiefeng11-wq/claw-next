/**
 * 诊断模式转移会话测试（transferTest）：真实 Electron 渲染进程 + 虚构 data: 页面（不联网、不连接平台或后台）。
 * 用法：npm run build 后 `npx --no-install electron scripts/test-transfer-test.cjs`（Linux CI 加 --no-sandbox）。
 *
 * 覆盖：inspect 只打开对话框和确认气泡、点取消并关闭，不点确认；execute 只点唯一匹配行的确认，点击前写尝试记录；
 * 目标不唯一/缺失时不点确认；无已打开对话、非诊断模式不执行；会话列表每行自带的“转移会话”按钮不点。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-transfer-test-"));
app.setPath("userData", temp);
const { PddPageAdapter } = require("../dist/src/main/pddAdapter.js");

const page = (active, agents) => `<!doctype html><meta charset="utf-8"><body style="font:14px sans-serif;margin:0">
  <div class="chat-list"><ul>
    <li class="chat-item"><div class="chat-item-box ${active ? "active" : ""}" data-random="9001-x">虚构买家</div><div class="transfer-chat-item-btn" onclick="clicks.push('list-btn')">转移会话</div></li>
    <li class="chat-item"><div class="chat-item-box" data-random="9002-x">虚构买家2</div><div class="transfer-chat-item-btn" onclick="clicks.push('list-btn')">转移会话</div></li>
  </ul></div>
  <div style="position:absolute;left:400px;top:20px"><span id="open" style="padding:4px">转移会话</span></div>
  <div id="dlg" class="el-dialog" style="display:none;position:absolute;left:100px;top:80px;width:600px;background:#fff">
    <div><span class="el-dialog__title">转移会话</span><button class="el-dialog__headerbtn" id="x" style="width:20px;height:20px">x</button></div>
    <table><tbody id="rows"></tbody></table>
  </div>
  <div id="pop" class="el-popover" style="display:none;position:absolute;width:160px;height:40px;background:#fff"><button id="cancel">取消</button><button id="ok">确定</button></div>
  <script>
    window.clicks = [];
    let pending = null;
    const agents = ${JSON.stringify(agents)};
    const rows = document.getElementById("rows");
    agents.forEach((name, i) => {
      const tr = document.createElement("tr");
      tr.className = "el-table__row";
      tr.innerHTML = "<td>" + name + "</td><td>在线</td><td><div class='cell'><span><div style='width:40px;height:20px'>转移</div></span></div></td>";
      tr.querySelector("td:last-child div div").addEventListener("click", (e) => {
        clicks.push("row:" + name); pending = name;
        const r = e.target.getBoundingClientRect(), p = document.getElementById("pop");
        p.style.left = (r.left - 60) + "px"; p.style.top = (r.bottom + 4) + "px"; p.style.display = "block";
      });
      rows.appendChild(tr);
    });
    document.getElementById("open").addEventListener("click", () => { clicks.push("open"); document.getElementById("dlg").style.display = "block"; });
    document.getElementById("x").addEventListener("click", () => { clicks.push("close"); document.getElementById("dlg").style.display = "none"; document.getElementById("pop").style.display = "none"; });
    document.getElementById("cancel").addEventListener("click", () => { clicks.push("cancel"); document.getElementById("pop").style.display = "none"; });
    document.getElementById("ok").addEventListener("click", () => {
      clicks.push("ok:" + pending);
      document.getElementById("pop").style.display = "none"; document.getElementById("dlg").style.display = "none";
      const m = document.createElement("div"); m.className = "el-message"; m.textContent = "转移成功"; document.body.appendChild(m);
    });
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

const logFile = path.join(temp, "diag", "fixture", "transfer-test.jsonl");
const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.showInactive();
    {
      const { wc, adapter } = await adapterFor(win, page(true, ["虚构客服A", "虚构主账号"]));
      const r = await adapter.transferTest("主账号", false);
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      check("inspect：打开、点行、取消、关闭，不点确认", r.startsWith("inspected:rows=2,confirm_buttons=1") && JSON.stringify(clicks) === '["open","row:虚构主账号","cancel","close"]', { r, clicks });
      check("inspect：不写尝试记录", !readLog().some((l) => l.phase === "attempt"), readLog());
    }
    {
      fs.rmSync(logFile, { force: true });
      const { wc, adapter } = await adapterFor(win, page(true, ["虚构客服A", "虚构主账号"]));
      const r = await adapter.transferTest("主账号", true);
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      const log = readLog();
      check("execute：只确认唯一匹配行", r === "page_toast:转移成功" && JSON.stringify(clicks) === '["open","row:虚构主账号","ok:虚构主账号"]', { r, clicks });
      const ai = log.findIndex((l) => l.phase === "attempt");
      check("execute：确认前写尝试记录", ai >= 0 && log[ai + 1]?.phase === "page_toast", log);
    }
    {
      const { wc, adapter } = await adapterFor(win, page(true, ["虚构主账号1", "虚构主账号2"]));
      const r = await adapter.transferTest("主账号", true);
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      check("目标不唯一：不点行、不确认，关闭对话框", r.startsWith("not_executed:target_") && JSON.stringify(clicks) === '["open","close"]', { r, clicks });
    }
    {
      const { wc, adapter } = await adapterFor(win, page(true, ["虚构客服A"]));
      const r = await adapter.transferTest("主账号", true);
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      check("目标缺失：不确认", r === "not_executed:target_missing" && !clicks.some((c) => c.startsWith("ok")), { r, clicks });
    }
    {
      const { wc, adapter } = await adapterFor(win, page(false, ["虚构主账号"]));
      const r = await adapter.transferTest("主账号", true);
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      check("无已打开对话：不执行", r === "not_executed:no_active_conversation" && clicks.length === 0, { r, clicks });
    }
    {
      const { wc, adapter } = await adapterFor(win, page(true, ["虚构主账号"]), false);
      const r = await adapter.transferTest("主账号", true);
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
