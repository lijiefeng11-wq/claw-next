import { ClientWindow } from "./clientWindow.js";
import { PlatformWorkspace } from "./platformWorkspace.js";
import { IpcMainInvokeEvent, Notification, app, dialog, ipcMain, screen, session, shell } from "electron";
import { shopAlert, type ShopAlert } from "../core/pageHealth.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { PlatformAdapter } from "../core/adapter.js";
import { ConfigStore } from "../core/configStore.js";
import { SessionStore, restorePlan, runRestore } from "../core/sessionStore.js";
import { IPC_CHANNELS, IpcPayload, IpcValidationError, validateIpc, validateToken } from "../core/ipc.js";
import { MockPlatformAdapter, MockSendBehavior } from "../core/mockAdapter.js";
import { ShopConfig, ShopRuntime, errorCode } from "../core/runtime.js";
import { APP_WEB_PREFERENCES } from "../core/security.js";
import { bindShopIdentity } from "../core/shopIdentity.js";
import { shopView } from "../core/view.js";
import { installFileLogging } from "./logger.js";
import { PddPageAdapter } from "./pddAdapter.js";
import { SecretStore } from "./secrets.js";
import { ARG_LAUNCHED_BY_AGENT, ARG_NO_HANDOVER, ARG_SUPERVISED, startupDecision, userDataFromArgv } from "../core/startup.js";
import { StartupManager } from "./startupManager.js";

const APP_NAME = "Claw-Next-Client";
app.setName(APP_NAME);
// 数据目录：自动启动传的 --user-data 优先（登录时没有原来的环境变量），其次 CLAW_NEXT_USER_DATA，最后系统应用数据目录。
const userDataOverride = userDataFromArgv(process.argv) ?? process.env.CLAW_NEXT_USER_DATA ?? null;
const userData = userDataOverride ? path.resolve(userDataOverride) : path.join(app.getPath("appData"), APP_NAME);
app.setPath("userData", userData);
app.enableSandbox();
installFileLogging(userData);
app.on("render-process-gone", (_e, contents, details) => console.error(`render-process-gone reason=${details.reason} exit=${details.exitCode} url=${contents.getURL().split(/[?#]/)[0]}`));
app.on("child-process-gone", (_e, details) => console.error(`child-process-gone type=${details.type} reason=${details.reason} exit=${details.exitCode}`));

const SMOKE = process.argv.includes("--smoke");
const INDEX = path.join(__dirname, "..", "renderer", "index.html");
const INDEX_URL = pathToFileURL(INDEX).href;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 同一数据目录只允许一个客户端进程，避免两个实例共用日志与发送状态。
  app.quit();
}
/** 开机自启与崩溃重启（打包版）。本进程是否由系统托管或守护程序启动，看启动参数。 */
const startup = new StartupManager(userData, userDataOverride ? userData : null, process.argv.includes(ARG_LAUNCHED_BY_AGENT) || process.argv.includes(ARG_SUPERVISED));

let mainWindow: ClientWindow | null = null;
let platformWorkspace: PlatformWorkspace | null = null;

/** stopping：旧运行实例尚未停稳（可能仍在平台发送）；停稳前不得建新实例或新平台窗口。 */
type ShopSlot = { runtime: ShopRuntime | null; adapter: PlatformAdapter | null; stopping: Promise<void> | null; instanceId: string; error: string | null; ephemeralToken: string | null };

class Controller {
  readonly configs = new ConfigStore(path.join(userData, "config"));
  readonly secrets = new SecretStore(path.join(userData, "secrets"));
  /** 上次打开着的店铺（用户手动连接/打开平台页时记录），启动时恢复。 */
  readonly sessions = new SessionStore(path.join(userData, "config"));
  /** 恢复进行中被用户手动操作过的店铺：其待恢复步骤作废。 */
  private readonly restoreTouched = new Set<string>();
  private readonly slots = new Map<string, ShopSlot>();

  slotsForDev(): [string, ShopSlot][] {
    return [...this.slots.entries()];
  }
  private pushTimer: NodeJS.Timeout | null = null;

