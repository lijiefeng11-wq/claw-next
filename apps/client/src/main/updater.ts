import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import https from "node:https";
import path from "node:path";
import {
  APP_BUNDLE,
  BUNDLE_ID,
  BuildInfo,
  MAX_DIGEST_BYTES,
  MAX_ZIP_BYTES,
  STAGING_PREFIX,
  UPDATE_CLAIM,
  UPDATE_NO_CHANGE_STAGES,
  UPDATE_REPO,
  UPDATE_RESULT_LOG,
  UpdateCandidate,
  checkUpdateUrl,
  listZipEntries,
  parseBuildInfo,
  parseDigestFile,
  selectUpdate,
  stagingToRemove,
  swapScript,
  updateErrorText,
  validateExtractedTree,
  validateZipEntries,
  zipName,
} from "../core/update.js";
import { LAUNCH_AGENT_LABEL } from "../core/startup.js";

// 本文件不引用 electron：打包信息、路径与系统命令都由主进程注入，测试用虚构夹具替换。

/** pending：本进程没按时退出、又无法确认替换脚本已取消；继续保持“更新中”，等脚本自己中止或客户端被关闭。 */
export type UpdateState = "idle" | "checking" | "latest" | "available" | "downloading" | "waiting_tasks" | "installing" | "pending" | "error";
export type UpdateView = {
  supported: boolean;
  state: UpdateState;
  current: { run: number; sha: string } | null;
  candidate: { run: number; sha: string } | null;
  detail: string;
};

/** 更新期间对所有店铺的要求；由主进程按店铺运行时实现。 */
export type UpdateHost = {
  /** 进入 / 解除全局“更新中”：期间所有店铺禁止新的准备提交、领取、附加发送与标星（含之后新连接的店铺）。 */
  setUpdateHold(on: boolean): void;
  /** 所有店铺已没有进行中的领取 / 发送 / 标星，也没有未上传完的回执，且没有正在停止的店铺。 */
  allIdleForUpdate(): boolean;
  /** 停掉所有店铺并退出本进程（替换脚本在进程退出后才改名）。 */
  quit(): void;
};

/** https.get 的形状；测试替换为脚本化的假响应。 */
export type Requester = (url: string, options: https.RequestOptions, callback: (res: http.IncomingMessage) => void) => http.ClientRequest;

export type GetLimits = { apiMs: number; idleMs: number; totalMs: number };
const DEFAULT_LIMITS: GetLimits = { apiMs: 20_000, idleMs: 30_000, totalMs: 15 * 60_000 };
const UA = "Claw-Next-Client-Updater";

/** 包内 build-info.json（打包时写入）；读不到或格式不对为 null。 */
export function readBuildInfo(resourcesPath: string): BuildInfo | null {
  try {
    return parseBuildInfo(JSON.parse(fs.readFileSync(path.join(resourcesPath, "build-info.json"), "utf8")));
  } catch {
    return null;
  }
}

/** 本进程启动成功后写就绪标记（替换脚本据此判断新包已能启动）；只含运行序号、进程号与时间。 */
export function writeReadyMarker(userData: string, info: BuildInfo | null) {
  if (!info) return;
  try {
    const dir = path.join(userData, "update");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "ready.json"), JSON.stringify({ run: info.run, pid: process.pid, at: Math.floor(Date.now() / 1000) }), { mode: 0o600 });
  } catch (err) {
    console.log(`update ready marker failed: ${(err as Error)?.message ?? "error"}`);
  }
}

/**
 * 一次 HTTPS GET：手动处理重定向（最多 5 跳），每一跳都核对地址（见 checkUpdateUrl）；限制大小、空闲与总时长。
 * sink 为 null 时把响应体收进内存返回；否则写入文件（写入失败如磁盘满按失败处理）。返回内容的 sha256 与字节数。
 */
