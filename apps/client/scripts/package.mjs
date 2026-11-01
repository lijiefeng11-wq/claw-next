// 打包成独立应用：先编译，再把运行所需文件放进临时目录，用 @electron/packager 生成 .app（macOS）或文件夹（Windows）。
// 用法：npm run package                     # 当前系统与架构
//       npm run package -- --platform darwin --arch arm64
//       node scripts/package.mjs --stage-only    # 只生成待打包内容并打印目录（测试用，不下载 Electron）
//       npm run package:mac -- --zip              # 另外生成可分发的 zip（macOS 上用 ditto，保留符号链接与权限）
// 产物在 out/，不含测试代码、配置、登录资料或任何店铺数据；不公证。CI 经 CLAW_NEXT_BUILD_SHA / CLAW_NEXT_BUILD_RUN 写入构建信息（见下）。项目 MIT 许可证在 app.asar 里；
// macOS 包另把 Electron/Chromium 许可证放进 .app/Contents/Resources/ThirdPartyLicenses/（见 licenses.mjs）。
// 在 macOS 上打 macOS 包时做本机临时签名（ad-hoc，codesign --sign -）：Apple 芯片要求可执行文件签名有效，
// packager 修改应用信息后原签名失效，下载后会被系统报“已损坏”。在其他系统上打 macOS 包无法签名，会给出提示。
// 每次都在全新的临时目录里编译，不复用 dist/：tsc 不会删除已删除/改名源文件的旧输出，复用会把它们打进包。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { packager } from "@electron/packager";
import { bundleElectronLicenses, verifyZipEntries } from "./licenses.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const platform = arg("platform", process.platform);
const arch = arg("arch", process.arch);
if (!["darwin", "win32", "linux"].includes(platform)) throw new Error(`unsupported platform: ${platform}`);
if (!["arm64", "x64"].includes(arch)) throw new Error(`unsupported arch: ${arch}`);

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const electronVersion = require("electron/package.json").version;
if (Object.keys(pkg.dependencies ?? {}).length) throw new Error("运行时依赖需要一并打包，请先更新本脚本");

// 1. 在全新的临时目录编译（与测试同一 tsconfig），再复制静态文件，确认主进程入口存在。
const build = path.join(root, "out", "build");
fs.rmSync(build, { recursive: true, force: true });
execFileSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json", "--outDir", build], { cwd: root, stdio: "inherit" });
for (const name of ["index.html", "style.css"]) fs.copyFileSync(path.join(root, "src", "renderer", name), path.join(build, "src", "renderer", name));
if (!pkg.main.startsWith("dist/")) throw new Error(`main entry must be under dist/: ${pkg.main}`);
if (!fs.existsSync(path.join(build, pkg.main.slice("dist/".length)))) throw new Error(`missing main entry: ${pkg.main}`);

// 2. 临时目录只放运行需要的文件：精简的 package.json、项目 LICENSE 与本次编译的 src（不含 test）。
const stage = path.join(root, "out", "stage");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const runtimePkg = { name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, license: pkg.license, private: true, main: pkg.main };
if (!runtimePkg.license) throw new Error("package.json 缺少 license 字段");
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(runtimePkg, null, 2));
// 项目许可证随应用一起分发（放在应用目录内）；Electron 自带的第三方许可证由打包工具保留，不替换。
const license = path.join(root, "..", "..", "LICENSE");
if (!fs.existsSync(license)) throw new Error(`missing project LICENSE: ${license}`);
fs.copyFileSync(license, path.join(stage, "LICENSE"));
fs.cpSync(path.join(build, "src"), path.join(stage, "dist", "src"), { recursive: true });
fs.rmSync(build, { recursive: true, force: true });

