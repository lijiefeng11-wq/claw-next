import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";

/**
 * 诊断日志：<userData>/logs/client-YYYY-MM-DD.log，按天分文件，保留 14 天，单文件超过 20 MB 停写并留一行提示。
 * 只写状态、原因码、编号尾号；调用方不得写入聊天正文、图片、Cookie、令牌或密码。
 */
const KEEP_DAYS = 14;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const BEARER = /\bBearer\s+[^\s"',;]+/gi;
const SECRET = /(authorization|cookie|token|password|passwd|api[_-]?key|secret)(["'\s:=]+)([^\s"',;]+)/gi;

export type LogLevel = "INFO" | "WARN" | "ERROR";

export class FileLogger {
  private day = "";
  private file = "";
  private size = 0;
  private full = false;

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.prune();
  }

  write(level: LogLevel, text: string) {
    const now = new Date();
    const day = localDay(now);
    if (day !== this.day) this.open(day);
    if (this.full) return;
    const line = `${now.toISOString()} ${level} ${text.replace(BEARER, "Bearer [已隐去]").replace(SECRET, (m, k: string, sep: string, v: string) => (v === "Bearer" ? m : `${k}${sep}[已隐去]`)).replace(/\r?\n/g, "\n    ")}\n`;
    try {
      if (this.size + line.length > MAX_FILE_BYTES) {
        fs.appendFileSync(this.file, `${now.toISOString()} WARN 日志超过 20 MB，今天停止写入\n`, { mode: 0o600 });
        this.full = true;
        return;
      }
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      this.size += Buffer.byteLength(line);
    } catch {
      // 日志失败不能影响业务流程
    }
  }

  private open(day: string) {
    this.day = day;
    this.file = path.join(this.dir, `client-${day}.log`);
    this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    this.full = this.size > MAX_FILE_BYTES;
    this.prune();
  }

  private prune() {
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^client-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const p = path.join(this.dir, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {
        // 忽略
      }
    }
  }
}

function localDay(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 让 console 输出同时写入日志文件，并记录未捕获异常。返回日志目录。 */
export function installFileLogging(userData: string): string {
  const dir = path.join(userData, "logs");
  const logger = new FileLogger(dir);
  const wrap = (level: LogLevel, original: (...a: unknown[]) => void) => (...args: unknown[]) => {
    original(...args);
    logger.write(level, format(...args));
  };
  console.log = wrap("INFO", console.log.bind(console));
  console.info = wrap("INFO", console.info.bind(console));
  console.warn = wrap("WARN", console.warn.bind(console));
  console.error = wrap("ERROR", console.error.bind(console));
  // 记录后退出：状态未知时不继续运行；重启恢复会把进行中的发送按 unknown 处理。
  process.on("uncaughtException", (err) => {
    console.error("uncaughtException", err?.stack ?? String(err));
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => console.error("unhandledRejection", (reason as Error)?.stack ?? String(reason)));
  console.log(`client start pid=${process.pid} version=${process.env.npm_package_version ?? "-"}`);
  return dir;
}
