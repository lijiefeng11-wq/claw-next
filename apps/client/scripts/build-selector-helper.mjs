// Bundle the local parser and its Python runtime; users install no extra tools.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function buildSelectorHelper(platform, arch) {
  if (platform !== process.platform || arch !== process.arch) throw new Error("selector helper requires a native build for the target platform/architecture");
  const build = path.join(root, "out", "selector-build");
  const venv = path.join(build, "venv");
  const python = path.join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  fs.mkdirSync(build, { recursive: true });
  if (!fs.existsSync(python)) {
    const candidates = [process.env.CLAW_NEXT_PYTHON, "python3.12", "python3.13", "python3.11", "python3", "python"].filter(Boolean);
    const base = candidates.find(p => spawnSync(p, ["-c", "import sys;sys.exit(0 if (3,11)<=sys.version_info[:2]<(3,15) else 1)"], { encoding: "utf8" }).status === 0);
    if (!base) throw new Error("Python 3.11–3.14 required to build the bundled selector helper");
    execFileSync(base, ["-m", "venv", venv], { stdio: "inherit" });
  }
  execFileSync(python, ["-m", "pip", "install", "--disable-pip-version-check", "--index-url", "https://pypi.org/simple", "-r", path.join(root, "scripts", "selector-requirements.txt"), "pyinstaller==6.17.0"], { stdio: "inherit" });
  execFileSync(python, [path.join(root, "scripts", "test-selector-worker.py")], { stdio: "inherit" });
  const source = path.join(root, "src", "main", "selector_worker.py");
  execFileSync(python, ["-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--name", "claw-selector", "--distpath", path.join(build, "dist"), "--workpath", path.join(build, "work"), "--specpath", build, "--collect-all", "scrapling", source], { stdio: "inherit" });
  const folder = path.join(build, "dist", "claw-selector");
  const binary = path.join(folder, platform === "win32" ? "claw-selector.exe" : "claw-selector");
  const sample = { html: '<div class="reply-footer"><button data-claw-candidate="0">发送</button></div>' };
  const check = spawnSync(binary, [], { input: JSON.stringify(sample) + "\n", encoding: "utf8", timeout: 30_000 });
  if (check.status !== 0) throw new Error("bundled selector helper self-test failed");
  const parsed = JSON.parse(check.stdout);
  if (parsed.engine !== "scrapling" || parsed.candidate !== 0) throw new Error("bundled selector helper output invalid");
  return folder;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(buildSelectorHelper(process.platform, process.arch));
