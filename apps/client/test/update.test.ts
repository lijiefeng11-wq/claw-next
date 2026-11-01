import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
  APP_BUNDLE,
  MAX_ZIP_ENTRIES,
  STAGING_PREFIX,
  checkUpdateUrl,
  listZipEntries,
  parseBuildInfo,
  parseDigestFile,
  selectUpdate,
  stagingToRemove,
  swapScript,
  validateExtractedTree,
  validateZipEntries,
} from "../src/core/update.js";
import { IPC_CHANNELS, validateIpc } from "../src/core/ipc.js";

// 客户端“检查更新”（#34）的纯判定与替换脚本：全部为虚构版本、虚构文件与本机假命令，不联网、不碰真实应用。

const SHA = (c: string) => c.repeat(40);
const OWN = { sha: SHA("a"), run: 100, platform: "darwin", arch: "arm64" };
const ZIP = "Claw-Next-Client-darwin-arm64.zip";
const rel = (run: number, sha: string, over: Record<string, unknown> = {}) => ({
  tag_name: `client-${run}-${sha}`,
  draft: false,
  prerelease: true,
  assets: [
    { id: run * 10, name: ZIP, size: 1000, browser_download_url: `https://github.com/lijiefeng11-wq/claw-next/releases/download/client-${run}-${sha}/${ZIP}` },
    { id: run * 10 + 1, name: `${ZIP}.sha256`, size: 100, browser_download_url: `https://github.com/lijiefeng11-wq/claw-next/releases/download/client-${run}-${sha}/${ZIP}.sha256` },
  ],
  ...over,
});

describe("界面通道", () => {
  test("检查更新与安装更新只接受空参数（不接受地址、路径等任何字段）", () => {
    for (const ch of ["app:checkUpdate", "app:installUpdate"] as const) {
      assert.ok(IPC_CHANNELS.includes(ch));
      assert.deepEqual(validateIpc(ch, undefined), { channel: ch });
      assert.deepEqual(validateIpc(ch, {}), { channel: ch });
      assert.throws(() => validateIpc(ch, { url: "https://evil.example/x.zip" }), /unexpected_field:url/);
      assert.throws(() => validateIpc(ch, { path: "/tmp/x" }), /unexpected_field:path/);
    }
  });
});

describe("构建信息", () => {
  test("合法时返回；本机打包（null）或格式不对时为 null（不提供检查更新）", () => {
    assert.deepEqual(parseBuildInfo(OWN), OWN);
    for (const bad of [{ ...OWN, sha: null, run: null }, { ...OWN, sha: "abc" }, { ...OWN, run: 0 }, { ...OWN, run: 1.5 }, { ...OWN, sha: SHA("A") }, null, [], "x"]) assert.equal(parseBuildInfo(bad), null);
  });
});

describe("选版本", () => {
  test("只取运行序号更大的、非草稿、资产齐全的最大者", () => {
    const r = selectUpdate(OWN, [rel(99, SHA("b")), rel(101, SHA("c")), rel(105, SHA("d")), rel(103, SHA("e"))]);
    assert.equal(r.kind, "candidate");
    assert.equal(r.kind === "candidate" && r.candidate.run, 105);
    assert.equal(r.kind === "candidate" && r.candidate.sha, SHA("d"));
  });

  test("历史版本、同版本、草稿、tag 格式不对、缺资产或资产重复、别的架构：都不算", () => {
    for (const r of [
      rel(100, SHA("b")),
      rel(90, SHA("b")),
      rel(120, SHA("b"), { draft: true }),
      rel(120, SHA("b"), { tag_name: `client-120-${SHA("b").slice(0, 7)}` }),
      rel(120, SHA("b"), { tag_name: `v120` }),
      rel(120, SHA("b"), { assets: [] }),
      rel(120, SHA("b"), { assets: [rel(120, SHA("b")).assets[0]] }),
      rel(120, SHA("b"), { assets: [...rel(120, SHA("b")).assets, rel(120, SHA("b")).assets[0]] }),
      rel(120, SHA("b"), { assets: rel(120, SHA("b")).assets.map((a) => ({ ...a, name: a.name.replace("arm64", "x64") })) }),
    ]) {
      assert.deepEqual(selectUpdate(OWN, [r]), { kind: "none" }, JSON.stringify(r).slice(0, 80));
    }
  });

  test("最大序号对应多个发布：歧义，不升级", () => {
    assert.deepEqual(selectUpdate(OWN, [rel(110, SHA("b")), rel(110, SHA("c")), rel(105, SHA("d"))]), { kind: "ambiguous", run: 110 });
  });
});

