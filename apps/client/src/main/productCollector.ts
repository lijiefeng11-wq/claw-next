import { parseRealtimeUserInfo } from "../core/pddParse.js";
import { parseProductFacts, parseProductList, type ProductDoc } from "../core/productLearning.js";

/** Only these source-verified, read-only page queries may run; no arbitrary URL/method. */
export function productReadScript(kind: "identity" | "list" | "properties" | "skus", params: Record<string, unknown>): string {
  const routes = { identity: "/chats/userinfo/realtime", list: "/latitude/goods/queryGoods", properties: "/latitude/goods/goodsProperties", skus: "/latitude/goods/skuSelectorForMall" };
  return `(async()=>{
    if(location.origin!=="https://mms.pinduoduo.com")throw Error("product_page_unavailable");
    const path=${JSON.stringify(routes[kind])}, params=${JSON.stringify(params)};
    if(path==="/chats/userinfo/realtime"){
      const r=await fetch(path,{credentials:"same-origin",redirect:"error",signal:AbortSignal.timeout(10000)});
      if(!r.ok)throw Error("product_page_unavailable");return r.json();
    }
    const nodes=[document.querySelector("#app"),...document.querySelectorAll("body *")].slice(0,2000);
    const vm=nodes.map(e=>e&&e.__vue__).find(v=>v&&v.$axios&&typeof v.$axios.post==="function");
    if(!vm)throw Error("product_page_unavailable");
    return vm.$axios.post(path,params,{timeout:10000});
  })()`;
}

export async function collectStoreProducts(shop: string, mall: string, selection: { goods_id?: string; mall_id?: string },
  read: (kind: "identity" | "list" | "properties" | "skus", params: Record<string, unknown>) => Promise<unknown>,
  batch: (products: ProductDoc[], total: number) => Promise<void>, check: () => void): Promise<{ total: number; complete: boolean }> {
  if (selection.mall_id && selection.mall_id !== mall) throw Error("product_source_changed");
  const identity = async () => {
    check();
    const who = parseRealtimeUserInfo(await read("identity", {}));
    check();
    if (!who || who.mall_id !== mall) throw Error("product_source_changed");
  };
  const seen = new Set<string>();
  let total: number | null = null, stable = true;
  await identity();
  for (let page = 1; ; page++) {
    check();
    const list = parseProductList(await read("list", { pageNo: page, pageSize: 20, status: 1, ...(selection.goods_id ? { goodsId: selection.goods_id } : {}) }));
    if (total !== null && total !== list.total) stable = false;
    total = list.total;
    let added = 0;
    let docs: ProductDoc[] = [];
    for (const row of list.rows) {
      check();
      if (selection.goods_id && row.id !== selection.goods_id) throw Error("product_list_invalid");
      if (seen.has(row.id)) { stable = false; continue; }
      seen.add(row.id); added++;
      let properties: unknown = null, skus: unknown = null;
      try { properties = await read("properties", { goodsId: row.id }); } catch { check(); }
      check();
      try { skus = await read("skus", { goodsId: row.id }); } catch { check(); }
      check();
      const s = skus as { sku?: unknown } | null;
      if (s && Array.isArray(s.sku)) skus = { success: true, result: s };
      const doc = parseProductFacts(shop, row, properties, skus);
      // Bound model batches without dropping the remaining products.
      if (docs.length && (docs.length >= 3 || JSON.stringify([...docs, doc]).length > 20000)) {
        await identity(); await batch(docs, total); check(); docs = [];
      }
      docs.push(doc);
    }
    await identity();
    if (docs.length) await batch(docs, total);
    check();
    if (seen.size >= total || list.rows.length === 0 || added === 0) break;
  }
  return { total: total ?? 0, complete: stable && seen.size === total };
}
