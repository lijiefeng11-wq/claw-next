import fs from "node:fs";
import path from "node:path";

/**
 * 客户端“检查更新”的纯判定部分（#34）。只读本仓库 CI 发布的 client-* 预发布版本；
 * 发布页的 sha256 与 zip 同源，只用于完整性，不当作来源证明。
 */

export const UPDATE_REPO = "lijiefeng11-wq/claw-next";
export const APP_BUNDLE = "Claw-Next-Client.app";
export const BUNDLE_ID = "com.claw-next.client";
/** 只允许这些主机（含每一跳重定向）；下载地址实测从 github.com 302 到 release-assets.githubusercontent.com。 */
export const UPDATE_HOSTS: readonly string[] = ["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"];
export const MAX_ZIP_BYTES = 400 * 1024 * 1024;
export const MAX_DIGEST_BYTES = 1024;
export const MAX_UNZIPPED_BYTES = 1536 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 20000;

export type BuildInfo = { sha: string; run: number; platform: string; arch: string };

/** 包内 build-info.json；sha 或 run 为 null（本机打包）或格式不对时返回 null，表示不提供检查更新。 */
export function parseBuildInfo(value: unknown): BuildInfo | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.sha !== "string" || !/^[0-9a-f]{40}$/.test(v.sha)) return null;
  if (!Number.isSafeInteger(v.run) || (v.run as number) < 1) return null;
  if (typeof v.platform !== "string" || typeof v.arch !== "string") return null;
  return { sha: v.sha, run: v.run as number, platform: v.platform, arch: v.arch };
}

export function zipName(arch: string) {
  return `Claw-Next-Client-darwin-${arch}.zip`;
}

export type ReleaseAsset = { id: number; name: string; size: number; url: string };
export type UpdateCandidate = { tag: string; run: number; sha: string; zip: ReleaseAsset; digest: ReleaseAsset };
export type UpdateSelection = { kind: "none" } | { kind: "ambiguous"; run: number } | { kind: "candidate"; candidate: UpdateCandidate };

const TAG = /^client-([1-9][0-9]{0,9})-([0-9a-f]{40})$/;

function asset(value: unknown): ReleaseAsset | null {
  if (typeof value !== "object" || value === null) return null;
  const a = value as Record<string, unknown>;
  if (!Number.isSafeInteger(a.id) || typeof a.name !== "string" || !Number.isSafeInteger(a.size) || typeof a.browser_download_url !== "string") return null;
  return { id: a.id as number, name: a.name, size: a.size as number, url: a.browser_download_url };
}

/**
 * 从 release 列表（含分页拼接后的全部）中选更新目标：只认非草稿、tag 为 client-<run>-<完整SHA>、
 * 资产里恰好各有一个本架构的 zip 与 .sha256 的版本；只考虑运行序号大于本机的，取最大者。
 * 最大序号对应多个版本（或同一 tag 重复）视为歧义，不升级。是否为本机提交的后继另由 compare 接口确认。
 */
export function selectUpdate(own: BuildInfo, releases: unknown[]): UpdateSelection {
  const name = zipName(own.arch);
  const found: UpdateCandidate[] = [];
  for (const r of releases) {
    if (typeof r !== "object" || r === null) continue;
    const rel = r as Record<string, unknown>;
    if (rel.draft !== false || typeof rel.tag_name !== "string") continue;
    const m = TAG.exec(rel.tag_name);
    if (!m) continue;
    const run = Number(m[1]);
    if (!(run > own.run)) continue;
    const assets = Array.isArray(rel.assets) ? rel.assets.map(asset) : [];
    const zips = assets.filter((a) => a?.name === name);
    const digests = assets.filter((a) => a?.name === `${name}.sha256`);
    if (zips.length !== 1 || digests.length !== 1 || !zips[0] || !digests[0]) continue;
    found.push({ tag: rel.tag_name, run, sha: m[2], zip: zips[0], digest: digests[0] });
  }
  if (!found.length) return { kind: "none" };
  const top = Math.max(...found.map((c) => c.run));
  const best = found.filter((c) => c.run === top);
  return best.length === 1 ? { kind: "candidate", candidate: best[0] } : { kind: "ambiguous", run: top };
}

/**
 * 每一跳（含重定向）都要核对：HTTPS、标准端口、无用户信息、主机在白名单内；
 * github.com 上只允许本仓库该 tag 的发布文件路径。返回阻止原因，通过为 null。
 */
export function checkUpdateUrl(raw: string, tag: string | null): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "url_invalid";
  }
  if (u.protocol !== "https:") return "url_not_https";
  if (u.port !== "" && u.port !== "443") return "url_port";
  if (u.username || u.password) return "url_userinfo";
  if (!UPDATE_HOSTS.includes(u.hostname)) return "url_host";
  if (u.hostname === "github.com" && !(tag && u.pathname.startsWith(`/${UPDATE_REPO}/releases/download/${tag}/`))) return "url_path";
  if (u.hostname === "api.github.com" && !u.pathname.startsWith(`/repos/${UPDATE_REPO}/`)) return "url_path";
  return null;
}

