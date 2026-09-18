import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  adjust, availability, checkLines, getCounts, setCount,
} from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/stock.mjs";

const EGGS = "NFF-CHK-EGG-LG";           // In stock in the catalog
const MEDIUM = "NFF-CHK-EGG-MD";         // Flagged out in the catalog
const BIRD = "NFF-CHK-WHL-0200-0250";    // In stock, uncounted here

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
      "Only 2 of Eggs (per dozen), Large left.");
    assert.equal(bad.errors[`lines.${MEDIUM}`],
      "Eggs (per dozen), Medium just sold out.");

    await setCount(stores, EGGS, 1);
    assert.equal((await checkLines(stores, [{ sku: EGGS, qty: 2 }]))
      .errors[`lines.${EGGS}`], "Only 1 Eggs (per dozen), Large left.");
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
});