describe("地址核对（每一跳）", () => {
  const tag = `client-105-${SHA("d")}`;
  test("允许：本仓库 API、本 tag 的发布文件、发布文件实际跳转的主机", () => {
    for (const u of [
      `https://api.github.com/repos/lijiefeng11-wq/claw-next/releases?per_page=100&page=1`,
      `https://github.com/lijiefeng11-wq/claw-next/releases/download/${tag}/${ZIP}`,
      `https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sig=x`,
      `https://github.com:443/lijiefeng11-wq/claw-next/releases/download/${tag}/${ZIP}`,
    ]) assert.equal(checkUpdateUrl(u, tag), null, u);
  });
  test("拒绝：非 HTTPS、非标准端口、带用户信息、其他主机、其他仓库或其他 tag", () => {
    for (const [u, why] of [
      [`http://github.com/lijiefeng11-wq/claw-next/releases/download/${tag}/${ZIP}`, "url_not_https"],
      [`https://github.com:8443/lijiefeng11-wq/claw-next/releases/download/${tag}/${ZIP}`, "url_port"],
      [`https://user:pw@github.com/lijiefeng11-wq/claw-next/releases/download/${tag}/${ZIP}`, "url_userinfo"],
      [`https://evil.example/x`, "url_host"],
      [`https://github.com.evil.example/x`, "url_host"],
      [`https://github.com/other/claw-next/releases/download/${tag}/${ZIP}`, "url_path"],
      [`https://github.com/lijiefeng11-wq/claw-next/releases/download/client-1-${SHA("f")}/${ZIP}`, "url_path"],
      [`https://api.github.com/repos/other/x/releases`, "url_path"],
      [`not a url`, "url_invalid"],
    ]) assert.equal(checkUpdateUrl(u, tag), why, u);
  });
});

describe("sha256 文件", () => {
  test("须是 64 位十六进制加本 zip 文件名", () => {
    const h = "0".repeat(63) + "f";
    assert.equal(parseDigestFile(`${h}  ${ZIP}\n`, ZIP), h);
    assert.equal(parseDigestFile(`${h} *${ZIP}`, ZIP), h);
    for (const t of [`${h}  other.zip`, `${h.slice(1)}  ${ZIP}`, `${h.toUpperCase()}  ${ZIP}`, ``, `${h}`]) assert.equal(parseDigestFile(t, ZIP), null, t);
  });
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;
function makeZip(entries: { name: string; data?: string; link?: boolean }[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-upd-zip-"));
  const file = path.join(dir, "t.zip");
  const code = `import sys,json,zipfile
with zipfile.ZipFile(sys.argv[1],'w') as z:
  for e in json.loads(sys.argv[2]):
    i=zipfile.ZipInfo(e['name'])
    i.filename=e['name']
    i.external_attr=((0o120777 if e.get('link') else (0o40755 if e['name'].endswith('/') else 0o100644))<<16)
    z.writestr(i,e.get('data',''))`;
  const r = spawnSync("python3", ["-I", "-c", code, file, JSON.stringify(entries)]);
  assert.equal(r.status, 0, String(r.stderr));
  return file;
}

describe("zip 条目核对（解压前）", { skip: !hasPython }, () => {
  const app = (p: string) => `${APP_BUNDLE}/${p}`;
  test("正常包（含 __MACOSX 属性、包内相对链接）通过", () => {
    const z = makeZip([{ name: app("Contents/Info.plist"), data: "x" }, { name: app("Contents/Frameworks/A.framework/Current"), data: "A", link: true }, { name: `__MACOSX/${APP_BUNDLE}/._Info.plist` }]);
    const e = listZipEntries(z);
    assert.equal(e.length, 3);
    assert.equal((e[1].mode & 0o170000) === 0o120000, true);
    assert.equal(validateZipEntries(e), null);
  });
  test("路径穿越、绝对路径、反斜杠、重复、其他根、经链接写入：都拒绝", () => {
    for (const [entries, why] of [
      [[{ name: app("../x") }], "zip_unsafe_path"],
      [[{ name: "/abs" }], "zip_unsafe_path"],
      [[{ name: app("a\\b") }], "zip_unsafe_path"],
      [[{ name: app("a") }, { name: app("a") }], "zip_duplicate"],
      [[{ name: app("a/") }, { name: app("a") }], "zip_duplicate"],
      [[{ name: app("a") }, { name: "evil/x" }], "zip_unexpected_root"],
      [[{ name: app("a") }, { name: "__MACOSX/other/x" }], "zip_unexpected_root"],
      [[{ name: app("Contents/link"), data: "../../..", link: true }, { name: app("Contents/link/escape") }], "zip_entry_under_symlink"],
    ] as const) {
      assert.equal(validateZipEntries(listZipEntries(makeZip(entries as unknown as { name: string }[]))), why, JSON.stringify(entries));
    }
  });
  test("条目数与解压后大小有上限；结构坏的 zip 抛错", () => {
    assert.equal(validateZipEntries(Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: app(`f${i}`), size: 1, mode: 0o100644 }))), "zip_too_many_entries");
    assert.equal(validateZipEntries([{ name: app("big"), size: 2 * 1024 ** 3, mode: 0o100644 }]), "zip_too_large");
    const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claw-upd-bad-")), "x.zip");
    fs.writeFileSync(bad, "not a zip");
    assert.throws(() => listZipEntries(bad), /zip_no_eocd/);
  });
});