  private slot(shopId: string): ShopSlot {
    let s = this.slots.get(shopId);
    if (!s) {
      // 本进程内每店固定一个 instance_id；进程重启必然换新。
      s = { runtime: null, adapter: null, stopping: null, instanceId: `inst-${randomUUID()}`, error: null, ephemeralToken: null };
      this.slots.set(shopId, s);
    }
    return s;
  }

  state() {
    return {
      app: { name: APP_NAME, secure_storage: this.secrets.available(), smoke: SMOKE, startup: startup.view() },
      shops: this.configs.list().map((c) => {
        const s = this.slots.get(c.shop_id);
        return {
          config: c,
          token_set: this.secrets.has(c.shop_id) || !!s?.ephemeralToken,
          running: !!s?.runtime,
          error: s?.error ?? null,
          platform: s?.adapter?.status() ?? null,
          alert: this.alertFor(c),
          view: s?.runtime ? shopView(s.runtime) : null,
        };
      }),
    };
  }

  /** 店铺提醒（侧栏标红与系统通知）；只看平台页面与登录状态，不含买家内容。 */
  private alertFor(config: ShopConfig): ShopAlert | null {
    const st = this.slots.get(config.shop_id)?.adapter?.status();
    if (!st) return null;
    return shopAlert({ adapter: config.adapter, pageOpen: !!st.page, logged_in: st.logged_in, page: st.page ?? null });
  }

  private readonly alerted = new Map<string, string>();

  /** 店铺进入新的提醒状态时发一次系统通知；恢复后再次出现才会再提醒。 */
  private notifyAlert(config: ShopConfig) {
    const alert = this.alertFor(config);
    const key = alert?.text ?? "";
    if ((this.alerted.get(config.shop_id) ?? "") === key) return;
    this.alerted.set(config.shop_id, key);
    if (!alert || SMOKE || !Notification.isSupported()) return;
    console.log(`[${config.shop_id}] alert ${alert.text}`);
    new Notification({ title: `${config.display_name}：${alert.text}`, body: "请到 Claw-Next 客户端查看并处理。", silent: false }).show();
  }