export function httpGet(
  url: string,
  tag: string | null,
  maxBytes: number,
  sink: string | null,
  accept: string,
  request: Requester = https.get,
  limits: GetLimits = DEFAULT_LIMITS,
): Promise<{ body: Buffer | null; sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    let hops = 0;
    let settled = false;
    let current: http.ClientRequest | null = null;
    let out: fs.WriteStream | null = null;
    const finish = (err: Error | null, value?: { body: Buffer | null; sha256: string; size: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(total);
      if (err) {
        current?.destroy();
        out?.destroy();
        reject(err);
      } else resolve(value as { body: Buffer | null; sha256: string; size: number });
    };
    const total = setTimeout(() => finish(new Error("timeout")), sink ? limits.totalMs : limits.apiMs);
    const go = (target: string) => {
      const bad = checkUpdateUrl(target, tag);
      if (bad) return finish(new Error(bad));
      const req = request(target, { headers: { "User-Agent": UA, Accept: accept }, timeout: sink ? limits.idleMs : limits.apiMs }, (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          const loc = res.headers.location;
          if (!loc || ++hops > 5) return finish(new Error("redirect_invalid"));
          let next: string;
          try {
            next = new URL(loc, target).toString();
          } catch {
            return finish(new Error("redirect_invalid"));
          }
          return go(next);
        }
        if (status !== 200) {
          res.resume();
          return finish(new Error(`http_${status}`));
        }
        const declared = Number(res.headers["content-length"] ?? "0");
        if (declared > maxBytes) return finish(new Error("too_large"));
        const hash = createHash("sha256");
        const chunks: Buffer[] = [];
        let size = 0;
        if (sink) {
          out = fs.createWriteStream(sink, { mode: 0o600 });
          out.on("error", (err) => finish(err));
        }
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) return finish(new Error("too_large"));
          hash.update(chunk);
          if (out) out.write(chunk);
          else chunks.push(chunk);
        });
        res.on("error", (err) => finish(err));
        res.on("close", () => {
          if (!res.complete) finish(new Error("download_interrupted"));
        });
        res.on("end", () => {
          if (settled) return;
          if (res.complete === false) return finish(new Error("download_interrupted"));
          const value = { body: out ? null : Buffer.concat(chunks), sha256: hash.digest("hex"), size };
          const o = out;
          if (!o) return finish(null, value);
          // 写入失败（磁盘满、无权限等）可能在结束回调之前或回调里才报告：两处都核对，失败不算下载完成。
          o.end((err?: Error | null) => {
            const failed = err ?? o.errored;
            if (failed) finish(failed);
            else finish(null, value);
          });
        });
      });
      current = req;
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (err) => finish(err));
    };
    go(url);
  });
}

/** 暂存目录里替换记录的最后一个阶段；没有记录为 null。 */
export function lastStage(dir: string): string | null {
  try {
    const lines = fs.readFileSync(path.join(dir, UPDATE_RESULT_LOG), "utf8").trim().split("\n");
    return lines[lines.length - 1]?.split(" ")[1] ?? null;
  } catch {
    return null;
  }
}

/** 清理已结束的旧暂存目录（规则见 stagingToRemove）；读不到的跳过，失败不影响更新。 */
export function cleanupStaging(parent: string, nowMs = Date.now()) {
  try {
    const dirs = fs
      .readdirSync(parent)
      .filter((n) => n.startsWith(STAGING_PREFIX))
      .map((name) => ({ name, mtimeMs: fs.statSync(path.join(parent, name)).mtimeMs, last: lastStage(path.join(parent, name)) }));
    for (const name of stagingToRemove(dirs, nowMs)) fs.rmSync(path.join(parent, name), { recursive: true, force: true });
  } catch (err) {
    console.log(`update staging cleanup skipped: ${(err as Error)?.message ?? "error"}`);
  }
}

export type UpdaterDeps = {
  packaged: boolean;
  platform: NodeJS.Platform;
  current: BuildInfo | null;
  /** 正在运行的 .app 路径。 */
  appPath: string;
  userData: string;
  /** 自定义数据目录（重新打开时以 --user-data 传下去）；默认目录为 null。 */
  userDataArg: string | null;
  uid: number;
  locationOk: () => boolean;
  /** 当前设置对应的本客户端 LaunchAgent 任务文件；没有为 null。 */
  agentPlist: () => string | null;
  onChange: () => void;
  request?: Requester;
  limits?: GetLimits;
  /** 同步执行系统命令（ditto / plutil / codesign），失败抛错；返回标准输出。 */
  run?: (file: string, args: string[], timeoutMs: number) => string;
  /** 后台启动替换脚本；进程起来后 resolve，起不来 reject。 */
  launch?: (scriptFile: string) => Promise<void>;
  timing?: Partial<UpdaterTiming>;
  /** 仅测试：替换脚本里等待的进程号与系统命令换成虚构替身。 */
  swapOverrides?: { pid?: number; launchctl?: string; open?: string; pkill?: string };
};
type UpdaterTiming = { idleWaitMs: number; idlePollMs: number; quitWatchMs: number; swapWaitTicks: number; pendingPollMs: number };
const DEFAULT_TIMING: UpdaterTiming = { idleWaitMs: 60_000, idlePollMs: 500, quitWatchMs: 75_000, swapWaitTicks: 600, pendingPollMs: 2_000 };

