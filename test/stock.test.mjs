import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import {
  adjust, availability, checkLines, getCounts, setCount, SNAPSHOT,
} from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/stock.mjs";

const THIGHS = "NFF-CHK-THGBN-10-14";   // In stock in the catalog
const THIGHS_VARIATION = "T366DS6FNIHDC5LVUDI46PXN";
const THIGHS_NAME = "Bone-In Thighs, 1.0 – 1.4 lbs";
const EGGS = "NFF-CHK-EGG-LG";           // Always in stock (#511)
const EGGS_VARIATION = "S7XJNPQUKY6JSYQOEYSL6FYS";
const SMALL = "NFF-CHK-EGG-SM";          // On hiatus, flagged out
const MEDIUM = "NFF-CHK-EGG-MD";         // Flagged out in the catalog
const BIRD = "NFF-CHK-WHL-20-24";    // In stock, uncounted here

describe("stock counts", () => {
  it("start empty and set per SKU", async () => {
    const stores = testStores();

    assert.deepEqual(await getCounts(stores), {});
    await setCount(stores, THIGHS, 12);
    await setCount(stores, BIRD, "5");
    assert.deepEqual(await getCounts(stores), { [THIGHS]: 12, [BIRD]: 5 });
    await setCount(stores, BIRD, null);
    assert.deepEqual(await getCounts(stores), { [THIGHS]: 12 });
  });

  it("move by an order's lines, counted SKUs only", async () => {
    const stores = testStores();

    await setCount(stores, THIGHS, 12);
    await adjust(stores, [{ sku: THIGHS, qty: 4 }, { sku: BIRD, qty: 2 }], -1);
    assert.deepEqual(await getCounts(stores), { [THIGHS]: 8 });
    await adjust(stores, [{ sku: THIGHS, qty: 4 }], 1);
    assert.deepEqual(await getCounts(stores), { [THIGHS]: 12 });
  });
});

describe("availability", () => {
  it("combines the catalog flag with the count", async () => {
    const stores = testStores();

    await setCount(stores, THIGHS, 0);
    const items = await availability(stores);

    assert.deepEqual(items[THIGHS], { inStock: false, available: 0 });
    assert.deepEqual(items[BIRD], { inStock: true, available: null });
    assert.deepEqual(items[MEDIUM], { inStock: false, available: null });

    await setCount(stores, THIGHS, 3);
    assert.deepEqual((await availability(stores))[THIGHS],
      { inStock: true, available: 3 });

    // A count cannot switch on what the catalog flags off.
    await setCount(stores, MEDIUM, 9);
    assert.equal((await availability(stores))[MEDIUM].inStock, false);
  });

  it("never reports below zero", async () => {
    const stores = testStores();

    await setCount(stores, THIGHS, 1);
    await adjust(stores, [{ sku: THIGHS, qty: 3 }], -1);
    assert.deepEqual((await availability(stores))[THIGHS],
      { inStock: false, available: 0 });
    assert.equal((await getCounts(stores))[THIGHS], -2,
      "the shortfall is kept");
  });
});

describe("checkLines", () => {
  it("passes what can be filled and names what cannot", async () => {
    const stores = testStores();

    await setCount(stores, THIGHS, 2);
    const ok = await checkLines(stores, [
      { sku: THIGHS, qty: 2 }, { sku: BIRD, qty: 50 },
    ]);

    assert.equal(ok.ok, true);

    const bad = await checkLines(stores, [
      { sku: THIGHS, qty: 3 }, { sku: MEDIUM, qty: 1 },
    ]);

    assert.equal(bad.ok, false);
    assert.equal(bad.errors[`lines.${THIGHS}`],
      `${THIGHS_NAME}: only 2 left in stock.`);
    assert.equal(bad.errors[`lines.${MEDIUM}`],
      "Eggs, Grade A · Medium: out of stock.");

    await setCount(stores, THIGHS, 1);
    assert.equal((await checkLines(stores, [{ sku: THIGHS, qty: 2 }]))
      .errors[`lines.${THIGHS}`], `${THIGHS_NAME}: only 1 left in stock.`);
  });
});

