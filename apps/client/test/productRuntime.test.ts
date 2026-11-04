import assert from "node:assert/strict";
import { test } from "node:test";
import { makeShop, startBackend, waitFor } from "./helpers.js";
import type { ProductDoc } from "../src/core/productLearning.js";

// Real runtime and temporary Python heartbeat; only the learning command/ack and platform are fictional.
for (const mode of ["complete", "uncertain-upload", "update-hold"] as const) {
  test(`product learning: ${mode}; no duplicate collection or sending`, async () => {
    const backend = await startBackend();
    let hold = false, collections = 0, heartbeats = 0;
    const uploads: any[] = [], logs: string[] = [];
    const request = { request_id: "f".repeat(32), selection: {}, expires_at: Date.now() / 1000 + 120 };
    const h = await makeShop({ backend, login: false, mode: "observe", updateHold: () => hold,
      log: line => logs.push(line), fetchImpl: async (url, init) => {
        if (String(url).includes("/api/v1/product-learning/")) {
          const body = JSON.parse(init?.body as string); uploads.push(body);
          if (mode === "uncertain-upload" && !body.error) throw new TypeError("fictional response lost");
          if (mode === "update-hold" && !body.error) hold = true;
          return new Response(JSON.stringify({ status: body.error ? "failed" : body.finished ? "completed" : "collecting" }));
        }
        const response = await fetch(url, init);
        if (String(url).endsWith("/heartbeat") && response.ok) {
          heartbeats++;
          const lease = await response.json() as Record<string, unknown>;
          return new Response(JSON.stringify({ ...lease, product_learning: request }));
        }
        return response;
      } });
    try {
      Object.assign(h.mock, { collectProducts: async (_selection: unknown,
        batch: (docs: ProductDoc[], total: number) => Promise<void>, check: () => void) => {
        collections++; check();
        await batch([{product_key: "a".repeat(64), title: "虚构商品", facts: ["不含棉"], details_complete: true}], 1);
        check(); return {total: 1, complete: true};
      } });
      await h.mock.login();
      await waitFor(() => logs.some(x => x.includes(mode === "complete" ? "product learning completed" : "product learning stopped")), "learning exit");
      hold = false;
      await waitFor(() => heartbeats >= 2, "same command heartbeat");
      assert.equal(collections, 1);
      assert.equal(uploads.length, 2);
      assert.equal(uploads.filter(x => x.products.length).length, 1);
      assert.equal(uploads[0].seq, 0);
      if (mode === "complete") { assert.equal(uploads[1].seq, 1); assert.equal(uploads[1].finished, true); }
      else { assert.ok(uploads[1].error); assert.equal(uploads[1].products.length, 0); }
      assert.equal(h.mock.platformSends.length, 0);
    } finally { await h.rt.stop(false); await backend.stop(); }
  });
}
