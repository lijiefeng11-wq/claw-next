import { chromium, type Browser, type ConnectOverCDPTransport, type Page } from "playwright-core";
import type { WebContents } from "electron";

/** One existing page, over an in-memory CDP transport. No ports or new browser profile. */
export async function connectExistingPage(wc: WebContents, inputBlocker: (type: string) => string | null | Promise<string | null>): Promise<{ page: Page; close(): void }> {
  if (wc.isDestroyed() || !wc.debugger.isAttached()) throw new Error("playwright_page_unavailable");
  const dbg = wc.debugger;
  const { targetInfo } = await dbg.sendCommand("Target.getTargetInfo");
  const { sessionId: ownSession } = await dbg.sendCommand("Target.attachToTarget", { targetId: targetInfo.targetId, flatten: true });
  targetInfo.browserContextId ||= `claw-page-${wc.id}`;
  const mainSession = "claw-existing-page";
  const children = new Set<string>([ownSession]);
  let closed = false, attached = false;
  let inputFailed = false;
  let inputTail: Promise<unknown> = Promise.resolve();
  const emit = (message: object) => setImmediate(() => { if (!closed) transport.onmessage?.(message); });
  const message = (_event: unknown, method: string, params: any, sessionId?: string) => {
    if (!sessionId || !children.has(sessionId)) return;
    if (method === "Target.attachedToTarget") {
      children.add(params.sessionId);
      params = { ...params, targetInfo: { ...params.targetInfo, browserContextId: params.targetInfo.browserContextId || targetInfo.browserContextId } };
    }
    if (method === "Target.detachedFromTarget") children.delete(params.sessionId);
    emit({ method, params, sessionId: sessionId === ownSession ? mainSession : sessionId });
  };
  const close = () => {
    if (closed) return;
    closed = true;
    dbg.removeListener("message", message);
    wc.removeListener("destroyed", close);
    if (!wc.isDestroyed() && dbg.isAttached()) void dbg.sendCommand("Target.detachFromTarget", { sessionId: ownSession }).catch(() => undefined);
    setImmediate(() => transport.onclose?.());
  };
  const transport: ConnectOverCDPTransport = {
    send(raw) {
      const { id, method, params = {}, sessionId } = raw as { id: number; method: string; params?: any; sessionId?: string };
      void (async () => {
        try {
          if (closed || wc.isDestroyed()) throw new Error();
          let result;
          if (!sessionId && method === "Target.setAutoAttach") {
            emit({ id, result: {} });
            if (params.autoAttach && !attached) {
              attached = true;
              emit({ method: "Target.attachedToTarget", params: { sessionId: mainSession, targetInfo, waitingForDebugger: false } });
            }
            return;
          }
          if (!sessionId && method === "Target.getTargetInfo") result = { targetInfo: { targetId: "claw-browser", type: "browser", title: "", url: "", attached: true } };
          else if (!sessionId && method === "Browser.getVersion") result = await dbg.sendCommand(method);
          else if (!sessionId && method === "Target.setDiscoverTargets") result = {};
          else {
            const actual = sessionId === mainSession ? ownSession : sessionId;
            if (!actual || !children.has(actual) || method === "Browser.close" || method === "Target.closeTarget" || method === "Target.createTarget") throw new Error();
            if (method.startsWith("Browser.") || method.startsWith("Storage.") || method.startsWith("Target.") && !["Target.setAutoAttach", "Target.detachFromTarget"].includes(method)) throw new Error();
            if (method === "Target.detachFromTarget" && !children.has(params.sessionId)) throw new Error();
            if (method.startsWith("Input.")) {
              const input = inputTail.then(async () => {
                if (closed || inputFailed || await inputBlocker(params.type ?? method) || closed) throw new Error();
                let timer: NodeJS.Timeout | undefined;
                try {
                  return await Promise.race([dbg.sendCommand(method, params, actual), new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error()), 1000);
                  })]);
                } catch { inputFailed = true; throw new Error(); }
                finally { if (timer) clearTimeout(timer); }
              });
              inputTail = input.catch(() => undefined);
              result = await input;
            } else result = await dbg.sendCommand(method, params, actual);
          }
          emit({ id, result, ...(sessionId ? { sessionId } : {}) });
        } catch {
          // Protocol failures may contain page content. Never forward their raw text.
          emit({ id, error: { code: -32000, message: "page_command_failed" }, ...(sessionId ? { sessionId } : {}) });
        }
      })();
    },
    close,
  };
  dbg.on("message", message);
  wc.once("destroyed", close);
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(transport, { noDefaults: true, timeout: 3000 });
    const pages = browser.contexts().flatMap(c => c.pages());
    if (pages.length !== 1) throw new Error();
    return { page: pages[0], close };
  } catch {
    close();
    throw new Error("playwright_page_unavailable");
  }
}