  push() {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("state:changed", this.state());
    }, 150);
  }

  private require(shopId: string): ShopConfig {
    const c = this.configs.get(shopId);
    if (!c) throw new IpcValidationError("shop_not_found");
    return c;
  }

  private running(shopId: string): ShopRuntime {
    this.require(shopId);
    const rt = this.slots.get(shopId)?.runtime;
    if (!rt) throw new IpcValidationError("shop_not_running");
    return rt;
  }

  private mock(shopId: string): MockPlatformAdapter {
    const a = this.slots.get(shopId)?.adapter;
    if (!(a instanceof MockPlatformAdapter)) throw new IpcValidationError("not_simulated_shop");
    return a;
  }

  private createAdapter(config: ShopConfig): PlatformAdapter {
    try {
      bindShopIdentity(this.shopDataDir(config.shop_id), config);
    } catch (err) {
      throw new IpcValidationError(errorCode(err) === "internal_error" ? (err as Error).message : errorCode(err));
    }
    if (config.adapter === "mock") return new MockPlatformAdapter({ platformShopId: config.platform_shop_id, displayName: config.display_name });
    const probe = process.env.CLAW_NEXT_PDD_PROBE === "1" ? path.join(userData, "diag", config.shop_id, "requests.jsonl") : null;
    const adapter = new PddPageAdapter(config.shop_id, config.display_name, probe, () => {
      if (!platformWorkspace) throw new Error("platform_workspace_unavailable");
      return platformWorkspace.create(config.shop_id);
    });
    let last = "";
    adapter.onEvent((e) => {
      if (e.type === "message") {
        console.log(`[${config.shop_id}] platform message role=${e.message.role} kind=${e.message.kind} live=${e.live}`);
      } else {
        const st = adapter.status();
        const line = `logged_in=${st.logged_in} identity=${st.identity ? (st.identity.platform_shop_id === config.platform_shop_id ? "match" : `mismatch(platform=${st.identity.platform_shop_id})`) : "none"}`;
        if (line !== last) console.log(`[${config.shop_id}] platform ${(last = line)}`);
        this.notifyAlert(config);
      }
      this.push();
    });
    return adapter;
  }

  /** 平台登录与后台连接相互独立：拼多多店铺未连后台时也可打开登录窗口。 */
  private shopDataDir(shopId: string) {
    return path.join(userData, "data", "shops", shopId);
  }

  async platformLogin(shopId: string) {
    const config = this.require(shopId);
    const s = this.slot(shopId);
    if (s.stopping) await s.stopping;
    if (s.runtime) return s.runtime.adapter.login();
    if (config.adapter !== "pdd") throw new IpcValidationError("shop_not_running");
    s.adapter ??= this.createAdapter(config);
    await s.adapter.login();
  }

  /** 仅 --smoke 演示使用：口令只在内存中，不落盘。 */
  setEphemeralToken(shopId: string, token: string) {
    this.slot(shopId).ephemeralToken = token;
  }

  async connect(shopId: string) {
    const config = this.require(shopId);
    const s = this.slot(shopId);
    if (s.stopping) await s.stopping;
    if (s.runtime) return;
    const token = s.ephemeralToken ?? this.secrets.get(shopId);
    if (!token) throw new IpcValidationError("token_missing");
    const adapter = s.adapter ?? this.createAdapter(config);
    s.adapter = adapter;
    s.error = null;
    try {
      s.runtime = new ShopRuntime({
        config,
        token,
        adapter,
        dataDir: this.shopDataDir(shopId),
        instanceId: s.instanceId,
        onChange: () => this.push(),
        log: (line) => console.log(`[${shopId}] ${line}`),
      });
    } catch (err) {
      adapter.dispose();
      s.adapter = null;
      s.error = errorCode(err) === "internal_error" ? (err as Error).message : errorCode(err);
      throw new IpcValidationError(s.error);
    }
    await s.runtime.start();
  }

  async disconnect(shopId: string) {
    const s = this.slots.get(shopId);
    if (s && !s.runtime && s.adapter) {
      s.adapter.dispose();
      s.adapter = null;
    }
    if (!s?.runtime) return;
    const rt = s.runtime;
    s.runtime = null;
    s.adapter = null;
    const stopping = rt.stop().finally(() => {
      if (s.stopping === stopping) s.stopping = null;
      this.push();
    });
    s.stopping = stopping;
    // 界面最多等 3 秒；未停稳期间 stopping 继续占住该店，重连会等它结束。
    await Promise.race([stopping, new Promise((r) => setTimeout(r, 3000))]);
  }

  async stopAll() {
    // 退出程序不改“上次打开着的店铺”记录，下次启动按退出前的样子恢复。
    for (const id of this.slots.keys()) await this.disconnect(id);
  }

  /**
   * 启动时恢复上次打开着的店铺：先开平台页，再连后台；运行模式沿用店铺配置，不改。
   * 单店失败只记日志，不影响其他店铺，也不改记录（下次启动再试）。
   */
  async restoreSessions() {
    const plan = restorePlan(this.configs.list(), this.sessions, (id) => this.secrets.has(id));
    for (const k of plan.skipped) console.log(`[${k.shop_id}] restore skipped reason=${k.reason}`);
    await runRestore(plan.steps, {
      sessions: this.sessions,
      touched: (id) => this.restoreTouched.has(id),
      openPage: (id) => this.platformLogin(id),
      connect: (id) => this.connect(id),
      log: (line) => {
        console.log(line);
        this.push();
      },
    });
  }

  async handle(p: IpcPayload): Promise<unknown> {
    switch (p.channel) {
      case "state:get":
        return this.state();
      case "workspace:present": {
        if (p.shop_id !== null && this.require(p.shop_id).adapter !== "pdd") throw new IpcValidationError("not_platform_shop");
        const z = mainWindow?.webContents.getZoomFactor() ?? 1;
        const b = p.bounds;
        platformWorkspace?.present(p.shop_id, b ? { x: b.x * z, y: b.y * z, width: b.width * z, height: b.height * z } : null, p.zoom ?? 1);
        return undefined;
      }
      case "shop:save": {
        const existing = this.configs.get(p.shop.shop_id);
        if (existing && (this.slots.get(p.shop.shop_id)?.runtime || this.slots.get(p.shop.shop_id)?.stopping)) throw new IpcValidationError("disconnect_first");
        if (existing && (existing.adapter !== p.shop.adapter || existing.platform_shop_id !== p.shop.platform_shop_id)) throw new IpcValidationError("shop_identity_immutable");
        if (this.configs.list().some((c) => c.shop_id !== p.shop.shop_id && c.shop_id.toLowerCase() === p.shop.shop_id.toLowerCase())) throw new IpcValidationError("shop_id_case_conflict");
        this.configs.upsert({ ...p.shop, mode: existing?.mode ?? "observe" });
        return this.state();
      }
      case "shop:remove":
        this.require(p.shop_id);
        this.restoreTouched.add(p.shop_id);
        await this.disconnect(p.shop_id);
        this.configs.remove(p.shop_id);
        this.secrets.remove(p.shop_id);
        this.sessions.remove(p.shop_id);
        return this.state();
      case "shop:setToken":
        this.require(p.shop_id);
        this.secrets.set(p.shop_id, p.token);
        return this.state();
      case "shop:connect": {
        this.restoreTouched.add(p.shop_id);
        const g = this.sessions.begin(p.shop_id, ["connected"]);
        await this.connect(p.shop_id);
        this.sessions.commit(p.shop_id, g, { connected: true });
        return this.state();
      }
      case "shop:disconnect": {
        // 断开会停止运行并释放适配器，拼多多平台页随之关闭，所以两项一起清掉。
        this.restoreTouched.add(p.shop_id);
        const g = this.sessions.begin(p.shop_id, ["connected", "page_open"]);
        await this.disconnect(p.shop_id);
        this.sessions.commit(p.shop_id, g, { connected: false, page_open: false });
        return this.state();
      }
      case "shop:login": {
        this.restoreTouched.add(p.shop_id);
        const g = this.sessions.begin(p.shop_id, ["page_open"]);
        await this.platformLogin(p.shop_id);
        if (this.require(p.shop_id).adapter === "pdd") this.sessions.commit(p.shop_id, g, { page_open: true });
        return this.state();
      }
      case "shop:logout": {
        this.require(p.shop_id);
        this.restoreTouched.add(p.shop_id);
        const g = this.sessions.begin(p.shop_id, ["page_open"]);
        await this.slots.get(p.shop_id)?.adapter?.logout();
        this.sessions.commit(p.shop_id, g, { page_open: false });
        return this.state();
      }
      case "shop:reloadPage": {
        this.require(p.shop_id);
        const adapter = this.slots.get(p.shop_id)?.adapter;
        if (!adapter?.reloadPage) throw new IpcValidationError("platform_window_closed");
        const blocked = adapter.reloadPage();
        if (blocked) throw new IpcValidationError(blocked);
        return this.state();
      }
      case "shop:platformNav": {
        this.require(p.shop_id);
        const adapter = this.slots.get(p.shop_id)?.adapter;
        if (!adapter?.navigatePlatform) throw new IpcValidationError("platform_window_closed");
        const blocked = adapter.navigatePlatform(p.action);
        if (blocked) throw new IpcValidationError(blocked);
        return this.state();
      }
      case "shop:dismissPopups": {
        this.require(p.shop_id);
        const adapter = this.slots.get(p.shop_id)?.adapter;
        if (!adapter?.dismissPopups) throw new IpcValidationError("platform_window_closed");
        const result = await adapter.dismissPopups();
        if ("blocked" in result) throw new IpcValidationError(result.blocked);
        return result;
      }
      case "shop:setMode": {
        const config = this.require(p.shop_id);
        this.slots.get(p.shop_id)?.runtime?.setMode(p.mode);
        this.configs.upsert({ ...config, mode: p.mode });
        return this.state();
      }
      case "conv:takeover":
        this.running(p.shop_id).setTakeover(p.conversation_id, p.on);
        return this.state();
      case "app:setStartup": {
        if (!startup.supported()) throw new IpcValidationError("startup_unsupported");
        if (!startup.locationOk()) throw new IpcValidationError("startup_needs_applications");
        let r: { needsHandover: boolean };
        try {
          r = startup.apply({ launch_at_login: p.launch_at_login, restart_on_crash: p.restart_on_crash });
        } catch (err) {
          console.log(`startup apply failed: ${errorCode(err) === "internal_error" ? (err as Error).message : errorCode(err)}`);
          throw new IpcValidationError("startup_apply_failed");
        }
        if (r.needsHandover && mainWindow && !mainWindow.isDestroyed()) {
          const choice = await dialog.showMessageBox(mainWindow, {
            type: "question",
            buttons: ["现在重启", "稍后"],
            defaultId: 0,
            cancelId: 1,
            message: "需要重启客户端，崩溃后自动重启才会生效",
            detail: "重启时会先安全停止各店铺（进行中的发送按原规则收尾），再由系统重新打开客户端并恢复上次打开着的店铺。选“稍后”则在下次打开客户端时生效。",
          });
          if (choice.response === 0) setTimeout(() => startup.handover(process.platform === "darwin" ? "launch_agent" : "supervisor"), 0);
        }
        return this.state();
      }
      case "sim:message":
        this.running(p.shop_id);
        this.mock(p.shop_id).injectBuyerMessage({ conversation_id: p.conversation_id, content: p.content, kind: p.kind, stableId: p.stable_id });
        return this.state();
      case "sim:action": {
        this.running(p.shop_id);
        const m = this.mock(p.shop_id);
        const conv = p.conversation_id as string;
        switch (p.action) {
          case "set_send_behavior":
            m.sendBehavior = p.value as MockSendBehavior;
            break;
          case "toggle_history_gap":
            if (m.historyGaps.has(conv)) m.historyGaps.delete(conv);
            else m.historyGaps.add(conv);
            break;
          case "login_as_other":
            m.loginAs = `${this.require(p.shop_id).platform_shop_id}-other`;
            m.expire("切换登录账号（模拟）");
            await m.login();
            break;
          case "login_as_expected":
            m.loginAs = null;
            m.expire("重新登录（模拟）");
            await m.login();
            break;
          case "expire_login":
            m.expire();
            break;
          case "replay_history":
            m.replayHistory();
            break;
          case "redeliver_last": {
            const history = await m.fetchHistory(conv).catch(() => null);
            const last = history?.messages.filter((x) => x.role === "buyer").pop();
            if (last) m.redeliver(last);
            break;
          }
          case "agent_reply":
            m.injectAgentReply(conv, p.value as string);
            break;
        }
        return { ...this.state(), sim: { send_behavior: m.sendBehavior, history_gaps: [...m.historyGaps] } };
      }
    }
  }
}

