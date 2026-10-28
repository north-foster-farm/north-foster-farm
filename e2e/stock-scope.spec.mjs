// Two tests that pin one SKU at the same moment each see their own
// count (#507, James in #495 6461231997). The desktop and phone copies
// of a spec run at once, and #503 spreads the suite across parallel
// runners, so the deploy reads a pin only by the scope the request
// carries (netlify/functions/lib/stock-pins.mjs). Two scopes, opposite
// counts, read together, then swapped together.

import { SKU, expect, test } from "./support/order.mjs";
import { scopeFor, stockFor, withScope } from "./support/stock.mjs";

test("two scopes pinning one SKU at once each see their own count",
  async ({ playwright, baseURL, storageState }, info) => {
    const sku = SKU.eggs;
    const scopes = [scopeFor(info), scopeFor(info)];
    const handles = scopes.map((scope) => stockFor(scope));
    const state = storageState && typeof storageState === "object"
      ? storageState : { cookies: [], origins: [] };
    const apis = await Promise.all(scopes.map((scope) =>
      playwright.request.newContext({
        baseURL,
        storageState: {
          cookies: withScope(state.cookies, scope, baseURL),
          origins: state.origins || [],
        },
      })));
    const read = () => Promise.all(apis.map(async (api) => {
      const res = await api.get("/api/stock");

      expect(res.ok()).toBe(true);

      return (await res.json()).items[sku];
    }));
    const OUT = { inStock: false, available: 0 };
    const FOUR = { inStock: true, available: 4 };

    expect(scopes[0]).not.toBe(scopes[1]);

    try {
      await Promise.all([
        handles[0].pin({ [sku]: 0 }), handles[1].pin({ [sku]: 4 }),
      ]);
      for (let round = 0; round < 3; round += 1) {
        expect(await read(), `round ${round}`).toEqual([OUT, FOUR]);
      }

      await Promise.all([
        handles[0].pin({ [sku]: 4 }), handles[1].pin({ [sku]: 0 }),
      ]);
      for (let round = 0; round < 3; round += 1) {
        expect(await read(), `swapped, round ${round}`)
          .toEqual([FOUR, OUT]);
      }
    } finally {
      await Promise.all(handles.map((h) => h.unpin()));
      await Promise.all(apis.map((api) => api.dispose()));
    }
  });
