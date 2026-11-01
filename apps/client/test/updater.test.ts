import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import { APP_BUNDLE, BUNDLE_ID, STAGING_PREFIX, UPDATE_REPO, zipName } from "../src/core/update.js";
import { Requester, UpdateHost, Updater, cleanupStaging, httpGet } from "../src/main/updater.js";

// 客户端“检查更新”的下载、校验、解压与安装前流程（#34 条件 6）：全部为虚构版本、虚构发布与脚本化的假网络，
// 系统命令（ditto / plutil / codesign）与启动替换脚本都用替身；不联网、不改真实应用、不运行替换脚本。

const SHA = (c: string) => c.repeat(40);
const OWN = { sha: SHA("a"), run: 100, platform: "darwin", arch: "arm64" };
const NEW_SHA = SHA("d");
const ZIP = zipName("arm64");
const TAG = `client-105-${NEW_SHA}`;
const API = `https://api.github.com/repos/${UPDATE_REPO}`;
const DL = `https://github.com/${UPDATE_REPO}/releases/download/${TAG}`;
const ASSETS = "https://release-assets.githubusercontent.com/github-production-release-asset";

type Route = { status: number; location?: string; body?: Buffer | string; headers?: Record<string, string>; partial?: boolean };

/** 脚本化的 https.get：按完整地址返回预设响应；记录每一跳请求的地址。 */
function fakeRequester(routes: Record<string, Route>, seen: string[]): Requester {
  return ((url: string, _opts: unknown, cb: (res: any) => void) => {
    seen.push(url);
    const req = new EventEmitter() as any;
    req.destroy = (err?: Error) => {
      if (err) setImmediate(() => req.emit("error", err));
      return req;
    };
    setImmediate(() => {
      const r = routes[url];
      if (!r) return req.emit("error", Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
      const res = new PassThrough() as any;
      res.statusCode = r.status;
      res.headers = { ...(r.location ? { location: r.location } : {}), ...(r.headers ?? {}) };
      res.complete = false;
      cb(res);
      const body = Buffer.from(r.body ?? "");
      if (r.partial) {
        res.write(body.subarray(0, Math.floor(body.length / 2)));
        setImmediate(() => res.destroy());
        return;
      }
      res.complete = true;
      res.end(body);
    });
    return req;
  }) as unknown as Requester;
}

function makeZip(entries: { name: string; data?: string; link?: boolean }[]): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-updater-zip-"));
  const file = path.join(dir, "t.zip");
  const code = `import sys,json,zipfile
with zipfile.ZipFile(sys.argv[1],'w') as z:
  for e in json.loads(sys.argv[2]):
    i=zipfile.ZipInfo(e['name'])
    i.external_attr=((0o120777 if e.get('link') else (0o40755 if e['name'].endswith('/') else 0o100644))<<16)
    z.writestr(i,e.get('data',''))`;
  const r = spawnSync("python3", ["-I", "-c", code, file, JSON.stringify(entries)]);
  assert.equal(r.status, 0, String(r.stderr));
  return fs.readFileSync(file);
}

const goodEntries = (info: Record<string, unknown> = {}) => [
  { name: `${APP_BUNDLE}/Contents/Info.plist`, data: "<plist/>" },
  { name: `${APP_BUNDLE}/Contents/Resources/build-info.json`, data: JSON.stringify({ sha: NEW_SHA, run: 105, platform: "darwin", arch: "arm64", ...info }) },
  { name: `${APP_BUNDLE}/Contents/MacOS/Claw-Next-Client`, data: "bin" },
];
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function release(run: number, sha: string, zipSize: number) {
  const tag = `client-${run}-${sha}`;
  const url = `https://github.com/${UPDATE_REPO}/releases/download/${tag}`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: true,
    assets: [
      { id: run * 10, name: ZIP, size: zipSize, browser_download_url: `${url}/${ZIP}` },
      { id: run * 10 + 1, name: `${ZIP}.sha256`, size: 100, browser_download_url: `${url}/${ZIP}.sha256` },
    ],
  };
}

