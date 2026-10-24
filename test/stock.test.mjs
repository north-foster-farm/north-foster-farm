import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import {
  adjust, availability, checkLines, getCounts, setCount, SNAPSHOT,
} from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/stock.mjs";

const EGGS = "NFF-CHK-EGG-LG";           // In stock in the catalog
const MEDIUM = "NFF-CHK-EGG-MD";         // Flagged out in the catalog
const BIRD = "NFF-CHK-WHL-20-24";    // In stock, uncounted here

describe("stock counts", () => {
  it("start empty and set per SKU", async () => {
    const stores = testStores();

    assert.deepEqual(await getCounts(stores), {});
    await setCount(stores, EGGS, 12);
    await setCount(stores, BIRD, "5");
    assert.deepEqual(await getCounts(stores), { [EGGS]: 12, [BIRD]: 5 });
    await setCount(stores, BIRD, null);
    assert.deepEqual(await getCounts(stores), { [EGGS]: 12 });
  });

  it("move by an order's lines, counted SKUs only", async () => {
    const stores = testStores();

    await setCount(stores, EGGS, 12);
    await adjust(stores, [{ sku: EGGS, qty: 4 }, { sku: BIRD, qty: 2 }], -1);
    assert.deepEqual(await getCounts(stores), { [EGGS]: 8 });
    await adjust(stores, [{ sku: EGGS, qty: 4 }], 1);
    assert.deepEqual(await getCounts(stores), { [EGGS]: 12 });
  });
});

describe("availability", () => {
  it("combines the catalog flag with the count", async () => {
    const stores = testStores();

    await setCount(stores, EGGS, 0);
    const items = await availability(stores);

    assert.deepEqual(items[EGGS], { inStock: false, available: 0 });
    assert.deepEqual(items[BIRD], { inStock: true, available: null });
    assert.deepEqual(items[MEDIUM], { inStock: false, available: null });

    await setCount(stores, EGGS, 3);
    assert.deepEqual((await availability(stores))[EGGS],
      { inStock: true, available: 3 });

    // A count cannot switch on what the catalog flags off.
    await setCount(stores, MEDIUM, 9);
    assert.equal((await availability(stores))[MEDIUM].inStock, false);
  });

  it("never reports below zero", async () => {
    const stores = testStores();

    await setCount(stores, EGGS, 1);
    await adjust(stores, [{ sku: EGGS, qty: 3 }], -1);
    assert.deepEqual((await availability(stores))[EGGS],
      { inStock: false, available: 0 });
    assert.equal((await getCounts(stores))[EGGS], -2, "the shortfall is kept");
  });
});

describe("checkLines", () => {
  it("passes what can be filled and names what cannot", async () => {
    const stores = testStores();

    await setCount(stores, EGGS, 2);
    const ok = await checkLines(stores, [
      { sku: EGGS, qty: 2 }, { sku: BIRD, qty: 50 },
    ]);

    assert.equal(ok.ok, true);

    const bad = await checkLines(stores, [
      { sku: EGGS, qty: 3 }, { sku: MEDIUM, qty: 1 },
    ]);

    assert.equal(bad.ok, false);
    assert.equal(bad.errors[`lines.${EGGS}`],
      "Only 2 of Eggs, Large left.");
    assert.equal(bad.errors[`lines.${MEDIUM}`],
      "Eggs, Medium just sold out.");

    await setCount(stores, EGGS, 1);
    assert.equal((await checkLines(stores, [{ sku: EGGS, qty: 2 }]))
      .errors[`lines.${EGGS}`], "Only 1 Eggs, Large left.");
  });
});

