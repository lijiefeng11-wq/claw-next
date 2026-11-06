/**
 * 诊断模式转移会话测试（transferTest）：真实 Electron 渲染进程 + 虚构 data: 页面（不联网、不连接平台或后台）。
 * 用法：npm run build 后 `npx --no-install electron scripts/test-transfer-test.cjs`（Linux CI 加 --no-sandbox）。
 *
 * 覆盖：inspect 只打开对话框和确认气泡、点取消并关闭，不点确认；execute 只点唯一匹配行的确认，点击前写尝试记录；
 * 目标不唯一/缺失时不点确认；无已打开对话、非诊断模式不执行；会话列表每行自带的“转移会话”按钮不点；
 * 已收藏会话被平台拒绝时，请求允许才点一次“取消收藏并转移”，默认点“暂不转移”并返回需确认；
 * 会话离开非空列表只记观察（业务 unknown），临时空列表不算；日志不含客服名；
 * 目标行在表格滚动区外时先滚动到可见、核对点击点确实落在该按钮上；
 * 反例：备注列含目标名、包含关系、同名、点行后重排、点行后弹出别的客服的气泡、按钮未关联气泡、
 * 别的气泡的同名按钮盖住目标确认按钮（另有页面别处同名按钮不遮挡的控制例）、
 * 取令牌/打开对话框/点行后切换对话、消费后打开对话框期间过期，均不确认。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-transfer-test-"));
app.setPath("userData", temp);
const { PddPageAdapter, LINK_PROBE } = require("../dist/src/main/pddAdapter.js");

const page = (active, agents, favorited = false) => `<!doctype html><meta charset="utf-8"><body style="font:14px sans-serif;margin:0">
  <div class="chat-list"><ul>
    <li class="chat-item"><div class="chat-item-box ${active ? "active" : ""}" data-random="9001-x">虚构买家</div><div class="transfer-chat-item-btn" onclick="clicks.push('list-btn')">转移会话</div></li>
    <li class="chat-item"><div class="chat-item-box" data-random="9002-x">虚构买家2</div><div class="transfer-chat-item-btn" onclick="clicks.push('list-btn')">转移会话</div></li>
  </ul></div>
  <ul class="msg-list"><li class="onemsg"><div class="buyer-item">虚构买家新消息</div></li></ul>
  <div style="position:absolute;left:400px;top:20px"><span id="open" style="padding:4px">转移会话</span></div>
  <div id="wrap" class="el-dialog__wrapper" style="display:none;position:fixed;inset:0;background:#9995"><div id="dlg" class="el-dialog" style="display:none;position:absolute;left:100px;top:80px;width:600px;background:#fff">
    <div><span class="el-dialog__title">转移会话</span><button class="el-dialog__headerbtn" id="x" style="width:20px;height:20px">x</button></div>
    <div id="scroll" style="max-height:120px;overflow:auto"><table><tbody id="rows"></tbody></table></div>
  </div>
  </div>
  <div id="el-popover-none" class="el-popover" style="display:none;position:absolute;width:200px;height:110px;background:#fff"><ul><li onclick="clicks.push('reason')">催发货</li><li id="ok">无原因直接转移</li></ul><span id="send" onclick="clicks.push('send')" style="padding:2px">发送</span><span id="cancel" style="padding:2px">取消</span></div>
  <div id="fail" style="display:none;position:absolute;left:150px;top:150px;width:500px;background:#fff">
    <div><span>转移失败</span></div>
    <div><p>转移会话失败，已收藏的会话不可转移</p><p>点击【取消收藏并转移】可完成转移</p></div>
    <div><span id="unfav" style="padding:4px">取消收藏并转移</span><span id="keep" onclick="clicks.push('keep'); document.getElementById('fail').style.display = 'none'" style="padding:4px">暂不转移收藏会话</span></div>
  </div>
  <script>
    window.clicks = [];
    let pending = null;
    const agents = ${JSON.stringify(agents)};
    const rows = document.getElementById("rows");
    agents.forEach((agent, i) => {
      const [name, note] = Array.isArray(agent) ? agent : [agent, "在线"];
      const tr = document.createElement("tr");
      tr.className = "el-table__row";
      tr.innerHTML = "<td>" + name + "</td><td>" + note + "</td><td><div class='cell'><span aria-describedby='el-popover-r" + i + "'><div style='width:40px;height:20px'>转移</div></span></div></td>";
      tr.querySelector("td:last-child div div").addEventListener("click", (e) => {
        clicks.push("row:" + name); pending = name;
        let owner = i;
        if (window.hijackOnRow) { owner = (i + 1) % agents.length; pending = Array.isArray(agents[owner]) ? agents[owner][0] : agents[owner]; }
        if (window.switchOnRow) switchConv();
        if (window.reorderOnRow) [...rows.children].reverse().forEach((r) => rows.appendChild(r));
        const r = e.target.getBoundingClientRect(), p = document.querySelector(".el-popover");
        p.id = "el-popover-r" + owner;
        p.style.left = (r.left - 60) + "px"; p.style.top = (r.bottom + 4) + "px"; p.style.display = "block";
        if (window.overlayOnRow || window.decoyOnRow) {
          const ok = document.getElementById("ok").getBoundingClientRect(), d = document.createElement("div");
          d.className = "el-popover"; d.id = "el-popover-other";
          d.style.cssText = "position:absolute;z-index:99;background:#fff;width:" + ok.width + "px;height:" + ok.height + "px;left:" + (window.overlayOnRow ? ok.left : 700) + "px;top:" + (window.overlayOnRow ? ok.top : 500) + "px";
          d.innerHTML = "<span>无原因直接转移</span>";
          d.addEventListener("click", () => clicks.push("ok-B"));
          document.body.appendChild(d);
        }
      });
      rows.appendChild(tr);
    });
    window.switchConv = () => { const [a, b] = document.querySelectorAll(".chat-item-box"); a.classList.remove("active"); b.classList.add("active"); };
    document.getElementById("open").addEventListener("click", () => {
      clicks.push("open");
      if (window.blockOnOpen) { const end = Date.now() + window.blockOnOpen; while (Date.now() < end) {} }
      if (!window.noDialogOnOpen) { document.getElementById("dlg").style.display = "block"; document.getElementById("wrap").style.display = "block"; }
      if (window.switchOnOpen) switchConv();
    });
    document.getElementById("x").addEventListener("click", () => { clicks.push("close"); if (window.stickyDialog) return; document.getElementById("dlg").style.display = "none"; document.getElementById("wrap").style.display = "none"; document.querySelector(".el-popover").style.display = "none"; });
    if (window.noCancel === undefined) window.noCancel = false;
    // 仿真空白遮罩关闭弹窗；Esc 会结束当前会话，所以自动流程必须零 Esc。
    document.getElementById("wrap").addEventListener("click", (e) => { if(e.target !== e.currentTarget) return; clicks.push("blank"); document.getElementById("dlg").style.display = "none"; document.getElementById("wrap").style.display = "none"; document.querySelector(".el-popover").style.display = "none"; });
    document.addEventListener("click", (e) => {
      const p = document.querySelector(".el-popover");
      if (p.style.display !== "block" || p.contains(e.target) || e.target.closest("tr.el-table__row span[aria-describedby]")) return;
      clicks.push("outside"); p.style.display = "none";
    });
    document.addEventListener("keydown", (e) => { if (e.key !== "Escape") return; clicks.push("esc"); document.querySelector(".chat-item-box.active")?.closest("li").remove(); });
    document.getElementById("cancel").addEventListener("click", () => { clicks.push("cancel"); document.querySelector(".el-popover").style.display = "none"; });
    const leave = () => document.querySelector('[data-random="9001-x"]').closest("li").remove();
    document.getElementById("ok").addEventListener("click", () => {
      clicks.push("ok:" + pending);
      document.querySelector(".el-popover").style.display = "none"; document.getElementById("dlg").style.display = "none"; document.getElementById("wrap").style.display = "none";
      if (${JSON.stringify(favorited)}) document.getElementById("fail").style.display = "block";
      else if (window.emptyOnOk) document.querySelectorAll(".chat-list li").forEach((li) => li.remove());
      else leave();
    });
    document.getElementById("unfav").addEventListener("click", () => { clicks.push("unfav"); document.getElementById("fail").style.display = "none"; leave(); });
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

const logFile = path.join(temp, "diag", "fixture", "transfer-test.jsonl");
const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.showInactive();
    const T = "虚构主账号";
    const run = async (html, { confirm = true, allow = false, before, conv: override, probe = true, ttl = 60_000 } = {}) => {
      fs.rmSync(logFile, { force: true });
      const { wc, adapter, conv } = await adapterFor(win, html, probe);
      if (before) await wc.executeJavaScript(before);
      const r = await adapter.transferTest(T, confirm, override ?? conv, Date.now() + ttl, allow);
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      if (clicks.includes("esc")) throw new Error("automatic Escape ended fixture conversation");
      return { r, clicks, log: readLog(), fresh: adapter.pendingFreshBuyer };
    };
    const noOk = (clicks) => !clicks.some((c) => c.startsWith("ok") || c === "unfav");
    const noCancel = "document.getElementById('cancel').remove()";
    const cleanup = (log) => log.find((l) => l.phase === "cleanup") ?? {};
    {
      const { r, clicks, log } = await run(page(true, ["虚构客服A", T]), { confirm: false, before: noCancel });
      const c = cleanup(log);
      check("inspect（气泡里没有“取消”，同真实平台）：点击空白遮罩收起气泡和弹窗，不结束会话", r.startsWith("inspected:rows=2,confirm_buttons=1") && JSON.stringify(clicks) === `["open","row:${T}","blank"]` && noOk(clicks) && !clicks.includes("send") && !clicks.includes("reason"), { r, clicks });
      check("inspect（无“取消”）：收尾记录每步与最终残留为零；气泡项只记类别计数", c.leftover?.dialogs === 0 && c.leftover?.popovers === 0 && c.steps?.map((x) => x.step).join() === "blank_click" && log.some((l) => l.phase === "popover" && l.kinds?.cancel === 0 && l.kinds?.direct === 1 && l.kinds?.send === 1 && l.kinds?.other === 1) && !JSON.stringify(log).includes("催发货"), log);
    }
    {
      // 同一页面、同一对话：先 inspect 再真实转移（即用户实际的操作顺序），inspect 收干净后转移不再因残留拒绝。
      fs.rmSync(logFile, { force: true });
      const { wc, adapter, conv } = await adapterFor(win, page(true, ["虚构客服A", T]));
      await wc.executeJavaScript(noCancel);
      const first = await adapter.transferTest(T, false, conv, Date.now() + 60_000);
      const second = await adapter.transferTest(T, true, conv, Date.now() + 60_000);
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      check("先 inspect 后真实转移（同一页面）：不因残留拒绝，只确认目标一次", first.startsWith("inspected:") && second === "unknown:left_list_observed" && JSON.stringify(clicks) === `["open","row:${T}","blank","open","row:${T}","ok:${T}"]`, { first, second, clicks });
    }
    {
      const { r, clicks, log } = await run(page(true, ["虚构客服A", T]), { confirm: false, before: noCancel + "; document.getElementById('x').remove()" });
      const c = cleanup(log);
      check("没有关闭按钮时：只点一次空白收尾，零 Esc、不结束当前会话", r.startsWith("inspected:") && JSON.stringify(clicks) === `["open","row:${T}","blank"]` && c.steps?.at(-1)?.step === "blank_click" && c.leftover?.dialogs === 0 && c.leftover?.popovers === 0, { r, clicks, c });
    }
    {
      const { r, clicks, log } = await run(page(true, ["虚构客服A", T]), { confirm: false });
      check("inspect：打开、点行、取消、关闭，不点确认", r.startsWith("inspected:rows=2,confirm_buttons=1") && JSON.stringify(clicks) === `["open","row:${T}","cancel","blank"]`, { r, clicks });
      check("inspect：不写尝试记录；日志不含客服名", !log.some((l) => l.phase === "attempt") && !JSON.stringify(log).includes("虚构客服A"), log);
    }
    {
      const { r, clicks, log, fresh } = await run(page(true, ["虚构客服A", T]));
      check("execute：只确认名称列精确匹配的行；离开列表只记观察，业务 unknown", r === "unknown:left_list_observed" && JSON.stringify(clicks) === `["open","row:${T}","ok:${T}"]`, { r, clicks });
      check("执行期间的扫描不吞掉新买家消息标记", fresh === true, fresh);
      const ai = log.findIndex((l) => l.phase === "attempt");
      check("execute：确认前写尝试记录，日志不含客服名", ai >= 0 && log[ai + 1]?.observed === "left_list" && !JSON.stringify(log).includes(T), log);
    }
    {
      const { r, clicks, log } = await run(page(true, ["虚构客服A", T]), { ttl: 600 });
      check("消费时未过期、打开对话框期间过期：不点确认", r === "not_executed:expired" && noOk(clicks) && !log.some((l) => l.phase === "attempt"), { r, clicks });
    }
    {
      const { r, clicks, log } = await run(page(true, [T], true), { allow: true });
      check("已收藏且请求允许取消收藏：点一次“取消收藏并转移”", r === "unknown:left_list_observed,unfavorited" && JSON.stringify(clicks) === `["open","row:${T}","ok:${T}","unfav"]`, { r, clicks });
      check("已收藏：记录取消收藏步骤", log.some((l) => l.phase === "unfavorite_and_transfer"), log);
    }
    {
      const { r, clicks } = await run(page(true, [T], true));
      check("已收藏、默认不允许：不取消收藏，点“暂不转移”，返回需确认", r === "needs_confirmation:unfavorite" && JSON.stringify(clicks) === `["open","row:${T}","ok:${T}","keep"]`, { r, clicks });
    }
    {
      const { r, clicks } = await run(page(true, [T]), { before: "window.emptyOnOk = true" });
      check("确认后列表临时为空：不算观察到离开", r === "unknown:not_observed", { r, clicks });
    }
    {
      const { r, clicks } = await run(page(true, [["虚构客服乙", "备注：" + T + "咨询转交"]]));
      check("备注列含目标名：不算命中", r === "not_executed:target_missing" && JSON.stringify(clicks) === '["open","blank"]', { r, clicks });
    }
    {
      const { r, clicks } = await run(page(true, [T + "2", "副" + T]));
      check("名称只是包含关系：不算命中", r === "not_executed:target_missing" && noOk(clicks), { r, clicks });
    }
    {
      const { r, clicks } = await run(page(true, [T, T]));
      check("同名两行：不点行、不确认", r.startsWith("not_executed:target_not_unique") && JSON.stringify(clicks) === '["open","blank"]', { r, clicks });
    }
    {
      const { r, clicks } = await run(page(true, ["虚构客服A", T]), { before: "window.reorderOnRow = true" });
      check("点行后表格重排：不确认", r === "not_executed:target_moved" && noOk(clicks), { r, clicks });
    }
    {
      const fillers = Array.from({ length: 12 }, (_, i) => "虚构客服" + i);
      const { r, clicks } = await run(page(true, [...fillers, T]));
      check("目标行在表格滚动区外：先滚动到可见再点，仍只确认目标", r === "unknown:left_list_observed" && JSON.stringify(clicks) === `["open","row:${T}","ok:${T}"]`, { r, clicks });
    }
    {
      const { r, clicks } = await run(page(true, ["虚构客服A", T]), { before: "window.hijackOnRow = true" });
      check("点行后弹出的是别的客服的气泡：不确认", r === "not_executed:popover_missing" && noOk(clicks), { r, clicks });
    }
    {
      const { r, clicks } = await run(page(true, ["虚构客服A", T]), { before: "document.querySelectorAll('[aria-describedby]').forEach((e) => e.removeAttribute('aria-describedby'))" });
      check("目标按钮未关联气泡：证明不了归属不确认", r === "not_executed:popover_unlinked" && noOk(clicks), { r, clicks });
    }
    {
      const { r, clicks } = await run(page(true, ["虚构客服A", T]), { before: "window.overlayOnRow = true" });
      check("目标气泡还在、别的气泡的同名按钮盖在确认按钮上：不确认", r === "not_executed:confirm_covered" && noOk(clicks), { r, clicks });
    }
    {
      const { r, clicks } = await run(page(true, ["虚构客服A", T]), { before: "window.decoyOnRow = true" });
      check("页面别处另有同名按钮但没有遮挡：照常只确认目标", r === "unknown:left_list_observed" && JSON.stringify(clicks) === `["open","row:${T}","ok:${T}"]`, { r, clicks });
    }
    {
      const { wc } = await adapterFor(win, page(true, ["虚构客服A", T]));
      await wc.executeJavaScript("document.getElementById('dlg').style.display = 'block'; document.getElementById('wrap').style.display = 'block'; document.querySelectorAll('[aria-describedby]')[0].removeAttribute('aria-describedby')");
      const l = await wc.executeJavaScript(LINK_PROBE);
      check("诊断关联记录：对话框行数与按钮关联计数，不含客服名", l.transfer_dialog === true && l.transfer_rows === 2 && l.rows_with_button === 2 && l.rows_with_aria === 1 && !JSON.stringify(l).includes(T), l);
    }
    {
      const { r, clicks } = await run(page(false, [T]), { conv: "0123456789abcdef" });
      check("无已打开对话：不执行", r === "not_executed:conversation_mismatch" && clicks.length === 0, { r, clicks });
    }
    {
      const { r, clicks } = await run(page(true, [T]), { before: "switchConv()" });
      check("取令牌后切换对话：零点击", r === "not_executed:conversation_mismatch" && clicks.length === 0, { r, clicks });
    }
    {
      const { r, clicks } = await run(page(true, [T]), { before: "window.switchOnOpen = true" });
      check("打开对话框后切换对话：不点行、不确认", r === "not_executed:conversation_mismatch" && JSON.stringify(clicks) === '["open"]', { r, clicks });
    }
    {
      const { r, clicks } = await run(page(true, [T]), { before: "window.switchOnRow = true" });
      check("点行后、确认前切换对话：不确认", r === "not_executed:conversation_mismatch" && noOk(clicks), { r, clicks });
    }
    {
      const { r, clicks } = await run(page(true, [T]), { probe: false });
      check("非诊断模式：不执行", r === "not_executed:probe_mode_required" && clicks.length === 0, { r, clicks });
    }
    {
      const { r, clicks, log } = await run(page(true, ["虚构客服A", T]), { before: "window.blockOnOpen = 1500" });
      check("打开对话框点击回执不确定但对话框已打开：不补点、按页面观察继续，仍只确认目标", r === "unknown:left_list_observed" && JSON.stringify(clicks) === `["open","row:${T}","ok:${T}"]`, { r, clicks });
      check("打开对话框点击回执不确定：写 open_click/unknown 记录，日志不含客服名", log.some((l) => l.phase === "open_click" && l.result === "unknown" && typeof l.reason === "string") && !JSON.stringify(log).includes("虚构客服A") && !JSON.stringify(log).includes(T), log);
    }
    {
      const { r, clicks } = await run(page(true, ["虚构客服A", T]), { before: "window.blockOnOpen = 1500; window.noDialogOnOpen = true" });
      check("打开对话框回执不确定且对话框没出现：不重点、按页面观察返回未执行", r.startsWith("not_executed:") && clicks.filter((c) => c === "open").length === 1 && !clicks.some((c) => c.startsWith("row:") || c.startsWith("ok:")), { r, clicks });
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