type Fixture = {
  root: string;
  apps: string;
  app: string;
  seen: string[];
  ran: string[][];
  launched: string[];
  host: UpdateHost & { calls: string[] };
  updater: Updater;
  stagingDirs(): string[];
};

function fixture(o: {
  zip?: Buffer;
  digest?: string;
  releases?: unknown[];
  compare?: string;
  routes?: (r: Record<string, Route>, zip: Buffer) => void;
  idle?: () => boolean;
  run?: (file: string, args: string[]) => string | undefined;
  launch?: (file: string) => Promise<void>;
  deps?: Partial<ConstructorParameters<typeof Updater>[0]>;
} = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claw-updater-"));
  const apps = path.join(root, "Applications");
  const app = path.join(apps, APP_BUNDLE);
  fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(app, "version"), "old");
  const zip = o.zip ?? makeZip(goodEntries());
  const routes: Record<string, Route> = {
    [`${API}/releases?per_page=100&page=1`]: { status: 200, body: JSON.stringify(o.releases ?? [release(105, NEW_SHA, zip.length), release(99, SHA("b"), 10)]) },
    [`${API}/compare/${OWN.sha}...${NEW_SHA}`]: { status: 200, body: JSON.stringify({ status: o.compare ?? "ahead" }) },
    [`${DL}/${ZIP}.sha256`]: { status: 302, location: `${ASSETS}/1/digest?sig=x` },
    [`${ASSETS}/1/digest?sig=x`]: { status: 200, body: o.digest ?? `${sha256(zip)}  ${ZIP}\n` },
    [`${DL}/${ZIP}`]: { status: 302, location: `${ASSETS}/1/zip?sig=y` },
    [`${ASSETS}/1/zip?sig=y`]: { status: 200, body: zip, headers: { "content-length": String(zip.length) } },
  };
  o.routes?.(routes, zip);
  const seen: string[] = [];
  const ran: string[][] = [];
  const launched: string[] = [];
  const calls: string[] = [];
  const host = {
    calls,
    setUpdateHold: (on: boolean) => void calls.push(`hold:${on}`),
    allIdleForUpdate: () => {
      calls.push("idle?");
      return o.idle ? o.idle() : true;
    },
    quit: () => void calls.push("quit"),
  };
  const updater = new Updater({
    packaged: true,
    platform: "darwin",
    current: OWN,
    appPath: app,
    userData: path.join(root, "user data"),
    userDataArg: null,
    uid: 501,
    locationOk: () => true,
    agentPlist: () => null,
    onChange: () => undefined,
    request: fakeRequester(routes, seen),
    run: (file, args) => {
      ran.push([path.basename(file), ...args]);
      const custom = o.run?.(file, args);
      if (custom !== undefined) return custom;
      if (file.endsWith("ditto")) {
        const r = spawnSync("python3", ["-I", "-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", args[2], args[3]]);
        if (r.status !== 0) throw new Error("ditto failed");
        return "";
      }
      if (file.endsWith("plutil")) return `${BUNDLE_ID}\n`;
      return "";
    },
    launch:
      o.launch ??
      (async (file) => {
        launched.push(file);
      }),
    timing: { idleWaitMs: 300, idlePollMs: 20, quitWatchMs: 200 },
    limits: { apiMs: 3000, idleMs: 3000, totalMs: 5000 },
    ...o.deps,
  });
  return { root, apps, app, seen, ran, launched, host, updater, stagingDirs: () => fs.readdirSync(apps).filter((n) => n.startsWith(STAGING_PREFIX)) };
}

async function ready(f: Fixture) {
  const v = await f.updater.check();
  assert.equal(v.state, "available", v.detail);
  return f;
}

function assertUntouched(f: Fixture) {
  assert.equal(fs.readFileSync(path.join(f.app, "version"), "utf8"), "old");
  assert.deepEqual(fs.readdirSync(f.apps), [APP_BUNDLE]);
  assert.equal(f.launched.length, 0);
  assert.equal(f.host.calls.includes("quit"), false);
}