/** .sha256 文件内容：“<64 位十六进制>  <文件名>”，文件名须与 zip 一致。 */
export function parseDigestFile(text: string, name: string): string | null {
  const m = /^([0-9a-f]{64}) [ *]?(\S+)\s*$/.exec(text.trim());
  return m && m[2] === name ? m[1] : null;
}

export type ZipEntry = { name: string; size: number; mode: number };

/**
 * 只读 zip 中央目录（不解压）：条目名、解压后大小、Unix 权限位（含文件类型）。
 * 不支持 zip64、分卷和加密；遇到这些或结构不对时抛错（按不可信处理）。
 */
export function listZipEntries(file: string): ZipEntry[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("zip_no_eocd");
    const disk = tail.readUInt16LE(eocd + 4);
    const cdDisk = tail.readUInt16LE(eocd + 6);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (disk !== 0 || cdDisk !== 0) throw new Error("zip_multidisk");
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("zip64_unsupported");
    if (cdOffset + cdSize > size) throw new Error("zip_bad_cd");
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error("zip_bad_entry");
      const flags = cd.readUInt16LE(p + 8);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      if (flags & 0x1) throw new Error("zip_encrypted");
      if (usize === 0xffffffff) throw new Error("zip64_unsupported");
      if (p + 46 + nameLen > cd.length) throw new Error("zip_bad_entry");
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      entries.push({ name, size: usize, mode: (external >>> 16) & 0xffff });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * 解压前核对条目：数量与解压后总大小有上限；无绝对路径、无反斜杠、无 ..、无重复；根下只有本应用
 * （ditto 的 __MACOSX 属性条目只允许属于本应用）；任何条目都不能位于符号链接条目之下（防止经链接写到包外）。
 */
export function validateZipEntries(entries: ZipEntry[]): string | null {
  if (!entries.length) return "zip_empty";
  if (entries.length > MAX_ZIP_ENTRIES) return "zip_too_many_entries";
  let total = 0;
  const seen = new Set<string>();
  const links: string[] = [];
  for (const e of entries) {
    const parts = e.name.split("/");
    if (!e.name || e.name.startsWith("/") || e.name.includes("\\") || e.name.includes("\0") || parts.includes("..") || parts.includes(".")) return "zip_unsafe_path";
    const key = e.name.replace(/\/$/, "");
    if (seen.has(key)) return "zip_duplicate";
    seen.add(key);
    const rootOk = parts[0] === APP_BUNDLE || (parts[0] === "__MACOSX" && parts.length > 1 && (parts[1] === APP_BUNDLE || parts[1] === `._${APP_BUNDLE}`));
    if (!rootOk) return "zip_unexpected_root";
    total += e.size;
    if (total > MAX_UNZIPPED_BYTES) return "zip_too_large";
    if ((e.mode & S_IFMT) === S_IFLNK) links.push(key + "/");
  }
  if (!seen.has(APP_BUNDLE)) {
    // 目录条目可能省略，但至少要有包内文件。
    if (![...seen].some((n) => n.startsWith(APP_BUNDLE + "/"))) return "zip_no_app";
  }
  for (const n of seen) if (links.some((l) => (n + "/").startsWith(l) && n + "/" !== l)) return "zip_entry_under_symlink";
  return null;
}

/**
 * 解压后核对目录树：根下只有本应用（与 __MACOSX 无关，ditto 会把属性还原掉）；所有符号链接都不是绝对路径，
 * 且按实际链接逐级解析（含链中链、经链接目录的 ..）后仍在本应用内；循环或悬空的链接拒绝；
 * 不允许硬链接以外的特殊文件。返回阻止原因，通过为 null。
 */
export function validateExtractedTree(root: string): string | null {
  const names = fs.readdirSync(root);
  if (names.length !== 1 || names[0] !== APP_BUNDLE) return "extract_unexpected_root";
  const app = path.join(root, APP_BUNDLE);
  if (!fs.lstatSync(app).isDirectory()) return "extract_app_not_dir";
  const appReal = fs.realpathSync.native(app);
  const inside = (p: string) => {
    const rel = path.relative(appReal, p);
    return !(rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel));
  };
  const stack = [app];
  while (stack.length) {
    const dir = stack.pop() as string;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        const target = fs.readlinkSync(p);
        if (path.isAbsolute(target)) return "extract_absolute_symlink";
        // 先做词法核对（不跟随链接就能看出越界的直接拒绝），再按实际链接解析核对最终位置。
        if (!inside(path.resolve(fs.realpathSync.native(path.dirname(p)), target))) return "extract_symlink_escapes";
        let real: string;
        try {
          real = fs.realpathSync.native(p);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "ELOOP") return "extract_symlink_loop";
          if (code === "ENOENT" || code === "ENOTDIR") return "extract_symlink_dangling";
          throw err;
        }
        if (!inside(real)) return "extract_symlink_escapes";
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (!st.isFile()) return "extract_special_file";
    }
  }
  return null;
}

