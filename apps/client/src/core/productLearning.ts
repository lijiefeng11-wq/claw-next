/** Pure parsing of the platform's read-only product list, attributes and SKU combinations. */
import { createHash } from "node:crypto";

export type ProductDoc = { product_key: string; title: string; facts: string[]; details_complete: boolean };
export type ProductRow = { id: string; title: string };
const obj = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown, max = 1000): string | null => {
  if (typeof v !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|https?:\/\/|www\./i.test(v)) return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s && s.length <= max ? s : null;
};
function id(v: unknown): string {
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v === "string" && /^[0-9]{1,32}$/.test(v) && /[1-9]/.test(v)) return v;
  throw Error("invalid_product_id");
}
export function productKey(shop: unknown, rawId: unknown): string {
  if (typeof shop !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(shop)) throw Error("invalid_product_id");
  return createHash("sha256").update(JSON.stringify([shop, "product", id(rawId)]), "utf8").digest("hex");
}
function payload(raw: unknown): Record<string, unknown> | null {
  const r = obj(raw);
  if (!r) return null;
  if ("success" in r || "result" in r) return r.success === true ? obj(r.result) : null;
  return r;
}
export function parseProductList(raw: unknown): { rows: ProductRow[]; total: number } {
  const r = payload(raw);
  if (!r || !Array.isArray(r.goods) || r.goods.length > 20 || !Number.isSafeInteger(r.total) || (r.total as number) < r.goods.length) throw Error("product_list_invalid");
  const seen = new Set<string>();
  const rows = r.goods.map(value => {
    const row = obj(value), title = text(row?.goodsName, 200);
    let key: string;
    try { key = id(row?.goodsId); } catch { throw Error("product_list_invalid"); }
    if (!title || seen.has(key)) throw Error("product_list_invalid");
    seen.add(key);
    return { id: key, title };
  });
  return { rows, total: r.total as number };
}
export function parseProductFacts(shop: string, row: ProductRow, rawProperties: unknown, rawSkus: unknown): ProductDoc {
  const key = productKey(shop, row.id), title = text(row.title, 200);
  if (!title) throw Error("product_list_invalid");
  const facts = [`商品名称：${title}`];
  let complete = true;
  const add = (s: string) => {
    if (facts.length >= 80 || s.length > 1000) complete = false;
    else if (!facts.includes(s)) facts.push(s);
  };
  const properties = payload(rawProperties)?.properties;
  if (!Array.isArray(properties)) complete = false;
  else for (const value of properties) {
    const p = obj(value), name = text(p?.name, 100);
    const values = Array.isArray(p?.values) ? p.values.map(v => text(v)) : [];
    if (!name || !values.length || values.some(v => v === null)) { complete = false; continue; }
    add(`属性：${name}：${values.join("、")}`);
  }
  const skus = payload(rawSkus)?.sku;
  if (!Array.isArray(skus)) complete = false;
  else for (const value of skus) {
    const sku = obj(value);
    if (!Array.isArray(sku?.specs)) { complete = false; continue; }
    const parts: string[] = [], names = new Set<string>();
    let valid = true;
    for (const spec of sku.specs) {
      const s = obj(spec), name = text(s?.specKey, 100), value = text(s?.specValue, 500);
      if (!name || !value || names.has(name)) { valid = false; break; }
      names.add(name); parts.push(`${name}：${JSON.stringify(value)}`);
    }
    if (!valid || !parts.length) complete = false;
    else if (parts.length) add(`规格组合：${parts.join("；")}`);
  }
  return { product_key: key, title, facts, details_complete: complete };
}