describe("检查：只认后续版本", () => {
  test("有更新的后续版本：可安装，只读公开接口", async () => {
    const f = fixture();
    const v = await f.updater.check();
    assert.equal(v.state, "available");
    assert.deepEqual(v.candidate, { run: 105, sha: NEW_SHA.slice(0, 7) });
    assert.ok(f.seen.every((u) => u.startsWith(`${API}/`)));
  });

  test("只有历史版本或同版本：已是最新", async () => {
    const f = fixture({ releases: [release(100, OWN.sha, 10), release(90, SHA("b"), 10)] });
    assert.equal((await f.updater.check()).state, "latest");
    await assert.rejects(f.updater.install(f.host), /update_not_available/);
  });

  test("运行序号更大但不是当前提交的后续（落后或分叉）：不更新", async () => {
    for (const status of ["behind", "diverged", "identical"]) {
      const f = fixture({ compare: status });
      const v = await f.updater.check();
      assert.equal(v.state, "error");
      assert.equal(v.candidate, null);
      await assert.rejects(f.updater.install(f.host), /update_not_available/);
    }
  });

  test("最大序号有两个发布：歧义，不更新", async () => {
    const f = fixture({ releases: [release(110, SHA("b"), 10), release(110, SHA("c"), 10)] });
    const v = await f.updater.check();
    assert.equal(v.state, "error");
    assert.match(v.detail, /多个发布/);
  });

  test("不是 Mac 正式版本、不在“应用程序”文件夹、没有构建信息：不提供", async () => {
    for (const deps of [{ packaged: false }, { platform: "win32" as const }, { current: null }, { locationOk: () => false }]) {
      const f = fixture({ deps });
      assert.equal(f.updater.view().supported, false);
      await assert.rejects(f.updater.check(), /update_not_supported/);
    }
  });
});

