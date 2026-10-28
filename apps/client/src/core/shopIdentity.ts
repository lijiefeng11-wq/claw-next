import fs from "node:fs";
import path from "node:path";

export type ShopIdentity = { adapter: string; platform_shop_id: string };

/**
 * 本店数据目录与浏览器分区按 shop_id 存放；首次使用时记下所属平台身份，
 * 之后身份不同（换了平台店铺或适配器）就拒绝复用，避免两个账号的会话与登录状态混用。
 */
export function bindShopIdentity(dataDir: string, identity: ShopIdentity): void {
  const file = path.join(dataDir, "identity.json");
  const want = { adapter: identity.adapter, platform_shop_id: identity.platform_shop_id };
  if (fs.existsSync(file)) {
    let have: Partial<ShopIdentity> = {};
    try {
      have = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new Error("shop_data_identity_mismatch");
    }
    if (have.adapter !== want.adapter || have.platform_shop_id !== want.platform_shop_id) throw new Error("shop_data_identity_mismatch");
    return;
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(want), { mode: 0o600 });
}