let controller: Controller;

function trustedSender(event: IpcMainInvokeEvent): boolean {
  return !!mainWindow && event.sender === mainWindow.webContents && event.senderFrame?.url === INDEX_URL;
}

function registerIpc() {
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, async (event, payload) => {
      if (!trustedSender(event)) return { ok: false, error: "untrusted_sender" };
      try {
        const p = validateIpc(channel, payload);
        return { ok: true, data: await controller.handle(p) };
      } catch (err) {
        const code = err instanceof IpcValidationError ? err.message : errorCode(err) !== "internal_error" ? errorCode(err) : (err as Error)?.message || "internal_error";
        return { ok: false, error: code };
      }
    });
  }
}

function hardenSessions() {
  // 不授予任何网页权限（摄像头、通知、地理位置等）。
  app.on("session-created", (s) => {
    s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    s.setPermissionCheckHandler(() => false);
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

function createWindow() {
  // 平台页面需要较大空间：默认铺满主屏工作区（不超过 1680×1050），最小 1100×700。
  const work = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new ClientWindow({
    width: Math.max(1100, Math.min(1680, work.width)),
    height: Math.max(700, Math.min(1050, work.height)),
    minWidth: 1100,
    minHeight: 700,
    title: "Claw-Next 登录收发客户端",
    show: !SMOKE,
    webPreferences: { ...APP_WEB_PREFERENCES, preload: path.join(__dirname, "..", "preload", "preload.js") },
  });
  platformWorkspace = new PlatformWorkspace(mainWindow, mainWindow.shellView);
  const wc = mainWindow.webContents;
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (event, url) => {
    if (url !== INDEX_URL) event.preventDefault();
  });
  wc.on("will-redirect", (event) => event.preventDefault());
  wc.on("did-start-loading", () => platformWorkspace?.present(null, null));
  wc.on("render-process-gone", () => platformWorkspace?.present(null, null));
  mainWindow.on("closed", () => { platformWorkspace?.dispose(); platformWorkspace = null; mainWindow = null; });
  return mainWindow.loadFile(INDEX);
}

async function smoke() {
  const win = mainWindow as ClientWindow;
  // BaseWindow 的子视图首次截图需要实际显示表面；只显示本次虚构自检窗口，不抢焦点。
  win.showInactive();
  const result: Record<string, unknown> = {};
  result.renderer = await win.webContents.executeJavaScript(
    `({ require: typeof require, process: typeof process, module: typeof module, bridge: Object.keys(window.clawNext || {}).sort() })`,
  );
  result.bad_channel = await win.webContents.executeJavaScript(`window.clawNext.invoke("fs:read", {}).then(() => "allowed", (e) => "rejected")`);
  result.bad_payload = await win.webContents.executeJavaScript(`window.clawNext.invoke("shop:setMode", { shop_id: "../x", mode: "auto" })`);
  result.bad_url = await win.webContents.executeJavaScript(
    `window.clawNext.invoke("shop:save", { shop: { shop_id: "x", display_name: "x", backend_url: "http://example.com", platform_shop_id: "p", adapter: "mock" } })`,
  );
  // “客户端设置”的展开/收起由用户决定，状态推送重建界面后保持不变（只读界面，不修改启动设置）。
  const settingsOpenAfterPush = async (open: boolean) => {
    await win.webContents.executeJavaScript(`(() => { const d = document.querySelector("#app-settings details"); if (d) d.open = ${open}; return !!d; })()`);
    await new Promise((r) => setTimeout(r, 100));
    controller.push();
    await new Promise((r) => setTimeout(r, 400));
    return win.webContents.executeJavaScript(`document.querySelector("#app-settings details")?.open ?? null`);
  };
  result.settings_open_kept = await settingsOpenAfterPush(true);
  result.settings_closed_kept = await settingsOpenAfterPush(false);
  const backendUrl = process.env.CLAW_NEXT_DEMO_BACKEND;
  const token = process.env.CLAW_NEXT_DEMO_TOKEN;
  if (backendUrl && token) {
    const shopId = process.env.CLAW_NEXT_DEMO_SHOP ?? "demo-shop";
    controller.configs.upsert({ shop_id: shopId, display_name: "演示店铺", backend_url: backendUrl, platform_shop_id: "pdd-demo-shop", adapter: "mock", mode: "auto" });
    controller.setEphemeralToken(shopId, token);
    await controller.connect(shopId);
    await controller.handle({ channel: "shop:login", shop_id: shopId });
    await new Promise((r) => setTimeout(r, 800));
    const say = (conversation_id: string, content: string, kind: "text" | "image" = "text") =>
      controller.handle({ channel: "sim:message", shop_id: shopId, conversation_id, content, kind, stable_id: true });
    await say("buyer-demo-001", "营业时间是什么时候？");
    await say("buyer-demo-002", "我想退款，怎么操作？");
    await say("buyer-demo-003", "买家发来一张商品照片", "image");
    await new Promise((r) => setTimeout(r, 4000));
    controller.push();
    await new Promise((r) => setTimeout(r, 600));
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll(".conv-item")].find((el) => el.textContent.includes("buyer-demo-001"))?.click()`,
    );
    await new Promise((r) => setTimeout(r, 300));
    const html: string = await win.webContents.executeJavaScript("document.documentElement.outerHTML");
    result.token_in_dom = html.includes(token);
    result.demo = controller.state().shops.map((s) => ({
      shop: s.config.shop_id,
      backend: s.view?.backend.state,
      lease: s.view?.lease.state,
      statuses: s.view?.conversations.flatMap((c) => c.messages.filter((m) => m.status).map((m) => `${c.conversation_id}:${m.status?.label}`)),
    }));
  }
  const shot = process.env.CLAW_NEXT_SCREENSHOT;
  if (shot) {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(shot, image.toPNG());
    result.screenshot = shot;
  }
  console.log("SMOKE_RESULT " + JSON.stringify(result));
}

/**
 * 本机联调：从本机后台配置导入同店口令并自动连接、打开拼多多平台窗口。
 * 只处理后台地址为回环地址的店铺；口令写入系统安全存储，不打印。
 */
/** 开发自检触发：在 diag/<店铺>/click-probe.request 放一个空文件即运行一次拦截式点击自检，结果写日志。 */
function devClickProbeWatcher() {
  setInterval(() => {
    for (const [shopId, slot] of controller.slotsForDev()) {
      const flag = path.join(userData, "diag", shopId, "click-probe.request");
      if (!fs.existsSync(flag)) continue;
      fs.rmSync(flag, { force: true });
      const rt = slot.runtime;
      if (!(slot.adapter instanceof PddPageAdapter) || !rt) continue;
      // 只允许在已有 unknown 的对话上自检（该对话已冻结自动发送）。
      void slot.adapter.clickProbe((uid) => rt.journal.hasUnknown(uid)).then((r) => console.log(`[${shopId}] click-probe ${r}`));
    }
  }, 2000);
}

async function devAutoConnect(configPath: string) {
  let clients: { shop_id?: unknown; token?: unknown }[];
  try {
    clients = JSON.parse(fs.readFileSync(path.resolve(configPath), "utf8")).clients ?? [];
  } catch {
    console.log("dev auto-connect: backend config unreadable");
    return;
  }
  for (const config of controller.configs.list()) {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.backend_url).hostname)) continue;
    const token = clients.find((c) => c.shop_id === config.shop_id)?.token;
    if (typeof token !== "string") continue;
    try {
      if (controller.secrets.get(config.shop_id) !== validateToken(token)) controller.secrets.set(config.shop_id, token);
      await controller.connect(config.shop_id);
      if (config.adapter === "pdd") await controller.platformLogin(config.shop_id);
      console.log(`dev auto-connect: ${config.shop_id} connected`);
    } catch (err) {
      console.log(`dev auto-connect: ${config.shop_id} failed: ${errorCode(err)}`);
    }
  }
  controller.push();
}

/**
 * 提示把客户端移到“应用程序”文件夹。不替用户移动：程序复制的副本仍可能带隔离标记、再次被系统放到临时位置，
 * 只有用户在访达里亲自拖动才可靠。返回 true 表示用户选择退出去移动（已打开“应用程序”文件夹）。
 */
async function askMoveToApplications(): Promise<boolean> {
  const choice = await dialog.showMessageBox({
    type: "warning",
    buttons: ["退出，去移动", "继续使用"],
    defaultId: 0,
    cancelId: 1,
    message: "请把客户端拖到“应用程序”文件夹后再打开",
    detail:
      "当前客户端不在“应用程序”文件夹里（例如在“下载”里解压后直接打开）。这样运行时系统会把它放在临时位置，退出或重启后就失效：开机自启、崩溃后自动重启都不会生效，“应用程序”里的旧版本也不会更新。\n\n" +
      "做法：退出客户端 → 在访达里把解压出来的 Claw-Next-Client 拖进“应用程序”文件夹（提示已有同名应用时选“替换”）→ 从“应用程序”或启动台打开。\n\n" +
      "选“继续使用”可以照常使用，但这次不能保存开机自启和崩溃重启设置。",
  });
  if (choice.response !== 0) {
    console.log("startup move to Applications postponed");
    return false;
  }
  await shell.openPath("/Applications").catch(() => "");
  return true;
}

app.whenReady().then(async () => {
  if (!gotLock) return;
  if (!SMOKE) {
    const decision = startupDecision({ packaged: app.isPackaged, platform: process.platform, settings: startup.store.get(), argv: process.argv });
    const manual = !(decision.action === "run" && decision.automatic);
    // 手动打开代表用户已经介入：清空重启预算，否则预算耗尽后手动打开也会在交接后被拒。
    if (app.isPackaged && manual) startup.budget.reset();
    // Mac：不在“应用程序”文件夹里运行（例如在“下载”里解压后直接打开）时，程序路径写不进系统任务：
    // 提示用户移过去；选择继续使用则照常运行，但不交接、不改系统任务（syncAtManualStart / apply 也会拒绝）。
    if (app.isPackaged && manual && !startup.locationOk()) {
      console.log(`startup app not in Applications folder translocated=${startup.translocated()}`);
      if (await askMoveToApplications()) {
        app.quit();
        return;
      }
    } else if (decision.action === "handover" && !process.argv.includes(ARG_NO_HANDOVER)) {
      startup.handover(decision.to);
      return;
    }
    // 手动打开：卸载系统里可能残留的旧任务，按当前设置重写任务文件（托管启动时不动，避免结束自己）。
    if (decision.action === "run" && !decision.automatic) {
      try {
        startup.syncAtManualStart();
      } catch (err) {
        console.log(`startup sync failed: ${(err as Error)?.message ?? "error"}`);
      }
    }
    if (decision.action === "run" && decision.automatic) {
      const blocked = startup.budget.admit();
      if (blocked) {
        console.log(`startup automatic launch refused reason=${blocked}`);
        dialog.showMessageBoxSync({
          type: "warning",
          buttons: ["好"],
          message: "客户端 5 分钟内已自动启动 3 次，已停止自动重启",
          detail: "可能在反复崩溃。请查看客户端日志后再手动打开客户端；手动打开后，开机自启与崩溃重启设置保持不变。",
        });
        app.exit(0);
        return;
      }
    }
  }
  controller = new Controller();
  // 仅开发运行（未打包）的界面自动化测试：口令只放内存，不落盘，绕开 CI 上不可用的系统安全存储。打包版忽略。
  if (!app.isPackaged && !SMOKE && process.env.CLAW_NEXT_E2E === "1" && process.env.CLAW_NEXT_DEMO_TOKEN) {
    controller.setEphemeralToken(process.env.CLAW_NEXT_DEMO_SHOP ?? "demo-shop", validateToken(process.env.CLAW_NEXT_DEMO_TOKEN));
  }
  hardenSessions();
  registerIpc();
  await createWindow();
  if (!SMOKE && !process.env.CLAW_NEXT_DEV_BACKEND_CONFIG) await controller.restoreSessions();
  if (!SMOKE && process.env.CLAW_NEXT_DEV_BACKEND_CONFIG) {
    await devAutoConnect(process.env.CLAW_NEXT_DEV_BACKEND_CONFIG);
    devClickProbeWatcher();
  }
  if (SMOKE) {
    try {
      await smoke();
    } catch (err) {
      console.log("SMOKE_ERROR " + ((err as Error)?.message ?? String(err)));
      process.exitCode = 1;
    }
    await controller.stopAll();
    app.quit();
  }
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => app.quit());

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting || !controller) return;
  event.preventDefault();
  quitting = true;
  void controller.stopAll().finally(() => app.quit());
});