describe("安装：下载与核对失败都不动现有应用", () => {
  test("正常：经允许的跳转下载、核对、解压到同卷暂存目录；先进入更新中再等任务；启动替换脚本后退出", async () => {
    const f = await ready(fixture());
    const v = await f.updater.install(f.host);
    assert.equal(v.state, "installing", v.detail);
    assert.ok(f.seen.includes(`${ASSETS}/1/zip?sig=y`));
    assert.deepEqual(f.host.calls.slice(0, 2), ["hold:true", "idle?"]);
    assert.equal(f.host.calls.at(-1), "quit");
    assert.deepEqual(
      f.ran.map((r) => r[0]),
      ["ditto", "plutil", "codesign"],
    );
    assert.equal(f.launched.length, 1);
    const [dir] = f.stagingDirs();
    assert.ok(f.launched[0].startsWith(path.join(f.apps, dir)));
    assert.equal(fs.statSync(f.launched[0]).mode & 0o777, 0o700);
    const script = fs.readFileSync(f.launched[0], "utf8");
    assert.ok(script.includes(`APP='${f.app}'`));
    assert.ok(script.includes(`'"run":105[,}]'`));
    assert.ok(fs.existsSync(path.join(f.apps, dir, "extract", APP_BUNDLE, "Contents", "Info.plist")));
    assert.equal(fs.existsSync(path.join(f.apps, dir, ZIP)), false, "解压后删除 zip");
    assert.equal(fs.readFileSync(path.join(f.app, "version"), "utf8"), "old", "改名由脚本在进程退出后进行");
    await assert.rejects(f.updater.install(f.host), /update_busy/, "脚本已启动后不再允许第二次安装");
  });

  const failures: [string, Parameters<typeof fixture>[0], RegExp][] = [
    ["跳转到不允许的主机", { routes: (r) => (r[`${DL}/${ZIP}`] = { status: 302, location: "https://evil.example/zip" }) }, /url_host/],
    ["跳转降级为 HTTP", { routes: (r) => (r[`${DL}/${ZIP}`] = { status: 302, location: `http://release-assets.githubusercontent.com/x` }) }, /url_not_https/],
    ["跳转到别的 tag", { routes: (r) => (r[`${DL}/${ZIP}`] = { status: 302, location: `https://github.com/${UPDATE_REPO}/releases/download/client-1-${SHA("f")}/${ZIP}` }) }, /url_path/],
    [
      "跳转超过 5 次",
      {
        routes: (r) => {
          r[`${DL}/${ZIP}`] = { status: 302, location: `${ASSETS}/loop?0` };
          for (let i = 0; i < 6; i++) r[`${ASSETS}/loop?${i}`] = { status: 302, location: `${ASSETS}/loop?${i + 1}` };
        },
      },
      /redirect_invalid/,
    ],
    ["下载中途断开", { routes: (r, zip) => (r[`${ASSETS}/1/zip?sig=y`] = { status: 200, body: zip, partial: true }) }, /download_interrupted/],
    ["下载返回错误", { routes: (r) => (r[`${ASSETS}/1/zip?sig=y`] = { status: 503 }) }, /HTTP 503/],
    ["声明大小超过发布登记的大小", { routes: (r, zip) => (r[`${ASSETS}/1/zip?sig=y`] = { status: 200, body: zip, headers: { "content-length": String(zip.length + 1) } }) }, /too_large/],
    ["实际内容超过发布登记的大小", { routes: (r, zip) => (r[`${ASSETS}/1/zip?sig=y`] = { status: 200, body: Buffer.concat([zip, Buffer.from("x")]) }) }, /too_large/],
    ["校验值不符", { digest: `${"0".repeat(64)}  ${ZIP}\n` }, /zip_digest_mismatch/],
    ["校验文件格式不对", { digest: "not a digest" }, /digest_file_invalid/],
    ["校验文件下载失败", { routes: (r) => delete r[`${ASSETS}/1/digest?sig=x`] }, /ECONNREFUSED/],
    ["归档含路径穿越", { zip: makeZip([...goodEntries(), { name: `${APP_BUNDLE}/../evil` }]) }, /zip_unsafe_path/],
    ["归档根下有别的东西", { zip: makeZip([...goodEntries(), { name: "Other.app/x" }]) }, /zip_unexpected_root/],
    ["归档经链接写到包外", { zip: makeZip([...goodEntries(), { name: `${APP_BUNDLE}/Contents/l`, data: "../../..", link: true }, { name: `${APP_BUNDLE}/Contents/l/x` }]) }, /zip_entry_under_symlink/],
    ["归档不是 zip", { zip: Buffer.from("not a zip at all") }, /zip_no_eocd/],
    ["构建信息与发布不一致", { zip: makeZip(goodEntries({ sha: SHA("e") })) }, /build_info_mismatch/],
    ["构建信息架构不对", { zip: makeZip(goodEntries({ arch: "x64" })) }, /build_info_mismatch/],
    ["应用标识不对", { run: (f) => (f.endsWith("plutil") ? "com.example.other\n" : undefined) }, /bundle_id_mismatch/],
    [
      "完整性校验（codesign）没通过",
      {
        run: (f) => {
          if (f.endsWith("codesign")) throw new Error("invalid signature");
          return undefined;
        },
      },
      /codesign_failed/,
    ],
    [
      "解压失败（例如磁盘满）",
      {
        run: (f) => {
          if (f.endsWith("ditto")) throw new Error("ditto: No space left on device");
          return undefined;
        },
      },
      /extract_failed/,
    ],
  ];
  for (const [name, opts, re] of failures) {
    test(`${name}：报错，不进入更新中，删除暂存目录`, async () => {
      const f = await ready(fixture(opts));
      const v = await f.updater.install(f.host);
      assert.equal(v.state, "error");
      assert.match(v.detail, re);
      assert.match(v.detail, /现有客户端未改动/);
      assert.deepEqual(f.host.calls, []);
      assertUntouched(f);
    });
  }

  test("恶意归档：解压前就拦下，不调用解压", async () => {
    const f = await ready(fixture({ zip: makeZip([...goodEntries(), { name: `${APP_BUNDLE}/../../etc/x` }]) }));
    await f.updater.install(f.host);
    assert.equal(f.ran.length, 0);
  });

  test("解压结果含指向包外的链接（解压前未发现）：拦下", async () => {
    const f = await ready(
      fixture({
        run: (file, args) => {
          if (!file.endsWith("ditto")) return undefined;
          const app = path.join(args[3], APP_BUNDLE);
          fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
          fs.symlinkSync("../../../..", path.join(app, "Contents", "up"));
          return "";
        },
      }),
    );
    const v = await f.updater.install(f.host);
    assert.match(v.detail, /extract_symlink_escapes/);
    assertUntouched(f);
  });

  test("没有写入应用所在文件夹的权限：报错，不进入更新中", { skip: process.getuid?.() === 0 ? "root 不受目录权限限制" : false }, async () => {
    const f = await ready(fixture());
    fs.chmodSync(f.apps, 0o555);
    try {
      const v = await f.updater.install(f.host);
      assert.equal(v.state, "error");
      assert.match(v.detail, /没有写入“应用程序”文件夹的权限（EACCES）/);
      assert.deepEqual(f.host.calls, []);
    } finally {
      fs.chmodSync(f.apps, 0o755);
    }
    assertUntouched(f);
  });

  test("应用路径不是本客户端的固定名称：拒绝", async () => {
    const f = await ready(fixture({ deps: { appPath: "/Applications/Other.app" } }));
    await assert.rejects(f.updater.install(f.host), /update_app_path_unexpected/);
  });
});