const defaultRun = (file: string, args: string[], timeoutMs: number) => execFileSync(file, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] });
const defaultLaunch = (scriptFile: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("/bin/bash", [scriptFile], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

function errCode(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return (typeof e?.code === "string" && /^E[A-Z]+$/.test(e.code) ? e.code : e?.message) || "error";
}

/**
 * 客户端“检查更新”（#34）。只在 macOS 打包版、位于“应用程序”文件夹且包内有构建信息时提供。
 * 检查只读公开接口、不带口令；安装须用户点击确认。任何一步失败都不动现有应用。
 */
export class Updater {
  private state: UpdateState = "idle";
  private detail = "";
  private candidate: UpdateCandidate | null = null;
  private busy = false;
  private readonly t: UpdaterTiming;
  private readonly request: Requester;
  private readonly run: NonNullable<UpdaterDeps["run"]>;
  private readonly launch: NonNullable<UpdaterDeps["launch"]>;

  constructor(private readonly d: UpdaterDeps) {
    this.t = { ...DEFAULT_TIMING, ...d.timing };
    this.request = d.request ?? https.get;
    this.run = d.run ?? defaultRun;
    this.launch = d.launch ?? defaultLaunch;
  }

  supported(): boolean {
    const c = this.d.current;
    return this.d.packaged && this.d.platform === "darwin" && !!c && c.platform === "darwin" && this.d.locationOk();
  }

  view(): UpdateView {
    const c = this.d.current;
    return {
      supported: this.supported(),
      state: this.state,
      current: c ? { run: c.run, sha: c.sha.slice(0, 7) } : null,
      candidate: this.candidate ? { run: this.candidate.run, sha: this.candidate.sha.slice(0, 7) } : null,
      detail: this.detail,
    };
  }

  private set(state: UpdateState, detail = "") {
    this.state = state;
    this.detail = detail;
    console.log(`update state=${state}`);
    this.onChangeSafe();
  }

  private onChangeSafe() {
    try {
      this.d.onChange();
    } catch {
      // 界面刷新失败不影响更新流程。
    }
  }

  private get(url: string, tag: string | null, maxBytes: number, sink: string | null) {
    return httpGet(url, tag, maxBytes, sink, sink || tag ? "application/octet-stream" : "application/vnd.github+json", this.request, this.d.limits);
  }

  private async api<T>(p: string): Promise<T> {
    const r = await this.get(`https://api.github.com/repos/${UPDATE_REPO}/${p}`, null, 8 * 1024 * 1024, null);
    return JSON.parse((r.body as Buffer).toString("utf8")) as T;
  }

  /** 只读：分页列出全部 release，选出运行序号最大的后继版本，并用 compare 确认它是本机提交的后继。 */
  async check(): Promise<UpdateView> {
    const own = this.d.current;
    if (!this.supported() || !own) throw new Error("update_not_supported");
    if (this.busy) throw new Error("update_busy");
    this.busy = true;
    this.candidate = null;
    this.set("checking");
    try {
      const releases: unknown[] = [];
      for (let page = 1; ; page++) {
        if (page > 20) throw new Error("release_list_too_long");
        const list = await this.api<unknown[]>(`releases?per_page=100&page=${page}`);
        if (!Array.isArray(list)) throw new Error("release_list_invalid");
        releases.push(...list);
        if (list.length < 100) break;
      }
      const sel = selectUpdate(own, releases);
      if (sel.kind === "none") return this.set("latest", "已是最新版本"), this.view();
      if (sel.kind === "ambiguous") return this.set("error", `构建 ${sel.run} 有多个发布，无法确定，未更新`), this.view();
      const cmp = await this.api<{ status?: unknown }>(`compare/${own.sha}...${sel.candidate.sha}`);
      if (cmp?.status !== "ahead") return this.set("error", `新版本不是当前版本的后续提交（${String(cmp?.status)}），未更新`), this.view();
      this.candidate = sel.candidate;
      this.set("available", `发现新版本：构建 ${sel.candidate.run}`);
      return this.view();
    } catch (err) {
      this.set("error", `检查失败：${updateErrorText(errCode(err))}`);
      return this.view();
    } finally {
      this.busy = false;
    }
  }

  /**
   * 下载、校验、解压到原应用所在卷上的私有暂存目录并核对；然后进入全局“更新中”，等所有店铺任务与回执归结，
   * 写替换脚本、启动它并退出本进程。启动脚本之前任何一步失败都不动现有应用，解除“更新中”并删除暂存目录。
   * 退出后由脚本完成替换；本进程若没按时退出，脚本中止，这里解除“更新中”并提示。
   */
  async install(host: UpdateHost): Promise<UpdateView> {
    const c = this.candidate;
    const own = this.d.current;
    if (!this.supported() || !own || !c) throw new Error("update_not_available");
    if (this.busy) throw new Error("update_busy");
    if (path.basename(this.d.appPath) !== APP_BUNDLE) throw new Error("update_app_path_unexpected");
    this.busy = true;
    const parent = path.dirname(this.d.appPath);
    let staging: string | null = null;
    let held = false;
    let launched = false;
    try {
      this.set("downloading", `正在下载构建 ${c.run}`);
      cleanupStaging(parent);
      const dir = path.join(parent, `${STAGING_PREFIX}${c.run}-${randomBytes(4).toString("hex")}`);
      fs.mkdirSync(dir, { mode: 0o700 });
      staging = dir;
      if (fs.statSync(dir).dev !== fs.statSync(parent).dev) throw new Error("staging_other_volume");
      const name = zipName(own.arch);
      const digest = await this.get(c.digest.url, c.tag, MAX_DIGEST_BYTES, null);
      const want = parseDigestFile((digest.body as Buffer).toString("utf8"), name);
      if (!want) throw new Error("digest_file_invalid");
      const zip = path.join(dir, name);
      const got = await this.get(c.zip.url, c.tag, Math.min(MAX_ZIP_BYTES, c.zip.size), zip);
      if (got.size !== c.zip.size || got.sha256 !== want) throw new Error("zip_digest_mismatch");
      const zipProblem = validateZipEntries(listZipEntries(zip));
      if (zipProblem) throw new Error(zipProblem);
      const out = path.join(dir, "extract");
      fs.mkdirSync(out, { mode: 0o700 });
      try {
        this.run("/usr/bin/ditto", ["-x", "-k", zip, out], 300_000);
      } catch (err) {
        throw new Error(errCode(err) === "ENOSPC" ? "ENOSPC" : "extract_failed");
      }
      fs.rmSync(zip, { force: true });
      const treeProblem = validateExtractedTree(out);
      if (treeProblem) throw new Error(treeProblem);
      const newApp = path.join(out, APP_BUNDLE);
      const bundleId = this.run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(newApp, "Contents", "Info.plist")], 10_000).trim();
      if (bundleId !== BUNDLE_ID) throw new Error("bundle_id_mismatch");
      const info = readBuildInfo(path.join(newApp, "Contents", "Resources"));
      if (!info || info.sha !== c.sha || info.run !== c.run || info.arch !== own.arch || info.platform !== "darwin") throw new Error("build_info_mismatch");
      // 本机临时签名的完整性核对（只证明包内文件未被改动，不证明来源）。
      try {
        this.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", newApp], 120_000);
      } catch {
        throw new Error("codesign_failed");
      }

      // 先进入“更新中”（之后新到的消息与决定都不会再领取、发送或标星），再等已有任务与回执归结；超时放弃。
      this.set("waiting_tasks", "等待进行中的任务结束");
      host.setUpdateHold(true);
      held = true;
      const until = Date.now() + this.t.idleWaitMs;
      while (!host.allIdleForUpdate()) {
        if (Date.now() > until) throw new Error("tasks_not_idle");
        await new Promise((r) => setTimeout(r, this.t.idlePollMs));
      }

      const stateFile = path.join(dir, UPDATE_RESULT_LOG);
      const script = swapScript({
        pid: process.pid,
        app: this.d.appPath,
        newApp,
        backup: path.join(dir, "previous.app"),
        failed: path.join(dir, "failed.app"),
        stateFile,
        claim: path.join(dir, UPDATE_CLAIM),
        readyFile: path.join(this.d.userData, "update", "ready.json"),
        run: c.run,
        domain: `gui/${this.d.uid}`,
        label: LAUNCH_AGENT_LABEL,
        plist: this.d.agentPlist(),
        userData: this.d.userDataArg,
        waitTicks: this.t.swapWaitTicks,
        ...this.d.swapOverrides,
      });
      const scriptFile = path.join(dir, "swap.sh");
      fs.writeFileSync(scriptFile, script, { mode: 0o700 });
      try {
        await this.launch(scriptFile);
      } catch {
        throw new Error("launch_failed");
      }
      launched = true;
      this.set("installing", `正在安装构建 ${c.run}，客户端将自动退出并重新打开`);
      console.log(`update swap started run=${c.run} staging=${path.basename(dir)}`);
      this.watchQuit(host, dir);
      host.quit();
      return this.view();
    } catch (err) {
      if (held) host.setUpdateHold(false);
      this.set("error", `更新未完成：${updateErrorText(errCode(err))}。现有客户端未改动`);
      if (staging) {
        try {
          fs.rmSync(staging, { recursive: true, force: true });
        } catch {
          // 暂存目录清理失败不影响现有应用；下次安装前按规则清理。
        }
      }
      return this.view();
    } finally {
      if (!launched) this.busy = false;
    }
  }

  /**
   * 本进程到点仍没退出：不能凭“时间到了”推定替换脚本已结束（脚本可能被延迟或暂停，之后恢复时本进程若已退出就会继续替换）。
   * 先抢建本次的认领标记：建成即确认脚本以后建不成、只会中止且不做任何改动，才解除“更新中”、允许再装。
   * 建不成（脚本已认领或暂存目录异常）就是状态不明：继续保持“更新中”、如实显示待确认，
   * 之后只在脚本自己写出“改动前中止”的记录时解除；本进程退出则由脚本按原流程收尾。
   */
  private watchQuit(host: UpdateHost, dir: string) {
    const timer = setTimeout(() => {
      const stage = lastStage(dir);
      let cancelled = false;
      let why = "";
      try {
        fs.mkdirSync(path.join(dir, UPDATE_CLAIM));
        cancelled = true;
      } catch (err) {
        why = errCode(err);
      }
      console.log(`update quit watchdog stage=${stage ?? "none"} cancel=${cancelled ? "claimed" : why}`);
      if (cancelled) return this.releaseAfterQuitTimeout(host, "客户端没有按时退出，更新已取消（替换程序确认不会再替换），现有客户端未改动。请关闭后重新打开客户端");
      this.set("pending", "客户端没有按时退出，暂时无法确认更新是否已取消。所有店铺继续暂停自动回复。请关闭客户端；关闭后若没有自动重新打开，请手动打开");
      this.watchPending(host, dir);
    }, this.t.quitWatchMs);
    timer.unref?.();
  }

  /** 状态不明期间定时看替换记录：脚本自己写出改动前中止（见 UPDATE_NO_CHANGE_STAGES）才解除。 */
  private watchPending(host: UpdateHost, dir: string) {
    const timer = setInterval(() => {
      const stage = lastStage(dir);
      if (!stage || !UPDATE_NO_CHANGE_STAGES.includes(stage)) return;
      clearInterval(timer);
      console.log(`update pending resolved stage=${stage}`);
      this.releaseAfterQuitTimeout(host, "客户端没有按时退出，替换程序已自行中止，更新已取消，现有客户端未改动。请关闭后重新打开客户端");
    }, this.t.pendingPollMs);
    timer.unref?.();
  }

  private releaseAfterQuitTimeout(host: UpdateHost, detail: string) {
    host.setUpdateHold(false);
    this.busy = false;
    this.set("error", detail);
  }
}
