import fs from "node:fs";
import path from "node:path";
import type { ShopConfig } from "./runtime.js";

/** 每店上次的运行状态：是否连着后台、拼多多平台页是否开着。只记用户自己的操作，不含口令或买家数据。 */
export type ShopSession = { connected: boolean; page_open: boolean };

/** 启动时要恢复的一步：先连接后台（建立消息接收），再打开平台页（拼多多店铺）。 */
export type RestoreStep = { shop_id: string; action: "open_page" | "connect" };
export type RestoreSkip = { shop_id: string; reason: "token_missing" };

/**
 * 记录“上次打开着的店铺”，供开机自启或崩溃重启后恢复。
 * - 只在用户手动连接/断开后台、打开/关闭平台页时更新；退出程序时不改，下次按退出前的样子恢复。
 * - 运行模式（观察/人工/自动）仍由店铺配置决定，恢复时不改。
 */
export class SessionStore {
  /** 用 Map 保存，店铺编号为 __proto__ 等特殊名字也能正常记录。 */
  private shops = new Map<string, ShopSession>();
  /**
   * 每店每项（connected / page_open）手动操作的代次（只在内存）：操作完成后只有它所改的各项仍是最新代次才写记录，
   * 较早的操作不能覆盖较新的操作；互不相关的两项（如打开平台页与连接后台）互不作废。
   */
  private readonly generation = new Map<string, { connected: number; page_open: number }>();
  private readonly file: string;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "session.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { shops?: unknown };
      // 以数组 [编号, 状态] 保存；JSON.parse 生成的数组不会触发原型上的特殊键。
      for (const entry of Array.isArray(raw.shops) ? raw.shops : []) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
        const s = entry[1] as Partial<ShopSession> | null;
        if (s && typeof s === "object") this.shops.set(entry[0], { connected: s.connected === true, page_open: s.page_open === true });
      }
    } catch {
      // 文件不存在或损坏：当作上次没有打开的店铺，不阻止启动。
      this.shops = new Map();
    }
  }

  get(shopId: string): ShopSession {
    return { ...(this.shops.get(shopId) ?? { connected: false, page_open: false }) };
  }

  set(shopId: string, patch: Partial<ShopSession>) {
    const next = { ...this.get(shopId), ...patch };
    const prev = this.shops.get(shopId);
    if (prev && prev.connected === next.connected && prev.page_open === next.page_open) return;
    this.shops.set(shopId, next);
    this.save();
  }

  /**
   * 用户对某店开始一次手动操作，声明它会改哪几项：连接只改 connected；打开/关闭平台页只改 page_open；
   * 断开与删除两项都改（断开会一并关闭平台页）。返回本次操作的代次。
   */
  begin(shopId: string, fields: (keyof ShopSession)[]): Partial<Record<keyof ShopSession, number>> {
    const g = this.generation.get(shopId) ?? { connected: 0, page_open: 0 };
    const token: Partial<Record<keyof ShopSession, number>> = {};
    for (const f of fields) token[f] = ++g[f];
    this.generation.set(shopId, g);
    return token;
  }

  /** 操作完成后写记录：只写本操作声明过、且仍是最新代次的项；被更新的操作取代的项丢弃（不复活已关闭或已删除的状态）。 */
  commit(shopId: string, token: Partial<Record<keyof ShopSession, number>>, patch: Partial<ShopSession>): boolean {
    const g = this.generation.get(shopId);
    const valid: Partial<ShopSession> = {};
    for (const f of Object.keys(patch) as (keyof ShopSession)[]) {
      if (g && token[f] !== undefined && g[f] === token[f]) valid[f] = patch[f];
    }
    if (!Object.keys(valid).length) return false;
    this.set(shopId, valid);
    return Object.keys(valid).length === Object.keys(patch).length;
  }

  remove(shopId: string) {
    // 删除也让进行中的旧操作失效，避免它完成后重新写回记录。
    this.begin(shopId, ["connected", "page_open"]);
    if (!this.shops.delete(shopId)) return;
    this.save();
  }

  private save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, shops: [...this.shops.entries()] }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

/**
 * 按店铺配置与上次状态生成恢复步骤。已删除的店铺忽略；模拟平台没有平台页；没有口令的店铺只开平台页、不连后台（记原因）。
 * 同一店先连接后台、再打开平台页：运行时在连接时就订阅平台消息，页面加载期间到达的消息不会因无人接收而丢失。
 */
export function restorePlan(configs: ShopConfig[], sessions: SessionStore, hasToken: (shopId: string) => boolean): { steps: RestoreStep[]; skipped: RestoreSkip[] } {
  const steps: RestoreStep[] = [];
  const skipped: RestoreSkip[] = [];
  for (const c of configs) {
    const s = sessions.get(c.shop_id);
    if (s.connected) {
      if (hasToken(c.shop_id)) steps.push({ shop_id: c.shop_id, action: "connect" });
      else skipped.push({ shop_id: c.shop_id, reason: "token_missing" });
    }
    if (s.page_open && c.adapter === "pdd") steps.push({ shop_id: c.shop_id, action: "open_page" });
  }
  return { steps, skipped };
}

/**
 * 执行恢复步骤：不同店铺并行（一家后台连接慢不拖住其他店），同一店按计划顺序依次执行。
 * 每一步执行前都重新核对：该店在恢复期间是否被用户手动操作过、记录里对应项是否仍为开着；
 * 任一不满足就跳过该店剩余步骤，不违背用户刚做的操作。单步失败只记日志，不影响其他店铺与该店后续步骤。
 */
export async function runRestore(
  steps: RestoreStep[],
  deps: {
    sessions: SessionStore;
    /** 恢复开始后用户手动操作过的店铺（连接、断开、打开或关闭平台页、删除）。 */
    touched: (shopId: string) => boolean;
    openPage: (shopId: string) => Promise<void>;
    connect: (shopId: string) => Promise<void>;
    log: (line: string) => void;
  },
): Promise<void> {
  const byShop = new Map<string, RestoreStep[]>();
  for (const step of steps) byShop.set(step.shop_id, [...(byShop.get(step.shop_id) ?? []), step]);
  await Promise.all(
    [...byShop.values()].map(async (shopSteps) => {
      for (const step of shopSteps) {
        const s = deps.sessions.get(step.shop_id);
        const wanted = step.action === "open_page" ? s.page_open : s.connected;
        if (deps.touched(step.shop_id) || !wanted) {
          deps.log(`[${step.shop_id}] restore ${step.action} skipped reason=${deps.touched(step.shop_id) ? "user_changed" : "no_longer_recorded"}`);
          return;
        }
        try {
          await (step.action === "open_page" ? deps.openPage(step.shop_id) : deps.connect(step.shop_id));
          deps.log(`[${step.shop_id}] restore ${step.action} ok`);
        } catch (err) {
          deps.log(`[${step.shop_id}] restore ${step.action} failed: ${(err as Error)?.message ?? "error"}`);
        }
      }
    }),
  );
}