describe("安装：等任务、启动脚本与退出", () => {
  test("先进入更新中再检查空闲（之后到的新任务不会开始）；1 分钟内未空闲就放弃并解除", async () => {
    const f = await ready(fixture({ idle: () => false }));
    const v = await f.updater.install(f.host);
    assert.equal(v.state, "error");
    assert.match(v.detail, /tasks_not_idle/);
    assert.equal(f.host.calls[0], "hold:true");
    assert.equal(f.host.calls.at(-1), "hold:false");
    assertUntouched(f);
  });

  test("等一会儿后空闲：继续安装", async () => {
    let n = 0;
    const f = await ready(fixture({ idle: () => ++n > 3 }));
    assert.equal((await f.updater.install(f.host)).state, "installing");
    assert.equal(f.host.calls.filter((c) => c === "idle?").length, 4);
  });

  test("替换脚本起不来：解除更新中，不退出，删除暂存目录", async () => {
    const f = await ready(fixture({ launch: async () => Promise.reject(new Error("spawn EACCES")) }));
    const v = await f.updater.install(f.host);
    assert.match(v.detail, /launch_failed/);
    assert.deepEqual(f.host.calls.slice(-1), ["hold:false"]);
    assertUntouched(f);
  });

  test("并发：检查或安装进行中再点，拒绝（不会同时下载两份）", async () => {
    const f = await ready(fixture());
    const first = f.updater.install(f.host);
    await assert.rejects(f.updater.install(f.host), /update_busy/);
    await assert.rejects(f.updater.check(), /update_busy/);
    assert.equal((await first).state, "installing");
  });

  test("本进程没有按时退出、脚本已中止：解除更新中、提示，并允许之后再装", async () => {
    let dir = "";
    const f = await ready(
      fixture({
        launch: async (file) => {
          dir = path.dirname(file);
          fs.writeFileSync(path.join(dir, "swap.log"), "1 start\n2 aborted_pid_alive\n");
        },
      }),
    );
    assert.equal((await f.updater.install(f.host)).state, "installing");
    await new Promise((r) => setTimeout(r, 400));
    const v = f.updater.view();
    assert.equal(v.state, "error");
    assert.match(v.detail, /没有按时退出/);
    assert.equal(f.host.calls.at(-1), "hold:false");
    assert.equal(fs.readFileSync(path.join(f.app, "version"), "utf8"), "old");
    // 脚本已中止：允许再次安装（不报 update_busy）。
    assert.equal((await f.updater.install(f.host)).state, "installing");
  });

  test("本进程没有按时退出、脚本状态不明：解除更新中，但不允许再装（避免两个脚本同时等待）", async () => {
    const f = await ready(fixture({ launch: async (file) => fs.writeFileSync(path.join(path.dirname(file), "swap.log"), "1 start\n") }));
    await f.updater.install(f.host);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(f.host.calls.at(-1), "hold:false");
    await assert.rejects(f.updater.install(f.host), /update_busy/);
  });

  test("安装前清理已结束的旧暂存目录；回滚失败与进行中的保留", async () => {
    const f = await ready(fixture());
    const mk = (name: string, log: string | null) => {
      fs.mkdirSync(path.join(f.apps, STAGING_PREFIX + name));
      if (log) fs.writeFileSync(path.join(f.apps, STAGING_PREFIX + name, "swap.log"), log);
    };
    mk("90-a", "1 start\n2 rolled_back\n");
    mk("91-b", "1 start\n2 rollback_failed\n");
    mk("92-c", "1 start\n2 moved_old\n");
    await f.updater.install(f.host);
    const left = f.stagingDirs();
    assert.equal(left.includes(STAGING_PREFIX + "90-a"), false);
    assert.ok(left.includes(STAGING_PREFIX + "91-b"));
    assert.ok(left.includes(STAGING_PREFIX + "92-c"));
  });

  test("清理不到的目录（读不到）不影响安装", () => {
    assert.doesNotThrow(() => cleanupStaging(path.join(os.tmpdir(), "claw-no-such-dir-" + Date.now())));
  });
});

