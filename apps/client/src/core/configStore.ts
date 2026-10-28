import fs from "node:fs";
import path from "node:path";
import { validateShopInput } from "./ipc.js";
import { SHOP_MODES, ShopConfig } from "./runtime.js";

/** 店铺配置（不含口令）。口令单独加密保存。 */
export class ConfigStore {
  private shops: ShopConfig[] = [];
  private readonly file: string;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "shops.json");
    if (!fs.existsSync(this.file)) return;
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { shops?: unknown[] };
    for (const item of raw.shops ?? []) {
      const { mode, ...rest } = item as Record<string, unknown>;
      const shop = validateShopInput(rest);
      this.shops.push({ ...shop, mode: (SHOP_MODES as readonly unknown[]).includes(mode) ? (mode as ShopConfig["mode"]) : "observe" });
    }
  }

  list(): ShopConfig[] {
    return this.shops.map((s) => ({ ...s }));
  }

  get(shopId: string): ShopConfig | undefined {
    const s = this.shops.find((x) => x.shop_id === shopId);
    return s ? { ...s } : undefined;
  }

  upsert(shop: ShopConfig) {
    const i = this.shops.findIndex((x) => x.shop_id === shop.shop_id);
    if (i >= 0) this.shops[i] = { ...shop };
    else this.shops.push({ ...shop });
    this.save();
  }

  remove(shopId: string) {
    this.shops = this.shops.filter((x) => x.shop_id !== shopId);
    this.save();
  }

  private save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, shops: this.shops }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
