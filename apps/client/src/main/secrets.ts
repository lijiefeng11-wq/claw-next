import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { isPathSafeShopId } from "../core/security.js";

/**
 * 每店客户端口令，用操作系统安全存储（macOS 钥匙串 / Windows DPAPI）加密后落盘。
 * 口令不会返回给渲染页面，不写日志、URL 或网页存储。
 */
export class SecretStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** Linux 无钥匙环时 Electron 会退到 basic_text（固定明文密码），视同不可用。 */
  available(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
  }

  private file(shopId: string) {
    if (!isPathSafeShopId(shopId)) throw new Error("invalid_shop_id");
    return path.join(this.dir, `${shopId}.bin`);
  }

  set(shopId: string, token: string) {
    if (!this.available()) throw new Error("secure_storage_unavailable");
    fs.writeFileSync(this.file(shopId), safeStorage.encryptString(token), { mode: 0o600 });
  }

  get(shopId: string): string | null {
    const f = this.file(shopId);
    if (!fs.existsSync(f) || !this.available()) return null;
    return safeStorage.decryptString(fs.readFileSync(f));
  }

  has(shopId: string): boolean {
    return fs.existsSync(this.file(shopId));
  }

  remove(shopId: string) {
    fs.rmSync(this.file(shopId), { force: true });
  }
}
