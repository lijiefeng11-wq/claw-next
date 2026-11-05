import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { app } from "electron";

type Selection = { candidate: number; engine: "scrapling" } | { error: string };
let child: ChildProcessWithoutNullStreams | null = null;
let ready: Promise<void> | null = null;
let pending: { resolve(v: Selection): void; reject(): void } | null = null;
let serial: Promise<unknown> = Promise.resolve();

function stop() {
  const worker = child;
  child = null; ready = null;
  pending?.reject(); pending = null;
  worker?.kill();
}
function start(): Promise<void> {
  if (ready) return ready;
  const folder = app.isPackaged ? path.join(process.resourcesPath, "claw-selector") : path.resolve(__dirname, "..", "..", "..", "out", "selector-build", "dist", "claw-selector");
  const binary = path.join(folder, process.platform === "win32" ? "claw-selector.exe" : "claw-selector");
  ready = new Promise<void>((resolve, reject) => {
    const worker = spawn(binary, ["--serve"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child = worker;
    let buffer = "", initialized = false;
    const timer = setTimeout(() => { reject(new Error("selector_unavailable")); stop(); }, 15000);
    const failed = () => {
      clearTimeout(timer); reject(new Error("selector_unavailable"));
      if (child === worker) stop();
    };
    worker.once("error", failed); worker.once("exit", failed); worker.stdin.on("error", failed);
    worker.stderr.resume(); // Never log page fragments or parser exception text.
    worker.stdout.on("data", data => {
      if (child !== worker) return;
      buffer += data.toString("utf8");
      if (buffer.length > 4096) { failed(); return; }
      for (let at; (at = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try {
          const v = JSON.parse(line);
          if (!initialized) {
            if (v.ready !== "scrapling") throw new Error();
            initialized = true; clearTimeout(timer); resolve();
          } else if (pending) {
            const current = pending; pending = null;
            if (v.engine === "scrapling" && Number.isInteger(v.candidate) && v.candidate >= 0 && v.candidate <= 100) current.resolve({ engine: "scrapling", candidate: v.candidate });
            else current.resolve({ error: "selector_no_unique_send_control" });
          } else throw new Error();
        } catch { failed(); return; }
      }
    });
  });
  return ready;
}

export function prewarmSelector() { void start().catch(() => undefined); }
export function stopSelector() { stop(); }
export function selectSendControl(html: string, timeout: number): Promise<Selection> {
  if (Buffer.byteLength(html, "utf8") > 250_000) return Promise.resolve({ error: "selector_input_too_large" });
  const queuedAt = Date.now();
  const work = serial.catch(() => undefined).then(async () => {
    const remaining = timeout - (Date.now() - queuedAt);
    if (remaining <= 0) throw new Error("selector_timeout");
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (async () => {
          await start();
          return new Promise<Selection>((resolve, reject) => {
            pending = { resolve, reject: () => reject(new Error("selector_unavailable")) };
            child!.stdin.write(JSON.stringify({ html }) + "\n");
          });
        })(),
        new Promise<Selection>((_, reject) => { timer = setTimeout(() => { stop(); reject(new Error("selector_timeout")); }, remaining); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  });
  serial = work.catch(() => undefined);
  return work;
}