// Every sale and all stock live at one Square location (#267). Where
// Square counts a SKU there, its count is the one the page sells by.
describe("Square's counts", () => {
  const square = (answer) => {
    const seen = [];
    const inventory = async (ids, opts) => {
      seen.push({ ids, opts });
      if (answer instanceof Error) throw answer;

      return answer;
    };

    return { inventory, seen };
  };

  it("win over the store's, SKU by SKU", async () => {
    const stores = testStores();
    const { inventory, seen } = square({ [THIGHS_VARIATION]: 2, OTHER: 7 });

    await setCount(stores, THIGHS, 12);
    await setCount(stores, BIRD, 5);
    const items = await availability(stores, { inventory, env: {} });

    assert.deepEqual(items[THIGHS], { inStock: true, available: 2 });
    assert.deepEqual(items[BIRD], { inStock: true, available: 5 });
    assert.ok(seen[0].ids.includes(THIGHS_VARIATION));
    assert.ok(seen[0].ids.length > 30);
    // The store keeps its own: it is the fallback.
    assert.equal((await getCounts(stores))[THIGHS], 12);
  });

  it("sell nothing below one, though Square may go negative", async () => {
    const { inventory } = square({ [THIGHS_VARIATION]: -2 });
    const items = await availability(testStores(), { inventory });

    assert.deepEqual(items[THIGHS], { inStock: false, available: 0 });
  });

  it("leave the store's when Square doesn't answer", async () => {
    const stores = testStores();

    await setCount(stores, THIGHS, 4);
    for (const answer of [null, new Error("Square 503")]) {
      const { inventory } = square(answer);

      assert.deepEqual((await availability(stores, { inventory }))[THIGHS],
        { inStock: true, available: 4 });
    }
  });

  it("hold an order to Square's count, within the request's time",
    async () => {
      const { inventory, seen } = square({ [THIGHS_VARIATION]: 1 });
      const bad = await checkLines(testStores(), [{ sku: THIGHS, qty: 2 }],
        { inventory, deadline: 123 });

      assert.equal(bad.errors[`lines.${THIGHS}`],
        `${THIGHS_NAME}: only 1 left in stock.`);
      assert.equal(seen[0].opts.deadline, 123);
    });

  it("are read once per /api/stock", async () => {
    const { inventory, seen } = square({ [THIGHS_VARIATION]: 3 });
    const res = await handle(new Request("http://x/api/stock"), {
      stores: testStores(), inventory,
    });

    assert.equal((await res.json()).items[THIGHS].available, 3);
    assert.equal(seen.length, 1);
  });

  const at = (s) => new Date(Date.UTC(2026, 9, 22, 12, 0, s));
  const page = (stores, inventory, now) =>
    handle(new Request("http://x/api/stock"), { stores, inventory, now })
      .then((res) => res.json());

  it("reach the page from a snapshot no older than 15 s", async () => {
    const stores = testStores();
    const { inventory, seen } = square({ [THIGHS_VARIATION]: 3 });

    assert.equal((await page(stores, inventory, at(0))).items[THIGHS]
      .available, 3);
    assert.equal((await page(stores, inventory, at(14))).items[THIGHS]
      .available, 3);
    assert.equal(seen.length, 1);
    assert.deepEqual(await stores.stock.get(SNAPSHOT),
      { at: at(0).toISOString(), counts: { [THIGHS_VARIATION]: 3 } });

    await page(stores, inventory, at(15));
    assert.equal(seen.length, 2);
  });

  it("don't ask a Square that failed again until the snapshot ages",
    async () => {
      const stores = testStores();
      const { inventory, seen } = square(new Error("Square 429"));

      await setCount(stores, THIGHS, 4);
      await page(stores, inventory, at(0));
      const data = await page(stores, inventory, at(5));

      assert.equal(data.items[THIGHS].available, 4);
      assert.equal(seen.length, 1);
    });

  it("are read fresh by the order check, which logs its source",
    async () => {
      const stores = testStores();
      const lines = [];
      const info = mock.method(console, "info",
        (line) => lines.push(JSON.parse(line)));

      try {
        await page(stores, square({ [THIGHS_VARIATION]: 9 }).inventory,
          new Date());
        const fresh = square({ [THIGHS_VARIATION]: 1 });
        const bad = await checkLines(stores, [{ sku: THIGHS, qty: 2 }],
          { inventory: fresh.inventory });

        assert.equal(fresh.seen.length, 1);
        assert.ok(bad.errors[`lines.${THIGHS}`]);
        await checkLines(stores, [{ sku: THIGHS, qty: 1 }],
          { inventory: square(null).inventory, check: "edit" });
      } finally {
        info.mock.restore();
      }
      const checked = lines.filter((l) => l.event === "stock.checked")
        .map((l) => [l.for, l.via]);

      assert.deepEqual(checked, [["order", "square"], ["edit", "store"]]);
    });
});

