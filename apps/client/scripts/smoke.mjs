// 端到端冒烟：临时后台（虚构配置）+ Electron 客户端（模拟平台）。不连接任何真实店铺。
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = process.env.CLAW_NEXT_BACKEND_ROOT ? path.resolve(process.env.CLAW_NEXT_BACKEND_ROOT) : path.resolve(clientRoot, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-next-smoke-"));
const screenshot = process.env.CLAW_NEXT_SCREENSHOT ?? path.join(tmp, "client.png");

function python() {
  for (const cmd of [process.env.CLAW_NEXT_PYTHON, "python3.13", "python3.12", "python3.11", "python3", "python"].filter(Boolean)) {
    const r = spawnSync(cmd, ["-c", "import sys; print(sys.version_info >= (3, 11))"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "True") return cmd;
  }
  throw new Error("需要 Python 3.11+");
}

const token = randomBytes(24).toString("hex");
fs.writeFileSync(
  path.join(tmp, "config.json"),
  JSON.stringify({ shops: [{ shop_id: "demo-shop", name: "演示店铺" }], clients: [{ client_id: "demo-client", shop_id: "demo-shop", token }] }),
);
const backend = spawn(python(), [path.join(clientRoot, "test", "backend_harness.py"), repoRoot, path.join(tmp, "config.json"), path.join(tmp, "data")]);
const port = await new Promise((resolve, reject) => {
  let buf = "";
  backend.stdout.on("data", (d) => {
    buf += d;
    const m = /PORT (\d+)/.exec(buf);
    if (m) resolve(Number(m[1]));
  });
  backend.on("exit", (c) => reject(new Error("backend exited " + c)));
});
const url = `http://127.0.0.1:${port}`;
// 临时数据目录中的首次默认管理员：先用改密接口换成本次冒烟专用的随机虚构密码，再重新登录，仅用于配置规则。
const adminLogin = async (password) => {
  const r = await fetch(url + "/api/v1/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password }) });
  if (!r.ok) throw new Error(`admin login ${r.status}`);
  return (await r.json()).session_token;
};
const adminPassword = `smoke-${randomBytes(12).toString("hex")}`;
const changed = await fetch(url + "/api/v1/admin/password", {
  method: "POST",
  headers: { Authorization: `Bearer ${await adminLogin("admin")}`, "Content-Type": "application/json" },
  body: JSON.stringify({ current_password: "admin", new_password: adminPassword, confirm_password: adminPassword }),
});
if (!changed.ok) throw new Error(`admin password change ${changed.status}`);
const adminSession = await adminLogin(adminPassword);
const adminCall = async (method, p, body) => {
  const r = await fetch(url + p, { method, headers: { Authorization: `Bearer ${adminSession}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  return r.json();
};
await adminCall("PUT", "/api/v1/admin/shops/demo-shop/settings", {
  enabled: true,
  mode: "rules",
  system_prompt: "演示",
  rules: [{ id: "hours", contains: "营业时间", reply: "演示：营业时间请咨询人工客服。" }],
});

// CLAW_NEXT_SMOKE_APP：指向打包后的可执行文件时，用同一套冒烟验证打包产物（不经 npm 的 electron）。
const packagedApp = process.env.CLAW_NEXT_SMOKE_APP ? path.resolve(process.env.CLAW_NEXT_SMOKE_APP) : null;
const electron = packagedApp ?? path.join(clientRoot, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const run = spawnSync(electron, packagedApp ? ["--smoke"] : [clientRoot, "--smoke"], {
  encoding: "utf8",
  shell: !packagedApp && process.platform === "win32",
  env: { ...process.env, CLAW_NEXT_USER_DATA: path.join(tmp, "user-data"), CLAW_NEXT_DEMO_BACKEND: url, CLAW_NEXT_DEMO_TOKEN: token, CLAW_NEXT_SCREENSHOT: screenshot },
  timeout: 60000,
});
const line = (run.stdout ?? "").split("\n").find((l) => l.startsWith("SMOKE_RESULT "));
const events = (await adminCall("GET", "/api/v1/admin/events?shop_id=demo-shop&limit=50")).events;
backend.stdin.end();

const checks = [];
const check = (name, ok) => checks.push({ name, ok: !!ok });
if (!line) {
  console.error(run.stdout, run.stderr);
  throw new Error("Electron 未输出 SMOKE_RESULT");
}
const result = JSON.parse(line.slice("SMOKE_RESULT ".length));
check("渲染页面无 require", result.renderer.require === "undefined");
check("渲染页面无 process", result.renderer.process === "undefined");
check("渲染页面只暴露 invoke/onState", JSON.stringify(result.renderer.bridge) === JSON.stringify(["invoke", "onState"]));
check("未列出的 IPC 通道被拒绝", result.bad_channel === "rejected");
check("非法参数被拒绝", result.bad_payload?.ok === false);
check("远程 HTTP 后台地址被拒绝", result.bad_url?.ok === false && result.bad_url.error === "backend_url_requires_https");
check("口令不出现在页面源码", result.token_in_dom === false);
check("客户端设置展开后，状态推送不会收起", result.settings_open_kept === true);
check("客户端设置收起后，状态推送不会展开", result.settings_closed_kept === false);
const statuses = result.demo?.[0]?.statuses ?? [];
check("规则命中的消息获平台（模拟）确认", statuses.includes("buyer-demo-001:已获平台确认"));
check("未命中规则建议交人工", statuses.includes("buyer-demo-002:建议交人工"));
// 图片未取到时：旧后台转人工；新后台（图片理解）回复请买家重发，原因 image_missing。
const image = events.find((e) => e.conversation_id === "buyer-demo-003");
const imageRetry = image?.decision?.reason === "image_missing";
check("取不到的图片：转人工或请买家重发", imageRetry ? statuses.includes("buyer-demo-003:已获平台确认") : statuses.includes("buyer-demo-003:建议交人工"));
const sent = events.find((e) => e.conversation_id === "buyer-demo-001");
check("后台记录发送回执 sent", sent?.delivery.status === "sent" && sent.delivery.platform_message_id);
check("后台其余事件无发送", events.filter((e) => e.conversation_id !== "buyer-demo-001" && !(imageRetry && e === image)).every((e) => e.delivery.status === "unclaimed"));
const logs = (run.stdout ?? "") + (run.stderr ?? "");
check("进程输出不含口令", !logs.includes(token));
check("截图已生成", fs.existsSync(screenshot));

const logDir = path.join(tmp, "user-data", "logs");
const logFiles = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => /^client-\d{4}-\d{2}-\d{2}\.log$/.test(f)) : [];
check("每日日志已落盘", logFiles.length === 1);
// SMOKE_RESULT 是本脚本自己的检测输出（含虚构会话号），不属于客户端运行日志。
const fileLog = logFiles.map((f) => fs.readFileSync(path.join(logDir, f), "utf8")).join("").split("\n").filter((l) => !l.includes("SMOKE_RESULT")).join("\n");
const ref = sent && createHash("sha256").update(JSON.stringify(["demo-shop", sent.event_id]), "utf8").digest("hex").slice(0, 24);
for (const step of ["submit", "decide", "claim", "platform_send", "receipt"]) {
  check(`日志含 ${step} 耗时且 event_ref 与后台事件对应`, ref && new RegExp(`timing event_ref=${ref} step=${step} ms=\\d+ ok=true`).test(fileLog));
}
check("日志不含口令", !fileLog.includes(token));
check("日志不含消息正文", !["营业时间是什么时候", "我想退款", "演示：营业时间"].some((t) => fileLog.includes(t)));
check("日志不含买家编号明文", !fileLog.includes("buyer-demo-"));
check("日志不含事件编号明文", events.every((e) => !fileLog.includes(e.event_id)));
console.log("客户端日志：" + logDir);

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
console.log("截图：" + screenshot);
if (checks.some((c) => !c.ok)) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}
