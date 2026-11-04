// Playwright 检查虚构页面的可点击性；Scrapling 离线对照当前生产选择器。
// 不连接运行中的客户端，不接受网址/用户目录参数，不把静态匹配当买家身份或发送回执。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src/main/pddAdapter.ts"), "utf8");
const selectors = Object.fromEntries(["ITEM", "TEXTAREA", "SEND_BTN"].map(name => {
  const value = source.match(new RegExp(`^const ${name} = ("[^"\\n]+");$`, "m"));
  assert.ok(value, `production selector ${name} changed; update the check explicitly`);
  return [name, JSON.parse(value[1])];
}));
const python = process.env.CLAW_NEXT_SELECTOR_PYTHON || process.env.CLAW_NEXT_PYTHON || "python3";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-selector-check-"));
const checks = [];
let electron;
const html = (extra = "", script = "") => `<!doctype html><meta charset="utf-8">
  <style>body{margin:0}.reply-box{margin:60px}.send-btn{display:inline-block;padding:16px;background:#69f}</style>
  <li class="chat-item"><div class="chat-item-box active" data-random="9001-fixture"></div></li>
  <div class="reply-box"><div class="reply-input"><textarea></textarea></div>
  <div class="reply-footer">${extra}<div class="send-btn" onclick="window.clicks++">发送</div></div></div>
  <script>window.clicks=0;${script}</script>`;
try {
  electron = await _electron.launch({ executablePath: require("electron"),
    args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), path.join(root, "scripts/selector-fixture.cjs")],
    env: { ...process.env, CLAW_NEXT_SELECTOR_DATA: temp }, timeout: 30_000 });
  const page = await electron.firstWindow();
  const load = async (body, buttons = 1) => {
    await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(body));
    const browserCounts = {};
    for (const [name, css] of Object.entries(selectors)) browserCounts[name] = await page.locator(css).count();
    assert.deepEqual(browserCounts, { ITEM: 1, TEXTAREA: 1, SEND_BTN: buttons });
    const parsed = spawnSync(python, [path.join(root, "scripts/verify-selectors.py")], {
      input: JSON.stringify({ html: await page.content(), selectors }), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    assert.equal(parsed.status, 0, `Scrapling dev environment required: ${parsed.stderr || parsed.error || "failed"}`);
    assert.deepEqual(JSON.parse(parsed.stdout).counts, browserCounts);
  };
  await load(html());
  await page.locator(selectors.SEND_BTN).click({ timeout: 1000 });
  assert.equal(await page.evaluate(() => window.clicks), 1);
  checks.push("normal: exact selectors agree; one click");
  await load(html('<div class="send-btn" style="display:none">隐藏副本</div>'), 2);
  await page.locator(selectors.SEND_BTN + ":visible").click({ timeout: 1000 });
  assert.equal(await page.evaluate(() => window.clicks), 1);
  checks.push("hidden duplicate: structural match is not visibility");
  await load(html("", 'document.querySelector(".send-btn").style.visibility="hidden";setTimeout(()=>document.querySelector(".send-btn").style.visibility="visible",350)'));
  await page.locator(selectors.SEND_BTN).click({ timeout: 2000 });
  assert.equal(await page.evaluate(() => window.clicks), 1);
  checks.push("delayed button: waits for readiness then one click");
  await load(html("", 'document.body.insertAdjacentHTML("beforeend",\'<div style="position:fixed;inset:0;z-index:99;background:white"></div>\')'));
  await assert.rejects(page.locator(selectors.SEND_BTN).click({ timeout: 300 }), error => error.name === "TimeoutError");
  assert.equal(await page.evaluate(() => window.clicks), 0);
  checks.push("covered button: no click despite exact static match");
  const { popupSweepScript } = require(path.join(root, "dist/src/main/pddPopups.js"));
  await load(html() + '<div class="guide-mask" style="position:fixed;left:400px;top:100px;z-index:1000;background:white;padding:20px"><p>虚构功能引导</p><button onclick="this.parentElement.remove()">我知道了</button></div>');
  const swept = await page.evaluate(popupSweepScript("auto", Date.now() + 5000));
  assert.equal(swept.dismissed.length, 1);
  assert.equal(await page.getByRole("button", { name: "我知道了" }).count(), 0);
  checks.push("actual popup script: harmless fictional guide closes");
  console.log(JSON.stringify({ ok: true, playwright: true, scrapling: true, fictional_only: true, production_driver_replaced: false, checks }));
} finally {
  try { if (electron) await electron.close(); }
  finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