export const UPDATE_RESULT_LOG = "swap.log";
/**
 * 本次替换的“认领”标记（暂存目录下的子目录，mkdir 原子创建，谁先建成谁说了算）：
 * 替换脚本在确认旧进程已退出后、做任何改动（卸载任务、改名）之前先建它，建不成就中止、什么都不动；
 * 客户端到点没退出时也抢着建它，建成即确认本次脚本以后不会再替换，才可解除“更新中”。
 */
export const UPDATE_CLAIM = "claim";
/** 这两种中止发生在任何改动之前：脚本没碰系统任务、没改名、也没拉起应用。 */
export const UPDATE_NO_CHANGE_STAGES: readonly string[] = ["aborted_pid_alive", "aborted_cancelled"];
export const STAGING_PREFIX = ".Claw-Next-Client.update-";

/**
 * 旧暂存目录的清理（安装新版本前执行）：只删已经结束的。保留最近一次成功替换的目录（里面是可回滚的上一版）；
 * 回滚失败、进行中或状态不明的一律保留；没有替换记录的残留（下载中断等）超过 1 小时才删。
 */
export function stagingToRemove(dirs: { name: string; mtimeMs: number; last: string | null }[], nowMs: number): string[] {
  const ours = dirs.filter((d) => d.name.startsWith(STAGING_PREFIX));
  const done = ours.filter((d) => d.last === "done").sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keepDone = done[0]?.name;
  return ours
    .filter((d) => {
      if (d.last === null) return nowMs - d.mtimeMs > 3600_000;
      if (d.last === "done") return d.name !== keepDone;
      return d.last === "rolled_back" || d.last === "rolled_back_move_new" || d.last.startsWith("aborted_");
    })
    .map((d) => d.name);
}

/**
 * 替换脚本（macOS，bash）：只管理本客户端自己的固定路径与 LaunchAgent，不碰后台的 launchd 任务。
 * 1. 先等旧进程退出（托管启动时在退出前卸载任务会结束自己）；超时仍在就中止，不碰系统任务、不做任何改名；
 *    旧进程已退出后先建认领标记（见 UPDATE_CLAIM）；已被客户端抢先建成（本次更新已取消）就中止，同样什么都不动；
 * 2. 若本客户端的 LaunchAgent 已加载，卸载它（防止旧包在替换时被系统拉起；正常退出不会被重启）；
 * 3. 同卷改名：旧包 → 回滚副本，新包 → 原路径；第二步失败立即改回；
 * 4. 重新拉起（原来托管的重新加载任务并确认在运行，否则直接打开），等新包写出含本次运行序号的就绪标记；
 *    超时未就绪则结束新包、改回旧包并拉起旧包。
 * 每一步写阶段记录；始终保留一份可启动的旧包，不删除回滚副本。路径全部单引号转义。
 */