describe("解压后目录核对", () => {
  const tree = (build: (app: string, root: string) => void) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claw-upd-tree-"));
    const app = path.join(root, APP_BUNDLE);
    fs.mkdirSync(path.join(app, "Contents", "Frameworks", "A.framework", "Versions", "A"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents", "Info.plist"), "x");
    build(app, root);
    return root;
  };
  test("包内相对链接通过", () => {
    assert.equal(validateExtractedTree(tree((app) => fs.symlinkSync("A", path.join(app, "Contents", "Frameworks", "A.framework", "Versions", "Current")))), null);
  });
  test("根下多余文件、绝对链接、指向包外的相对链接：拒绝", () => {
    assert.equal(validateExtractedTree(tree((_a, root) => fs.writeFileSync(path.join(root, "extra"), "x"))), "extract_unexpected_root");
    assert.equal(validateExtractedTree(tree((app) => fs.symlinkSync("/etc", path.join(app, "Contents", "abs")))), "extract_absolute_symlink");
    assert.equal(validateExtractedTree(tree((app) => fs.symlinkSync("../../..", path.join(app, "Contents", "up")))), "extract_symlink_escapes");
  });
});

describe("旧暂存目录清理", () => {
  test("只删已结束的：保留最近一次成功的；回滚失败、进行中保留；无记录的残留超过 1 小时才删", () => {
    const now = 10_000_000;
    const d = (n: string, last: string | null, age: number) => ({ name: STAGING_PREFIX + n, mtimeMs: now - age, last });
    const r = stagingToRemove([d("1", "done", 5000), d("2", "done", 1000), d("3", "rolled_back", 100), d("4", "aborted_pid_alive", 100), d("5", "rollback_failed", 100), d("6", "moved_old", 100), d("7", null, 100), d("8", null, 7200_000), { name: "Other.app", mtimeMs: 0, last: "done" }], now);
    assert.deepEqual(r.sort(), [STAGING_PREFIX + "1", STAGING_PREFIX + "3", STAGING_PREFIX + "4", STAGING_PREFIX + "8"].sort());
  });
});

// 替换脚本：真实 bash + 临时目录（路径含空格与单引号）+ 假 launchctl / open / pkill（记录调用，不碰系统）。仅 POSIX。
describe("替换脚本", { skip: process.platform === "win32" }, () => {
  type Opts = {
    /** 开始时本客户端任务已加载。 */
    agentLoaded?: boolean;
    /** 任务文件存在。 */
    plistExists?: boolean;
    /** bootstrap 后任务是否真的运行起来。 */
    agentStarts?: boolean;
    /** 由任务 / open 拉起的应用写出的就绪标记里的运行序号；null 表示起不来（不写）。 */
    readyRun?: number | null;
    holdPid?: boolean;
    newMissing?: boolean;
    backupExists?: boolean;
    userData?: string | null;
  };
  function setup(o: Opts) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claw upd 'swap-"));
    const bin = path.join(root, "bin");
    const st = path.join(root, "launchd");
    fs.mkdirSync(bin);
    fs.mkdirSync(st);
    const calls = path.join(root, "calls.log");
    const ready = path.join(root, "user data", "update", "ready.json");
    fs.mkdirSync(path.dirname(ready), { recursive: true });
    const plist = path.join(root, "agent.plist");
    if (o.plistExists !== false) fs.writeFileSync(plist, "<plist/>");
    if (o.agentLoaded) fs.writeFileSync(path.join(st, "loaded"), "");
    const writeReady = o.readyRun == null ? ":" : `echo '{"run":${o.readyRun},"pid":2,"at":1}' > "$READY"`;
    const fake = (name: string, body: string) => {
      const file = path.join(bin, name);
      fs.writeFileSync(file, `#!/bin/bash\nST=${JSON.stringify(st)}\nREADY=${JSON.stringify(ready)}\necho "${name} $*" >> ${JSON.stringify(calls)}\n${body}\n`, { mode: 0o755 });
      return file;
    };
    const launchctl = fake(
      "launchctl",
      `case "$1" in
  print) [ -f "$ST/loaded" ] || exit 113; [ -f "$ST/running" ] && echo "state = running"; exit 0;;
  bootout) rm -f "$ST/loaded" "$ST/running"; exit 0;;
  bootstrap) [ -f "$3" ] || exit 5; touch "$ST/loaded"; ${o.agentStarts === false ? ":" : `touch "$ST/running"; ${writeReady}`}; exit 0;;
  kickstart) exit 0;;
esac`,
    );
    const open = fake("open", `${writeReady}; exit 0`);
    const pkill = fake("pkill", "exit 0");
    const apps = path.join(root, "Applications");
    const app = path.join(apps, APP_BUNDLE);
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "version"), "old");
    const staging = path.join(apps, `${STAGING_PREFIX}105-x`);
    const newApp = path.join(staging, "extract", APP_BUNDLE);
    fs.mkdirSync(path.join(staging, "extract"), { recursive: true });
    if (!o.newMissing) {
      fs.mkdirSync(newApp);
      fs.writeFileSync(path.join(newApp, "version"), "new");
    }
    if (o.backupExists) fs.mkdirSync(path.join(staging, "previous.app"));
    const holder = o.holdPid ? spawnSync("bash", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).stdout.trim() : "999999";
    const script = swapScript({
      pid: Number(holder),
      app,
      newApp,
      backup: path.join(staging, "previous.app"),
      failed: path.join(staging, "failed.app"),
      stateFile: path.join(staging, "swap.log"),
      readyFile: ready,
      run: 105,
      domain: "gui/501",
      label: "com.claw-next.client",
      plist,
      userData: o.userData ?? null,
      launchctl,
      open,
      pkill,
      waitTicks: 5,
      checkTicks: 3,
      readyTicks: 4,
      killWait: 0,
    });
    const file = path.join(staging, "swap.sh");
    fs.writeFileSync(file, script, { mode: 0o700 });
    return {
      run: () => spawnSync("bash", [file], { encoding: "utf8", timeout: 30_000 }),
      stages: () => fs.readFileSync(path.join(staging, "swap.log"), "utf8").trim().split("\n").map((l) => l.split(" ")[1]),
      log: () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : ""),
      version: (p: string) => (fs.existsSync(path.join(p, "version")) ? fs.readFileSync(path.join(p, "version"), "utf8") : null),
      kill: () => {
        try {
          process.kill(Number(holder));
        } catch {
          // 已退出。
        }
      },
      app,
      apps,
      staging,
    };
  }

  test("托管启动：先等旧进程退出再卸载任务，改名切换后重新加载任务，新版本就绪即完成，保留旧版本副本", () => {
    const h = setup({ agentLoaded: true, readyRun: 105 });
    const r = h.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(h.stages(), ["start", "agent=1", "moved_old", "moved_new", "done"]);
    assert.equal(h.version(h.app), "new");
    assert.equal(h.version(path.join(h.staging, "previous.app")), "old");
    const lines = h.log().trim().split("\n");
    assert.match(lines[0], /^launchctl print gui\/501\/com\.claw-next\.client$/);
    assert.match(lines[1], /^launchctl bootout gui\/501\/com\.claw-next\.client$/);
    assert.match(lines[2], /^launchctl bootstrap gui\/501 .*agent\.plist$/);
    assert.doesNotMatch(h.log(), /^open /m);
    assert.doesNotMatch(h.log(), /backend/);
  });

  test("未托管：直接打开新版本（带自定义数据目录，路径正确转义）", () => {
    const ud = path.join(os.tmpdir(), "it's data");
    const h = setup({ readyRun: 105, userData: ud });
    assert.equal(h.run().status, 0);
    assert.equal(h.version(h.app), "new");
    assert.ok(h.log().includes(`open -n ${h.app} --args --user-data ${ud}`), h.log());
    assert.doesNotMatch(h.log(), /bootout|bootstrap/);
  });

  test("托管但任务文件已不在：按普通方式打开（由客户端自己按设置重建任务）", () => {
    const h = setup({ agentLoaded: true, plistExists: false, readyRun: 105 });
    assert.equal(h.run().status, 0);
    assert.ok(h.log().split("\n").includes(`open -n ${h.app}`), h.log());
    assert.doesNotMatch(h.log(), /bootstrap/);
  });

  test("托管任务加载后没运行起来：改为直接打开", () => {
    const h = setup({ agentLoaded: true, agentStarts: false, readyRun: 105 });
    assert.equal(h.run().status, 0);
    assert.match(h.log(), /launchctl bootstrap/);
    assert.ok(h.log().includes(`open -n ${h.app} --args --no-handover`), h.log());
    assert.equal(h.version(h.app), "new");
  });

  test("旧进程超时仍在：中止，不碰系统任务、不做任何改名", () => {
    const h = setup({ agentLoaded: true, holdPid: true, readyRun: 105 });
    try {
      const r = h.run();
      assert.equal(r.status, 1);
      assert.deepEqual(h.stages(), ["start", "aborted_pid_alive"]);
      assert.equal(h.version(h.app), "old");
      assert.equal(fs.existsSync(path.join(h.staging, "previous.app")), false);
      assert.equal(h.log(), "");
    } finally {
      h.kill();
    }
  });

  test("新版本缺失：前置条件不满足，中止并拉起原版本", () => {
    const h = setup({ newMissing: true, readyRun: 104 });
    assert.equal(h.run().status, 1);
    assert.deepEqual(h.stages(), ["start", "agent=0", "aborted_precondition"]);
    assert.equal(h.version(h.app), "old");
    assert.match(h.log(), /^open -n /m);
  });

  test("回滚副本位置已被占用（例如另一次更新留下的）：中止，不覆盖", () => {
    const h = setup({ backupExists: true, readyRun: 104 });
    assert.equal(h.run().status, 1);
    assert.deepEqual(h.stages(), ["start", "agent=0", "aborted_precondition"]);
    assert.equal(h.version(h.app), "old");
  });

  test("新版本未就绪（例如被系统拦截打不开）：结束新版本、换回旧版本并重新拉起", () => {
    const h = setup({ agentLoaded: true, readyRun: null });
    const r = h.run();
    assert.equal(r.status, 1);
    assert.deepEqual(h.stages(), ["start", "agent=1", "moved_old", "moved_new", "not_ready", "rolled_back"]);
    assert.equal(h.version(h.app), "old");
    assert.equal(h.version(path.join(h.staging, "failed.app")), "new");
    assert.ok(h.log().includes(`pkill -TERM -f ${h.app}/Contents/MacOS/`), h.log());
    // 回滚后重新加载任务拉起旧版本。
    assert.equal(h.log().match(/launchctl bootstrap/g)?.length, 2);
  });

  test("就绪标记是别的版本写的（运行序号不符）：按未就绪回滚", () => {
    const h = setup({ readyRun: 1050 });
    assert.equal(h.run().status, 1);
    assert.equal(h.version(h.app), "old");
    assert.equal(h.stages().at(-1), "rolled_back");
  });

  test("没有写入应用所在文件夹的权限：改名失败即中止，原版本不动并重新拉起", { skip: process.getuid?.() === 0 ? "root 不受目录权限限制" : false }, () => {
    const h = setup({ readyRun: 104 });
    fs.chmodSync(h.apps, 0o555);
    try {
      assert.equal(h.run().status, 1);
      assert.deepEqual(h.stages(), ["start", "agent=0", "aborted_move_old"]);
      assert.equal(h.version(h.app), "old");
      assert.match(h.log(), /^open -n /m);
    } finally {
      fs.chmodSync(h.apps, 0o755);
    }
  });
});
