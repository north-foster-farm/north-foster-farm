// Site search's live stock (#908, rules 8 to 10): through the order
// page's reader when there is one, else its own ask of /api/stock
// under a 15-second floor. search/live-stock.js, with fetch, window
// and the clock faked.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { readStock } from "../assets/scripts/search/live-stock.js";

const ITEMS = { "NFF-CHK-EGG-LG": { inStock: true, available: 12 } };

describe("readStock", () => {
  const saved = {};
  let asked;

  beforeEach(() => {
    saved.window = globalThis.window;
    saved.fetch = globalThis.fetch;
    globalThis.window = {};
    asked = [];
    globalThis.fetch = async (url) => {
      asked.push(String(url));

      return { ok: true, json: async () => ({ items: ITEMS }) };
    };
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  });

  afterEach(() => {
    mock.timers.reset();
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
  });

  it("reads through the order page's reader where there is one", async () => {
    globalThis.window.nffStock = { read: async () => ITEMS };

    assert.deepEqual(await readStock(), ITEMS);
    assert.deepEqual(asked, [], "search asks nothing itself");
  });

  it("elsewhere asks /api/stock, at most once in 15 seconds", async () => {
    mock.timers.tick(60_000);
    assert.deepEqual(await readStock(), ITEMS);
    assert.deepEqual(await readStock(), ITEMS);
    assert.deepEqual(asked, ["/api/stock"], "once inside the floor");

    mock.timers.tick(15_000);
    await readStock();
    assert.deepEqual(asked, ["/api/stock", "/api/stock"], "again after it");
  });
});
