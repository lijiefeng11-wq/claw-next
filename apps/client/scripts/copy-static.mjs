import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "src", "renderer");
const to = path.join(root, "dist", "src", "renderer");
fs.mkdirSync(to, { recursive: true });
for (const name of ["index.html", "style.css"]) fs.copyFileSync(path.join(from, name), path.join(to, name));