describe("下载（httpGet）", () => {
  test("写入失败（磁盘满）：按失败返回，不让进程崩溃", { skip: !fs.existsSync("/dev/full") }, async () => {
    const seen: string[] = [];
    const big = Buffer.alloc(256 * 1024, 1);
    const request = fakeRequester({ [`${DL}/${ZIP}`]: { status: 200, body: big } }, seen);
    await assert.rejects(httpGet(`${DL}/${ZIP}`, TAG, big.length, "/dev/full", "application/octet-stream", request), (err: NodeJS.ErrnoException) => err.code === "ENOSPC");
  });

  test("写入目标不可写：按失败返回", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-updater-sink-"));
    const request = fakeRequester({ [`${DL}/${ZIP}`]: { status: 200, body: "abc" } }, []);
    await assert.rejects(httpGet(`${DL}/${ZIP}`, TAG, 10, dir, "application/octet-stream", request));
  });

  test("首个地址也核对：其他仓库或其他主机直接拒绝，不发请求", async () => {
    const seen: string[] = [];
    const request = fakeRequester({}, seen);
    await assert.rejects(httpGet(`https://github.com/other/repo/releases/download/${TAG}/${ZIP}`, TAG, 10, null, "x", request), /url_path/);
    await assert.rejects(httpGet(`https://example.com/${ZIP}`, TAG, 10, null, "x", request), /url_host/);
    assert.deepEqual(seen, []);
  });

  test("响应一直不结束：总时长到点按超时失败", async () => {
    const request = ((_url: string, _o: unknown, cb: (res: any) => void) => {
      const req = new EventEmitter() as any;
      req.destroy = () => req;
      setImmediate(() => {
        const res = new PassThrough() as any;
        res.statusCode = 200;
        res.headers = {};
        cb(res);
        res.write("partial");
      });
      return req;
    }) as unknown as Requester;
    await assert.rejects(httpGet(`${API}/releases`, null, 100, null, "x", request, { apiMs: 100, idleMs: 100, totalMs: 100 }), /timeout/);
  });
});
