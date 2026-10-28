// 第三方许可证随最终分发物一起走。
// macOS 的 zip 只装 .app，而打包目录里 Electron/Chromium 的许可证与 .app 同级，不在 zip 里；
// 因此签名前把它们原样复制进 .app/Contents/Resources/ThirdPartyLicenses/，并在生成 zip 后核对条目与原文。
// 项目自己的 MIT 许可证在 app.asar 里（见 package.mjs 第 2 步），这里不碰。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** 打包工具放在输出目录里的 Electron 自带许可证。 */
export const ELECTRON_LICENSE_FILES = ["LICENSE", "LICENSES.chromium.html"];
/** .app/Contents/Resources 下存放第三方许可证的独立目录名。 */
export const BUNDLED_LICENSE_DIR = "ThirdPartyLicenses";

/**
 * 把输出目录里的 Electron 许可证原样复制到 <appPath>/Contents/Resources/ThirdPartyLicenses/。
 * 源文件缺失或目标已存在都报错（不覆盖、不改写原文）。
 * 返回 [{ entry, source }]：entry 是以 .app 目录名开头的相对路径（与 ditto --keepParent 生成的 zip 条目一致）。
 */
export function bundleElectronLicenses(outDir, appPath) {
  const dest = path.join(appPath, "Contents", "Resources", BUNDLED_LICENSE_DIR);
  fs.mkdirSync(dest, { recursive: true });
  return ELECTRON_LICENSE_FILES.map((name) => {
    const source = path.join(outDir, name);
    if (!fs.existsSync(source)) throw new Error(`missing Electron license: ${source}`);
    const target = path.join(dest, name);
    if (fs.existsSync(target)) throw new Error(`refuse to overwrite: ${target}`);
    fs.copyFileSync(source, target);
    return { entry: path.relative(path.dirname(appPath), target).split(path.sep).join("/"), source };
  });
}

/** 核对 zip 中有这些条目，且解出的字节与源文件完全一致；不一致即报错。需要 unzip 命令。 */
export function verifyZipEntries(zip, expected) {
  const entries = new Set(execFileSync("unzip", ["-Z1", zip], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean));
  for (const { entry, source } of expected) {
    if (!entries.has(entry)) throw new Error(`zip 缺少 ${entry}`);
    const got = execFileSync("unzip", ["-p", zip, entry], { maxBuffer: 256 << 20 });
    if (!got.equals(fs.readFileSync(source))) throw new Error(`zip 中 ${entry} 与原文不一致`);
  }
}
