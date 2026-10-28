import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";

/** 通知只置 pending；50 ms 固定合并窗口不因持续变化而延后，扫描始终串行。 */
export class ScanScheduler {
  private pending = false;
  private running = false;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly scan: () => Promise<void>, private readonly blocked: () => boolean) {}

  request() {
    if (this.closed) return;
    this.pending = true;
    this.resume();
  }

  resume() {
    if (this.closed || !this.pending || this.running || this.timer || this.blocked()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 50);
  }

  private async flush() {
    if (this.closed || !this.pending || this.running || this.blocked()) return;
    this.pending = false;
    this.running = true;
    try {
      await this.scan();
    } catch {
      // 页面切换等失败由下一次通知或兜底扫描恢复。
    } finally {
      this.running = false;
      this.resume();
    }
  }

  close() {
    this.closed = true;
    this.pending = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** 只发送固定信号，不向主进程传送 DOM、消息、买家编号或网络内容。 */
export function messageObserverScript(binding: string): string {
  return `(() => {
    const name = ${JSON.stringify(binding)};
    if (globalThis.__clawMessageObserver) return;
    const selector = ".all-chat-list, .chat-list, li.chat-item, ul.msg-list";
    const within = (node) => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      return !!el && !!el.closest(selector);
    };
    const contains = (node) => within(node) || (node.nodeType === 1 && !!node.querySelector(selector));
    const notify = () => { if (typeof globalThis[name] === "function") globalThis[name]("changed"); };
    const observer = new MutationObserver((records) => {
      if (records.some((r) => within(r.target) || [...r.addedNodes, ...r.removedNodes].some(contains))) notify();
    });
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "data-random"] });
    globalThis.__clawMessageObserver = observer;
  })()`;
}

/** 每个页面独立隔离环境；断开时降级为原有的 1.5 秒扫描，不接管调试器。 */
export class PddMessageWatcher {
  readonly scheduler: ScanScheduler;
  private readonly binding = `clawMessageChanged_${randomUUID().replaceAll("-", "")}`;
  private readonly world = `claw-message-watcher-${randomUUID()}`;
  private epoch = 0;
  private context: number | null = null;
  private installing = false;
  private closed = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly contents: WebContents, scan: () => Promise<void>, blocked: () => boolean, private readonly onPageChange: () => void) {
    this.scheduler = new ScanScheduler(scan, blocked);
    contents.on("did-start-navigation", this.navigation);
    contents.on("dom-ready", this.ready);
    contents.debugger.on("message", this.message);
    contents.debugger.on("detach", this.invalidate);
    this.timer = setInterval(() => {
      void this.install();
      this.scheduler.request();
    }, 1500);
    void this.install();
  }

  private readonly navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (!mainFrame || inPlace) return;
    this.invalidate();
    this.onPageChange();
  };

  private readonly invalidate = () => {
    this.epoch++;
    this.context = null;
  };

  private readonly ready = () => {
    void this.install();
    this.scheduler.request();
  };

  private readonly message = (_event: unknown, method: string, params: any) => {
    if (method === "Runtime.executionContextsCleared" || (method === "Runtime.executionContextDestroyed" && params.executionContextId === this.context)) {
      this.invalidate();
    } else if (method === "Runtime.bindingCalled" && !this.closed && this.context !== null && params.name === this.binding && params.executionContextId === this.context && params.payload === "changed") {
      this.scheduler.request();
    }
  };

  private async install() {
    const wc = this.contents;
    if (this.closed || this.context !== null || this.installing || wc.isDestroyed() || wc.isLoadingMainFrame() || !wc.debugger.isAttached()) return;
    const epoch = this.epoch;
    const current = () => !this.closed && epoch === this.epoch && !wc.isDestroyed() && wc.debugger.isAttached();
    this.installing = true;
    try {
      await wc.debugger.sendCommand("Runtime.enable");
      const tree = await wc.debugger.sendCommand("Page.getFrameTree");
      if (!current()) return;
      const result = await wc.debugger.sendCommand("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: this.world });
      if (!current()) return;
      const contextId = result.executionContextId;
      // 指定环境名称，绝不把绑定暴露给所有页面执行环境。
      await wc.debugger.sendCommand("Runtime.addBinding", { name: this.binding, executionContextName: this.world });
      if (!current()) return;
      const installed = await wc.debugger.sendCommand("Runtime.evaluate", { contextId, expression: messageObserverScript(this.binding), returnByValue: true });
      if (!current() || installed.exceptionDetails) return;
      this.context = contextId;
    } catch {
      // 保留定时扫描；下一次空闲兜底尝试恢复隔离监听器。
    } finally {
      this.installing = false;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const contextId = this.context;
    this.invalidate();
    this.scheduler.close();
    clearInterval(this.timer);
    const wc = this.contents;
    wc.removeListener("did-start-navigation", this.navigation);
    wc.removeListener("dom-ready", this.ready);
    wc.debugger.removeListener("message", this.message);
    wc.debugger.removeListener("detach", this.invalidate);
    if (!wc.isDestroyed() && wc.debugger.isAttached()) {
      if (contextId !== null) void wc.debugger.sendCommand("Runtime.evaluate", { contextId, expression: "globalThis.__clawMessageObserver?.disconnect()" }).catch(() => undefined);
      void wc.debugger.sendCommand("Runtime.removeBinding", { name: this.binding }).catch(() => undefined);
    }
  }
}