// Every sale and all stock live at one Square location (#267). Where
// Square counts a SKU there, its count is the one the page sells by.
describe("Square's counts", () => {
  const EGGS_VARIATION = "S7XJNPQUKY6JSYQOEYSL6FYS";
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
    const { inventory, seen } = square({ [EGGS_VARIATION]: 2, OTHER: 7 });

    await setCount(stores, EGGS, 12);
    await setCount(stores, BIRD, 5);
    const items = await availability(stores, { inventory, env: {} });

    assert.deepEqual(items[EGGS], { inStock: true, available: 2 });
    assert.deepEqual(items[BIRD], { inStock: true, available: 5 });
    assert.ok(seen[0].ids.includes(EGGS_VARIATION));
    assert.ok(seen[0].ids.length > 30);
    // The store keeps its own: it is the fallback.
    assert.equal((await getCounts(stores))[EGGS], 12);
  });

  it("sell nothing below one, though Square may go negative", async () => {
    const { inventory } = square({ [EGGS_VARIATION]: -2 });
    const items = await availability(testStores(), { inventory });

    assert.deepEqual(items[EGGS], { inStock: false, available: 0 });
  });

  it("leave the store's when Square doesn't answer", async () => {
    const stores = testStores();

    await setCount(stores, EGGS, 4);
    for (const answer of [null, new Error("Square 503")]) {
      const { inventory } = square(answer);

      assert.deepEqual((await availability(stores, { inventory }))[EGGS],
        { inStock: true, available: 4 });
    }
  });

  it("hold an order to Square's count, within the request's time",
    async () => {
      const { inventory, seen } = square({ [EGGS_VARIATION]: 1 });
      const bad = await checkLines(testStores(), [{ sku: EGGS, qty: 2 }],
        { inventory, deadline: 123 });

      assert.equal(bad.errors[`lines.${EGGS}`],
        "Only 1 Eggs, Large left.");
      assert.equal(seen[0].opts.deadline, 123);
    });

  it("are read once per /api/stock", async () => {
    const { inventory, seen } = square({ [EGGS_VARIATION]: 3 });
    const res = await handle(new Request("http://x/api/stock"), {
      stores: testStores(), inventory,
    });

    assert.equal((await res.json()).items[EGGS].available, 3);
    assert.equal(seen.length, 1);
  });

  const at = (s) => new Date(Date.UTC(2026, 9, 22, 12, 0, s));
  const page = (stores, inventory, now) =>
    handle(new Request("http://x/api/stock"), { stores, inventory, now })
      .then((res) => res.json());

  it("reach the page from a snapshot no older than 15 s", async () => {
    const stores = testStores();
    const { inventory, seen } = square({ [EGGS_VARIATION]: 3 });

    assert.equal((await page(stores, inventory, at(0))).items[EGGS]
      .available, 3);
    assert.equal((await page(stores, inventory, at(14))).items[EGGS]
      .available, 3);
    assert.equal(seen.length, 1);
    assert.deepEqual(await stores.stock.get(SNAPSHOT),
      { at: at(0).toISOString(), counts: { [EGGS_VARIATION]: 3 } });

    await page(stores, inventory, at(15));
    assert.equal(seen.length, 2);
  });

  it("don't ask a Square that failed again until the snapshot ages",
    async () => {
      const stores = testStores();
      const { inventory, seen } = square(new Error("Square 429"));

      await setCount(stores, EGGS, 4);
      await page(stores, inventory, at(0));
      const data = await page(stores, inventory, at(5));

      assert.equal(data.items[EGGS].available, 4);
      assert.equal(seen.length, 1);
    });

  it("are read fresh by the order check, which logs its source",
    async () => {
      const stores = testStores();
      const lines = [];
      const info = mock.method(console, "info",
        (line) => lines.push(JSON.parse(line)));

      try {
        await page(stores, square({ [EGGS_VARIATION]: 9 }).inventory,
          new Date());
        const fresh = square({ [EGGS_VARIATION]: 1 });
        const bad = await checkLines(stores, [{ sku: EGGS, qty: 2 }],
          { inventory: fresh.inventory });

        assert.equal(fresh.seen.length, 1);
        assert.ok(bad.errors[`lines.${EGGS}`]);
        await checkLines(stores, [{ sku: EGGS, qty: 1 }],
          { inventory: square(null).inventory, check: "edit" });
      } finally {
        info.mock.restore();
      }
      const checked = lines.filter((l) => l.event === "stock.checked")
        .map((l) => [l.for, l.via]);

      assert.deepEqual(checked, [["order", "square"], ["edit", "store"]]);
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

    await setCount(stores, EGGS, 4);
    const res = await handle(new Request("http://x/api/stock"), { stores });
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.items[EGGS].available, 4);
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