// 构建信息（客户端“检查更新”用）：完整提交 SHA、CI 运行序号、目标平台与架构，放在包外资源
// （macOS：.app/Contents/Resources/build-info.json，随签名覆盖）。只由 CI 经环境变量提供；本机打包没有时写 null，
// 客户端据此不提供检查更新。两项须同时提供且格式严格正确，否则直接报错，不打出带错误版本信息的包。
const buildSha = process.env.CLAW_NEXT_BUILD_SHA || null;
const buildRun = process.env.CLAW_NEXT_BUILD_RUN || null;
if ((buildSha === null) !== (buildRun === null)) throw new Error("CLAW_NEXT_BUILD_SHA 与 CLAW_NEXT_BUILD_RUN 须同时提供");
if (buildSha !== null && !/^[0-9a-f]{40}$/.test(buildSha)) throw new Error("CLAW_NEXT_BUILD_SHA 须为 40 位小写十六进制完整提交 SHA");
if (buildRun !== null && !/^[1-9][0-9]{0,9}$/.test(buildRun)) throw new Error("CLAW_NEXT_BUILD_RUN 须为正整数");
const resources = path.join(root, "out", "resources");
fs.rmSync(resources, { recursive: true, force: true });
fs.mkdirSync(resources, { recursive: true });
const buildInfo = path.join(resources, "build-info.json");
fs.writeFileSync(buildInfo, JSON.stringify({ sha: buildSha, run: buildRun === null ? null : Number(buildRun), platform, arch }) + "\n");

if (process.argv.includes("--stage-only")) {
  console.log(`staged: ${stage}`);
  console.log(`resources: ${resources}`);
  process.exit(0);
}

// 3. 生成应用。
let paths;
try {
  paths = await packager({
    dir: stage,
    out: path.join(root, "out"),
    name: pkg.productName,
    appVersion: pkg.version,
    platform,
    arch,
    electronVersion,
    appBundleId: "com.claw-next.client",
    appCategoryType: "public.app-category.business",
    win32metadata: { CompanyName: "Claw-Next", ProductName: pkg.productName, FileDescription: pkg.description, InternalName: pkg.productName },
    asar: true,
    extraResource: [buildInfo],
    prune: false,
    overwrite: true,
    quiet: true,
  });
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
for (const p of paths) {
  const res = platform === "darwin" ? path.join(p, `${pkg.productName}.app`, "Contents", "Resources") : path.join(p, "resources");
  if (fs.readFileSync(path.join(res, "build-info.json"), "utf8") !== fs.readFileSync(buildInfo, "utf8")) throw new Error(`build-info.json 未按原样进入包：${path.relative(root, p)}`);
}
for (const p of paths) console.log(`packaged: ${path.relative(root, p)}`);

// 4. macOS 包：先把 Electron 自带的第三方许可证放进 .app（zip 只装 .app）；再本机临时签名并校验；按需生成 zip 并核对许可证条目。
if (platform === "darwin") {
  for (const p of paths) {
    const appPath = path.join(p, `${pkg.productName}.app`);
    const licenses = bundleElectronLicenses(p, appPath);
    console.log(`bundled licenses: ${licenses.map((l) => l.entry).join(", ")}`);
    if (process.platform !== "darwin") {
      console.log(`warning: 不是在 macOS 上打包，${path.relative(root, appPath)} 未签名；在 Mac 上运行：codesign --force --deep --sign - <应用路径>`);
      continue;
    }
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
    console.log(`signed (ad-hoc): ${path.relative(root, appPath)}`);
    if (process.argv.includes("--zip")) {
      const zip = path.join(root, "out", `${pkg.productName}-darwin-${arch}.zip`);
      fs.rmSync(zip, { force: true });
      execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zip], { stdio: "inherit" });
      verifyZipEntries(zip, [...licenses, { entry: `${pkg.productName}.app/Contents/Resources/build-info.json`, source: buildInfo }]);
      console.log(`zipped: ${path.relative(root, zip)}（第三方许可证与 build-info.json 条目与原文一致）`);
    }
  }
}
