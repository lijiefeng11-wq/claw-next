// 界面端到端测试（Playwright 驱动 Electron 客户端）：临时后台（虚构配置）+ 模拟平台。
// 不连接任何真实店铺，不打开拼多多页面，所有店铺、买家和消息均为虚构数据。
// 用法：npm run e2e（先构建）。截图写入 CLAW_NEXT_E2E_OUT（默认临时目录）。
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

const require = createRequire(import.meta.url);
const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = process.env.CLAW_NEXT_BACKEND_ROOT ? path.resolve(process.env.CLAW_NEXT_BACKEND_ROOT) : path.resolve(clientRoot, "..", "..");
// 临时后台配置、后台数据与客户端数据放在 tmp，结束时总是删除；截图单独放，结束后保留供查看。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-next-e2e-"));
const outDir = process.env.CLAW_NEXT_E2E_OUT ? path.resolve(process.env.CLAW_NEXT_E2E_OUT) : fs.mkdtempSync(path.join(os.tmpdir(), "claw-next-e2e-shots-"));
fs.mkdirSync(outDir, { recursive: true });

function python() {
  for (const cmd of [process.env.CLAW_NEXT_PYTHON, "python3.13", "python3.12", "python3.11", "python3", "python"].filter(Boolean)) {
    const r = spawnSync(cmd, ["-c", "import sys; print(sys.version_info >= (3, 11))"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "True") return cmd;
  }
  throw new Error("需要 Python 3.11+");
}

// ---------- 虚构后台 ----------
const SHOP = "demo-shop";
const token = randomBytes(24).toString("hex");
fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ shops: [{ shop_id: SHOP, name: "演示店铺" }], clients: [{ client_id: "demo-client", shop_id: SHOP, token }] }));
const backend = spawn(python(), [path.join(clientRoot, "test", "backend_harness.py"), repoRoot, path.join(tmp, "config.json"), path.join(tmp, "data")]);
backend.stderr.on("data", (d) => process.stderr.write(d));
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
// 临时数据目录中的首次默认管理员：先用改密接口换成本次测试专用的随机虚构密码，再重新登录，仅用于配置规则。
const adminLogin = async (password) => {
  const r = await fetch(url + "/api/v1/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password }) });
  if (!r.ok) throw new Error(`admin login ${r.status}`);
  return (await r.json()).session_token;
};
const adminPassword = `test-${randomBytes(12).toString("hex")}`;
const changed = await fetch(url + "/api/v1/admin/password", {
  method: "POST",
  headers: { Authorization: `Bearer ${await adminLogin("admin")}`, "Content-Type": "application/json" },
  body: JSON.stringify({ current_password: "admin", new_password: adminPassword, confirm_password: adminPassword }),
});
if (!changed.ok) throw new Error(`admin password change ${changed.status}`);
const adminSession = await adminLogin(adminPassword);
const admin = async (method, p, body) => (await fetch(url + p, { method, headers: { Authorization: `Bearer ${adminSession}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) })).json();
await admin("PUT", `/api/v1/admin/shops/${SHOP}/settings`, { enabled: true, mode: "rules", system_prompt: "演示", rules: [{ id: "hours", contains: "营业时间", reply: "演示：营业时间请咨询人工客服。" }] });

// ---------- 启动客户端 ----------
const checks = [];
let failed = null;
const check = (name, ok) => checks.push({ name, ok: !!ok });
const electronApp = await _electron.launch({
  executablePath: require("electron"),
  // Linux CI 上 node_modules 里的 chrome-sandbox 没有 setuid，测试时关闭沙箱；渲染页面的隔离设置不变。
  args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), clientRoot],
  env: { ...process.env, CLAW_NEXT_USER_DATA: path.join(tmp, "user-data"), CLAW_NEXT_E2E: "1", CLAW_NEXT_DEMO_TOKEN: token, CLAW_NEXT_DEMO_SHOP: SHOP },
  timeout: 60_000,
});
const shot = async (page, name) => page.screenshot({ path: path.join(outDir, `${name}.png`) }).catch(() => undefined);

try {
  // 主界面是 index.html；平台工作台视图（拼多多）在本测试中不会创建。
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    page = electronApp.windows().find((p) => p.url().endsWith("/renderer/index.html")) ?? null;
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  if (!page) throw new Error("未找到客户端主界面");
  page.setDefaultTimeout(15_000);
  const detail = page.locator("#detail");
  const card = (title) => detail.locator(".card", { has: page.locator("h3", { hasText: title }) }).locator(".value");
  const chipOf = (conv) => page.locator(".messages .msg.buyer .chip").last();
  const simSend = async (conv, text) => {
    await page.getByLabel("买家对话编号").fill(conv);
    await detail.locator("details.panel textarea").fill(text);
    await page.getByRole("button", { name: "模拟买家发送" }).click();
  };
  // 模拟器里的“平台发送结果”下拉框。
  const behavior = () => detail.locator("select", { has: page.locator('option[value="ack_without_id"]') });
  const step = async (name, fn) => {
    try {
      await fn();
      check(name, true);
    } catch (err) {
      check(name, false);
      failed ??= `${name}: ${err?.message?.split("\n")[0] ?? err}`;
      await shot(page, `fail-${checks.length}`);
    }
  };

  // 渲染页面隔离：不暴露 Node 能力，只有 invoke/onState 两个桥接方法。
  const iso = await page.evaluate(() => ({ require: typeof require, process: typeof process, bridge: Object.keys(window.clawNext || {}).sort() }));
  check("渲染页面无 require/process，只暴露 invoke/onState", iso.require === "undefined" && iso.process === "undefined" && JSON.stringify(iso.bridge) === '["invoke","onState"]');

  await step("没有店铺时显示“添加店铺”表单", async () => {
    await detail.getByRole("heading", { name: "添加店铺" }).waitFor();
  });
  await step("通过表单添加模拟店铺", async () => {
    const inputs = detail.locator(".form-grid input");
    await inputs.nth(0).fill(SHOP);
    await inputs.nth(1).fill("演示店铺");
    await inputs.nth(2).fill(url);
    await inputs.nth(3).fill("pdd-demo-shop");
    await detail.locator(".form-grid select").selectOption("mock");
    await detail.getByRole("button", { name: "保存" }).click();
    await detail.getByRole("heading", { name: "演示店铺" }).waitFor();
    await page.locator("#shop-list").getByText("演示店铺").waitFor();
  });
  await step("连接后台后显示“已连接”", async () => {
    await page.getByRole("button", { name: "连接后台" }).click();
    await card("后台连接").getByText("已连接").waitFor();
  });
  await step("模拟平台登录后：店铺身份已核验、持有发送归属", async () => {
    await page.getByRole("button", { name: "模拟平台登录" }).click();
    await card("店铺身份").getByText("已核验").waitFor();
    await card("发送归属").getByText(/已持有/).waitFor();
  });
  await step("新店默认“仅观察”：只显示建议回复，不发送", async () => {
    await page.locator(".segmented button.active", { hasText: "仅观察" }).waitFor();
    await simSend("buyer-e2e-001", "营业时间是什么时候？");
    await page.locator(".conv-item.active", { hasText: "buyer-e2e-001" }).waitFor();
    await chipOf().getByText("建议回复").waitFor();
    await page.locator(".messages").getByText("后台建议回复：演示：营业时间请咨询人工客服。").waitFor();
    await page.locator(".messages").getByText(/仅观察模式，不发送/).waitFor();
    if (await page.locator(".messages .chip", { hasText: "已获平台确认" }).count()) throw new Error("观察模式下出现了发送");
  });
  await shot(page, "1-observe");
  await step("切到“自动处理”后，新消息经平台确认发送", async () => {
    await page.getByRole("button", { name: "自动处理" }).click();
    await page.locator(".segmented button.active", { hasText: "自动处理" }).waitFor();
    await simSend("buyer-e2e-002", "营业时间？");
    await chipOf().getByText("已获平台确认").waitFor();
  });
  await step("规则没有命中时显示“建议交人工”，平台未执行转接", async () => {
    await simSend("buyer-e2e-003", "我想退款，怎么操作？");
    await chipOf().getByText("建议交人工").waitFor();
    await page.locator(".messages").getByText(/仅为建议，平台未执行转接/).waitFor();
  });
  await step("发送结果不确定：显示待核查、提示不会重发", async () => {
    await behavior().selectOption("ack_without_id");
    await simSend("buyer-e2e-004", "营业时间呢？");
    await chipOf().getByText(/待核查/).waitFor();
    await page.locator(".messages").getByText(/不会(自动)?重发/).waitFor();
    await detail.locator(".banner.error", { hasText: "结果待核查" }).waitFor();
    await page.locator(".conv-item", { hasText: "buyer-e2e-004 · 待核查" }).waitFor();
    await behavior().selectOption("confirm");
  });
  await shot(page, "2-unknown");
  await step("人工接管此对话：后续消息只给建议、不发送", async () => {
    await page.locator(".conv-item", { hasText: "buyer-e2e-002" }).click();
    await page.getByRole("button", { name: "人工接管此对话" }).click();
    await page.locator(".conv-item", { hasText: "buyer-e2e-002 · 人工接管" }).waitFor();
    await simSend("buyer-e2e-002", "营业时间再说一下");
    await page.locator(".messages").getByText(/此对话人工接管中/).waitFor();
    await page.getByRole("button", { name: "结束人工接管" }).click();
    await page.getByRole("button", { name: "人工接管此对话" }).waitFor();
  });
  await step("登录成其他店铺：提示疑似串店并停止；重新登录本店后恢复", async () => {
    await page.getByRole("button", { name: "登录成其他店铺（串店）" }).click();
    await detail.locator(".banner.error", { hasText: "疑似串店" }).waitFor();
    await card("店铺身份").getByText("与配置不符").waitFor();
    await shot(page, "3-wrong-shop");
    await page.getByRole("button", { name: "重新登录本店" }).click();
    await card("店铺身份").getByText("已核验").waitFor();
    await detail.locator(".banner.error", { hasText: "疑似串店" }).waitFor({ state: "detached" });
  });
  await step("客户端设置：开发运行时两个勾选项不可用，并说明仅打包版可用", async () => {
    await page.locator("#app-settings summary").click();
    const boxes = page.locator("#app-settings input[type=checkbox]");
    if ((await boxes.count()) !== 2) throw new Error("勾选项数量不对");
    for (let i = 0; i < 2; i++) if (!(await boxes.nth(i).isDisabled())) throw new Error("开发运行时勾选项应不可用");
    await page.locator("#app-settings").getByText(/仅打包后的 Mac \/ Windows/).waitFor();
    await page.locator("#app-settings summary").click();
  });
  await step("界面 HTML 中不含客户端口令", async () => {
    if ((await page.content()).includes(token)) throw new Error("口令出现在页面中");
  });
  await shot(page, "4-final");
} catch (err) {
  failed ??= err?.message ?? String(err);
} finally {
  await electronApp.close().catch(() => undefined);
  backend.stdin.end();
  await new Promise((r) => backend.once("exit", r));
}

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}`);
console.log(`截图：${outDir}`);
const bad = checks.filter((c) => !c.ok).length;
if (bad || failed) {
  console.error(`界面测试失败：${bad} 项${failed ? `；首个错误：${failed}` : ""}`);
  process.exitCode = 1;
} else {
  console.log(`界面测试通过：${checks.length}/${checks.length}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
