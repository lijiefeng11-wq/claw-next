import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// 打包内容只来自本次编译：dist/ 里残留的旧编译产物（源文件已删除或改名）不得进入包。只生成待打包目录，不下载 Electron。

const root = path.join(__dirname, "..", "..");

const list = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(path.join(dir, e.name)).map((x) => `${e.name}/${x}`) : [e.name]));

test("待打包内容来自全新编译：dist 中的旧残留不进包；只含运行文件、精简 package.json 与项目 LICENSE", () => {
  const stale = path.join(root, "dist", "src", "core", "zz-removed-source-fixture.js");
  const stage = path.join(root, "out", "stage");
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, "// 模拟源文件已删除后残留的旧编译产物\n");
  try {
    const r = spawnSync(process.execPath, [path.join(root, "scripts", "package.mjs"), "--stage-only"], { cwd: root, encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    const files = list(stage);
    assert.ok(files.includes("dist/src/main/main.js"));
    assert.ok(files.includes("dist/src/renderer/index.html") && files.includes("dist/src/renderer/style.css"));
    assert.ok(!files.some((f) => f.includes("zz-removed-source-fixture")), "旧残留被打进了包");
    assert.ok(!files.some((f) => f.startsWith("dist/test/") || f.includes("/test/")), "测试代码被打进了包");
    // 每个打包的 .js 都对应当前的 .ts 源文件。
    for (const f of files.filter((x) => x.endsWith(".js"))) assert.ok(fs.existsSync(path.join(root, f.replace(/^dist\//, "").replace(/\.js$/, ".ts"))), `无对应源文件：${f}`);
    const pkg = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(pkg).sort(), ["description", "license", "main", "name", "private", "productName", "version"]);
    assert.equal(pkg.license, "MIT");
    // 项目许可证随应用分发，内容与仓库根目录的 LICENSE 一致。
    assert.ok(files.includes("LICENSE"), "缺少项目 LICENSE");
    assert.equal(fs.readFileSync(path.join(stage, "LICENSE"), "utf8"), fs.readFileSync(path.join(root, "..", "..", "LICENSE"), "utf8"));
    assert.ok(!fs.existsSync(path.join(root, "out", "build")), "临时编译目录已清理");
  } finally {
    fs.rmSync(stale, { force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

// macOS 的 zip 只装 .app：Electron/Chromium 许可证要在签名前原样放进 .app，zip 生成后核对条目与原文。
// 用虚构目录结构验证（不下载 Electron）；zip 核对需要 unzip 命令，没有时跳过该项。
const hasUnzip = spawnSync("unzip", ["-v"]).status === 0;
const hasPython = spawnSync("python3", ["--version"]).status === 0;

test("第三方许可证放进 .app：原样复制、不覆盖、缺失即报错", async () => {
  const { bundleElectronLicenses, BUNDLED_LICENSE_DIR } = await import(pathToFileURL(path.join(root, "scripts", "licenses.mjs")).href);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "claw-licenses-"));
  try {
    fs.writeFileSync(path.join(out, "LICENSE"), "虚构 Electron 许可证\n");
    fs.writeFileSync(path.join(out, "LICENSES.chromium.html"), "<html>虚构 Chromium 许可证</html>\n");
    const app = path.join(out, "Demo.app");
    fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
    const r = bundleElectronLicenses(out, app);
    assert.deepEqual(r.map((x: { entry: string }) => x.entry), [`Demo.app/Contents/Resources/${BUNDLED_LICENSE_DIR}/LICENSE`, `Demo.app/Contents/Resources/${BUNDLED_LICENSE_DIR}/LICENSES.chromium.html`]);
    for (const name of ["LICENSE", "LICENSES.chromium.html"]) {
      assert.deepEqual(fs.readFileSync(path.join(app, "Contents", "Resources", BUNDLED_LICENSE_DIR, name)), fs.readFileSync(path.join(out, name)));
    }
    assert.throws(() => bundleElectronLicenses(out, app), /refuse to overwrite/);
    fs.rmSync(path.join(out, "LICENSES.chromium.html"));
    assert.throws(() => bundleElectronLicenses(out, path.join(out, "Other.app")), /missing Electron license/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("zip 核对：缺条目或内容与原文不一致都报错", { skip: !hasUnzip || !hasPython }, async () => {
  const { verifyZipEntries } = await import(pathToFileURL(path.join(root, "scripts", "licenses.mjs")).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-zip-"));
  try {
    const source = path.join(dir, "LICENSE");
    fs.writeFileSync(source, "虚构许可证原文\n");
    const mk = (name: string, entries: Record<string, string>) => {
      const zip = path.join(dir, name);
      const r = spawnSync("python3", ["-c", "import sys,json,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n  [z.writestr(k,v) for k,v in json.loads(sys.argv[2]).items()]", zip, JSON.stringify(entries)]);
      assert.equal(r.status, 0, String(r.stderr));
      return zip;
    };
    const entry = "Demo.app/Contents/Resources/ThirdPartyLicenses/LICENSE";
    verifyZipEntries(mk("ok.zip", { [entry]: "虚构许可证原文\n" }), [{ entry, source }]);
    assert.throws(() => verifyZipEntries(mk("missing.zip", { "Demo.app/Contents/Info.plist": "x" }), [{ entry, source }]), /缺少/);
    assert.throws(() => verifyZipEntries(mk("changed.zip", { [entry]: "被改过的内容\n" }), [{ entry, source }]), /不一致/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