export function swapScript(o: {
  pid: number;
  app: string;
  newApp: string;
  backup: string;
  failed: string;
  stateFile: string;
  /** 认领标记路径（见 UPDATE_CLAIM）。 */
  claim: string;
  readyFile: string;
  run: number;
  domain: string;
  label: string;
  /** 当前设置对应的任务文件；没有则为 null（此时一律直接打开应用）。 */
  plist: string | null;
  userData?: string | null;
  launchctl?: string;
  open?: string;
  pkill?: string;
  waitTicks?: number;
  checkTicks?: number;
  readyTicks?: number;
  killWait?: number;
}): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const lc = q(o.launchctl ?? "/bin/launchctl");
  const op = q(o.open ?? "/usr/bin/open");
  const pk = q(o.pkill ?? "/usr/bin/pkill");
  const target = q(`${o.domain}/${o.label}`);
  const ud = o.userData ? ` --user-data ${q(o.userData)}` : "";
  return `#!/bin/bash
set -u
STATE=${q(o.stateFile)}
CLAIM=${q(o.claim)}
APP=${q(o.app)}
NEW=${q(o.newApp)}
BACKUP=${q(o.backup)}
FAILED=${q(o.failed)}
READY=${q(o.readyFile)}
PLIST=${q(o.plist ?? "")}
AGENT=0
log() { echo "$(date +%s) $1" >> "$STATE"; }
relaunch() {
  if [ "$AGENT" = 1 ] && [ -n "$PLIST" ] && [ -f "$PLIST" ]; then
    ${lc} bootstrap ${q(o.domain)} "$PLIST" >/dev/null 2>&1
    ${lc} kickstart ${target} >/dev/null 2>&1
    j=0; while [ $j -lt ${o.checkTicks ?? 30} ]; do ${lc} print ${target} 2>/dev/null | grep -q 'state = running' && return 0; sleep 0.5; j=$((j+1)); done
    ${op} -n "$APP" --args --no-handover${ud}
  else
    ${op} -n "$APP"${ud ? ` --args${ud}` : ""}
  fi
}
log start
i=0; while kill -0 ${o.pid} 2>/dev/null && [ $i -lt ${o.waitTicks ?? 600} ]; do sleep 0.1; i=$((i+1)); done
if kill -0 ${o.pid} 2>/dev/null; then log aborted_pid_alive; exit 1; fi
if ! mkdir "$CLAIM" 2>/dev/null; then log aborted_cancelled; exit 1; fi
if ${lc} print ${target} >/dev/null 2>&1; then AGENT=1; ${lc} bootout ${target} >/dev/null 2>&1; fi
log "agent=$AGENT"
if [ ! -d "$APP" ] || [ ! -d "$NEW" ] || [ -e "$BACKUP" ]; then log aborted_precondition; relaunch; exit 1; fi
if ! mv "$APP" "$BACKUP"; then log aborted_move_old; relaunch; exit 1; fi
log moved_old
if ! mv "$NEW" "$APP"; then
  if mv "$BACKUP" "$APP"; then log rolled_back_move_new; else log rollback_failed; fi
  relaunch; exit 1
fi
log moved_new
rm -f "$READY"
relaunch
i=0; while [ $i -lt ${o.readyTicks ?? 240} ]; do
  if [ -f "$READY" ] && grep -q '"run":${o.run}[,}]' "$READY"; then log done; exit 0; fi
  sleep 0.5; i=$((i+1))
done
log not_ready
if [ "$AGENT" = 1 ]; then ${lc} bootout ${target} >/dev/null 2>&1; fi
${pk} -TERM -f "$APP/Contents/MacOS/" >/dev/null 2>&1
sleep ${o.killWait ?? 3}
${pk} -KILL -f "$APP/Contents/MacOS/" >/dev/null 2>&1
if mv "$APP" "$FAILED" && mv "$BACKUP" "$APP"; then log rolled_back; else log rollback_failed; fi
relaunch
exit 1
`;
}

/** 安装失败原因的中文说明（界面显示）；未列出的原样显示代码。 */
const UPDATE_ERROR_TEXT: Record<string, string> = {
  EACCES: "没有写入“应用程序”文件夹的权限",
  EPERM: "没有写入“应用程序”文件夹的权限",
  EROFS: "“应用程序”文件夹不可写",
  ENOSPC: "磁盘空间不足",
  EDQUOT: "磁盘空间不足",
  timeout: "下载超时",
  too_large: "下载内容超过上限",
  redirect_invalid: "下载地址跳转异常",
  url_host: "下载地址不在允许范围内",
  url_path: "下载地址不属于本仓库的发布",
  url_not_https: "下载地址不是 HTTPS",
  digest_file_invalid: "校验文件格式不对",
  zip_digest_mismatch: "下载的文件与校验值不一致（可能下载中断）",
  zip_unsafe_path: "安装包含有不安全的路径",
  zip_duplicate: "安装包含有重复条目",
  zip_unexpected_root: "安装包结构不对",
  zip_entry_under_symlink: "安装包含有经链接写到包外的条目",
  zip_too_large: "安装包解压后过大",
  zip_too_many_entries: "安装包条目过多",
  extract_unexpected_root: "解压结果结构不对",
  extract_absolute_symlink: "解压结果含有指向包外的链接",
  extract_symlink_escapes: "解压结果含有指向包外的链接",
  extract_symlink_loop: "解压结果含有循环的链接",
  extract_symlink_dangling: "解压结果含有指向不存在位置的链接",
  extract_special_file: "解压结果含有特殊文件",
  bundle_id_mismatch: "新版本的应用标识不对",
  build_info_mismatch: "新版本的构建信息与发布不一致",
  codesign_failed: "新版本的完整性校验没通过",
  extract_failed: "解压失败",
  tasks_not_idle: "有进行中的发送或还没上传完的回执，等了 1 分钟仍未结束",
  launch_failed: "替换程序没能启动",
  staging_other_volume: "暂存目录与应用不在同一磁盘",
};

export function updateErrorText(code: string): string {
  const text = UPDATE_ERROR_TEXT[code] ?? (code.startsWith("http_") ? `下载失败（HTTP ${code.slice(5)}）` : null);
  return text ? `${text}（${code}）` : code;
}
