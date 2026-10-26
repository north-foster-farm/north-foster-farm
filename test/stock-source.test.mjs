// Staging's stock read from production Square, and the pinned SKUs
// (#453). productionStock's own calls are in square.test.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PRODUCTION_SNAPSHOT, SNAPSHOT, availability, liveCounts,
} from "../netlify/functions/lib/stock.mjs";
import {
  parseOverrides, productionRead, stockOverrides,
} from "../netlify/functions/lib/stock-source.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const EGGS = "NFF-CHK-EGG-LG";
const BIRD = "NFF-CHK-WHL-20-24";
const EGGS_VARIATION = "S7XJNPQUKY6JSYQOEYSL6FYS";

const staging = {
  SITE_CONTEXT: "branch-deploy",
  SQUARE_ENV: "sandbox",
  STOCK_SOURCE: "production",
  STOCK_SOURCE_TOKEN: "read-only",
  STOCK_SOURCE_LOCATION_ID: "PRODLOC",
};

const reader = (answer) => {
  const seen = [];
  const read = async (ids, opts) => {
    seen.push({ ids, opts });

    return answer;
  };

  return { read, seen };
};

describe("parseOverrides", () => {
  it("reads SKU:n pairs", () => {
    assert.deepEqual(
      parseOverrides("NFF-CHK-WHL-30-34:1,NFF-CHK-WNG-30-99:0"),
      { "NFF-CHK-WHL-30-34": 1, "NFF-CHK-WNG-30-99": 0 });
    assert.deepEqual(parseOverrides(" A : 2 , B:-1 ,"), { A: 2, B: -1 });
  });

  it("skips a part without a SKU or a whole number", () => {
    assert.deepEqual(parseOverrides(
      "A,:3,B:,C:x,D:1.5,E:2"), { E: 2 });
  });

  it("reads nothing from nothing", () => {
    for (const text of [undefined, null, "", " , "]) {
      assert.deepEqual(parseOverrides(text), {});
    }
  });
});

describe("the stock source's context guard", () => {
  const overrides = { STOCK_OVERRIDES: `${EGGS}:1` };

  it("applies on staging and deploy previews", () => {
    for (const SITE_CONTEXT of ["branch-deploy", "deploy-preview"]) {
      const env = { ...staging, ...overrides, SITE_CONTEXT };

      assert.equal(productionRead(env), true);
      assert.deepEqual(stockOverrides(env), { [EGGS]: 1 });
    }
    assert.equal(productionRead({ ...staging, CONTEXT: "deploy-preview",
      SITE_CONTEXT: undefined }), true);
  });

  it("never turns on in production", () => {
    for (const env of [
      { ...staging, ...overrides, SITE_CONTEXT: "production" },
      { ...staging, ...overrides, SITE_CONTEXT: undefined,
        CONTEXT: "production" },
      // Production's Square, whatever the context says.
      { ...staging, ...overrides, SQUARE_ENV: "production" },
    ]) {
      assert.equal(productionRead(env), false);
      assert.deepEqual(stockOverrides(env), {});
    }
  });

  it("stays off with no context, in development, or unasked", () => {
    for (const env of [
      { ...staging, ...overrides, SITE_CONTEXT: undefined },
      { ...staging, ...overrides, SITE_CONTEXT: "dev" },
    ]) {
      assert.equal(productionRead(env), false);
      assert.deepEqual(stockOverrides(env), {});
    }
    assert.equal(productionRead({ ...staging, STOCK_SOURCE: "" }), false);
    assert.equal(productionRead({ ...staging, STOCK_SOURCE: "sandbox" }),
      false);
  });
});

describe("liveCounts with the stock source", () => {
  it("reads production's counts by SKU, not the sandbox's", async () => {
    const stores = testStores();
    const sandbox = reader({ [EGGS_VARIATION]: 9 });
    const production = reader({ [EGGS]: 2, [BIRD]: 1, NOT_SOLD: 4 });
    const counts = await liveCounts(stores, {
      env: staging, inventory: sandbox.read, production: production.read,
    });

    assert.equal(sandbox.seen.length, 0);
    assert.ok(production.seen[0].ids.includes(EGGS));
    assert.equal(production.seen[0].opts.env, staging);
    assert.equal(counts[EGGS], 2);
    assert.equal(counts[BIRD], 1);
    assert.ok(!("NOT_SOLD" in counts));
  });

  it("keeps production's in a snapshot of its own", async () => {
    const stores = testStores();
    const now = new Date(Date.UTC(2026, 9, 25, 12));
    const production = reader({ [EGGS]: 2 });
    const opts = { env: staging, production: production.read,
      snapshot: true, now };

    await liveCounts(stores, opts);
    await liveCounts(stores, opts);
    assert.equal(production.seen.length, 1);
    assert.deepEqual(await stores.stock.get(PRODUCTION_SNAPSHOT),
      { at: now.toISOString(), counts: { [EGGS]: 2 } });
    assert.equal(await stores.stock.get(SNAPSHOT), null);
  });

  it("pins only the SKUs STOCK_OVERRIDES lists", async () => {
    const env = { ...staging, STOCK_OVERRIDES: `${BIRD}:0` };
    const production = reader({ [EGGS]: 2, [BIRD]: 5 });
    const items = await availability(testStores(), {
      counts: await liveCounts(testStores(),
        { env, production: production.read }),
    });

    assert.deepEqual(items[EGGS], { inStock: true, available: 2 });
    assert.deepEqual(items[BIRD], { inStock: false, available: 0 });
  });

  it("pins over the sandbox's too, with the read off", async () => {
    const env = { SITE_CONTEXT: "branch-deploy",
      STOCK_OVERRIDES: `${EGGS}:1` };
    const sandbox = reader({ [EGGS_VARIATION]: 9 });
    const counts = await liveCounts(testStores(),
      { env, inventory: sandbox.read });

    assert.equal(sandbox.seen.length, 1);
    assert.equal(counts[EGGS], 1);
  });

  it("is ignored in production, which reads its own Square", async () => {
    const env = { ...staging, SITE_CONTEXT: "production",
      SQUARE_ENV: "production", STOCK_OVERRIDES: `${EGGS}:1` };
    const square = reader({ [EGGS_VARIATION]: 7 });
    const production = reader({ [EGGS]: 2 });
    const counts = await liveCounts(testStores(), {
      env, inventory: square.read, production: production.read,
    });

    assert.equal(production.seen.length, 0);
    assert.equal(counts[EGGS], 7);
  });

  it("leaves the store's when production doesn't answer", async () => {
    const stores = testStores();

    await stores.stock.set("counts", { [EGGS]: 4 });
    const counts = await liveCounts(stores,
      { env: staging, production: reader(null).read });

    assert.equal(counts[EGGS], 4);
  });
});