// Large eggs are always in stock (#511, James, 2026-10-28): no count,
// no cap and no refusal, whatever Square counts. The farm turns them
// off by hand.
describe("an item marked always in stock", () => {
  const square = (n) => async () => ({ [EGGS_VARIATION]: n });

  for (const n of [0, 2, 50, -3]) {
    it(`is in stock with no count at Square's ${n}`, async () => {
      const stores = testStores();
      const inventory = square(n);

      assert.deepEqual((await availability(stores, { inventory }))[EGGS],
        { inStock: true, available: null });

      const res = await handle(new Request("http://x/api/stock"), {
        stores, inventory,
      });

      assert.deepEqual((await res.json()).items[EGGS],
        { inStock: true, available: null });
    });

    it(`is never refused for stock at Square's ${n}`, async () => {
      const check = await checkLines(testStores(),
        [{ sku: EGGS, qty: 60 }], { inventory: square(n) });

      assert.equal(check.ok, true);
      assert.deepEqual(check.errors, {});
    });
  }

  it("ignores the store's count, which orders still move", async () => {
    const stores = testStores();

    await setCount(stores, EGGS, 1);
    await adjust(stores, [{ sku: EGGS, qty: 3 }], -1);
    assert.equal((await getCounts(stores))[EGGS], -2);
    assert.deepEqual((await availability(stores))[EGGS],
      { inStock: true, available: null });
  });

  it("is out when the catalog flags it off", async () => {
    const stores = testStores();
    const catalogIndex = indexCatalog(catalog);

    catalogIndex.set(EGGS, { ...catalogIndex.get(EGGS), inStock: false });
    assert.deepEqual((await availability(stores, {
      catalogIndex, inventory: square(50),
    }))[EGGS], { inStock: false, available: null });
  });

  it("leaves Small and Medium on hiatus and the rest counted",
    async () => {
      const inventory = async () => ({
        [EGGS_VARIATION]: 2, [THIGHS_VARIATION]: 2,
        BVP2QVW2QQ3PD5SWHUYQYCND: 9, YZ4S22UUPFD6JEVISCX2OPT2: 9,
      });
      const items = await availability(testStores(), { inventory });

      assert.deepEqual(items[MEDIUM], { inStock: false, available: 9 });
      assert.deepEqual(items[SMALL], { inStock: false, available: 9 });
      assert.deepEqual(items[THIGHS], { inStock: true, available: 2 });

      const bad = await checkLines(testStores(), [
        { sku: THIGHS, qty: 3 }, { sku: SMALL, qty: 1 },
      ], { inventory });

      assert.equal(bad.errors[`lines.${THIGHS}`],
        `${THIGHS_NAME}: only 2 left in stock.`);
      assert.equal(bad.errors[`lines.${SMALL}`],
        "Eggs, Grade A · Small: out of stock.");
    });
});

describe("the /api/stock limit", () => {
  const ask = (env, ip) => handle(new Request("http://x/api/stock"), {
    stores: testStores(), env, ip, inventory: async () => null,
  });

  it("holds one address in production to 120 in ten minutes", async () => {
    const env = { CONTEXT: "production" };

    for (let i = 0; i < 120; i++) {
      assert.equal((await ask(env, "203.0.113.7")).status, 200);
    }
    const res = await ask(env, "203.0.113.7");

    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "600");
    assert.equal((await ask(env, "203.0.113.8")).status, 200);
  });

  it("leaves staging unlimited for the QA suite", async () => {
    const env = { CONTEXT: "staging" };

    for (let i = 0; i < 130; i++) {
      assert.equal((await ask(env, "203.0.113.9")).status, 200);
    }
  });
});

describe("GET /api/stock", () => {
  it("answers every catalog item", async () => {
    const stores = testStores();

    await setCount(stores, THIGHS, 4);
    const res = await handle(new Request("http://x/api/stock"), { stores });
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.items[THIGHS].available, 4);
    assert.ok(Object.keys(data.items).length > 30);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("answers before the farm's notice is done",
    async () => {
      const stores = testStores();
      const work = [];
      const res = await handle(new Request("http://x/api/stock"), {
        stores,
        after: (w) => work.push(w),
      });

      assert.equal(res.status, 200);
      assert.equal(work.length, 1);
      await work[0];
    });
});
