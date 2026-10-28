// Staging's stock read from production's public /api/stock, and the
// pinned SKUs (#453). Production's answer is replayed from
// test/fixtures/stock/production-api-stock.json, recorded by the
// coordinator on 2026-10-28 (its `_source` says how).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { e2eEnv } from "../bin/e2e/env.mjs";
import { readValues } from "../bin/env/sample.mjs";
import {
  PRODUCTION_SNAPSHOT, SNAPSHOT, availability, liveCounts,
} from "../netlify/functions/lib/stock.mjs";
import {
  PRODUCTION_STOCK_URL, parseOverrides, productionRead, productionStock,
  stockOverrides,
} from "../netlify/functions/lib/stock-source.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const RECORDED = JSON.parse(readFileSync(new URL(
  "./fixtures/stock/production-api-stock.json", import.meta.url,
), "utf8"));

const EGGS = "NFF-CHK-EGG-LG";
const BIRD = "NFF-CHK-WHL-20-24";
const EGGS_VARIATION = "S7XJNPQUKY6JSYQOEYSL6FYS";
// Production counts these at 2, 1 and 0 in the recording.
const TWO = "NFF-CHK-WHL-30-34";
const ONE = "NFF-CHK-WHL-45-49";
const WINGS = "NFF-CHK-WNG-30-99";
// Production doesn't count it (available null).
const CORNISH = "NFF-CHK-CRN-0000-0300";

const staging = {
  SITE_CONTEXT: "branch-deploy",
  SQUARE_ENV: "sandbox",
  STOCK_SOURCE: "production",
};

// Production's /api/stock as recorded, with `items` changed where a test
// says. Every request is kept.
const production = ({ items = {}, status = RECORDED.status } = {}) => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });

    const body = { ...RECORDED.response,
      items: { ...RECORDED.response.items, ...items } };

    return new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json" },
    });
  };

  return { fetchImpl, seen };
};

const reader = (answer) => {
  const seen = [];
  const read = async (ids, opts) => {
    seen.push({ ids, opts });

    if (answer instanceof Error) throw answer;

    return answer;
  };

  return { read, seen };
};

// The production read as liveCounts calls it, over a given fetch.
const via = (fetchImpl) => (skus, opts) =>
  productionStock(skus, { ...opts, fetchImpl });

const warnings = (t) => {
  const lines = [];

  t.mock.method(console, "warn", (text) => lines.push(JSON.parse(text)));

  return lines;
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

  it("applies on staging, deploy previews and in development", () => {
    for (const SITE_CONTEXT of ["branch-deploy", "deploy-preview", "dev"]) {
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
      { ...staging, ...overrides, SITE_CONTEXT: "dev",
        SQUARE_ENV: "production" },
    ]) {
      assert.equal(productionRead(env), false);
      assert.deepEqual(stockOverrides(env), {});
    }
  });

  it("stays off with no context, an unknown one, or unasked", () => {
    for (const env of [
      { ...staging, ...overrides, SITE_CONTEXT: undefined },
      { ...staging, ...overrides, SITE_CONTEXT: "development" },
    ]) {
      assert.equal(productionRead(env), false);
      assert.deepEqual(stockOverrides(env), {});
    }
    assert.equal(productionRead({ ...staging, STOCK_SOURCE: "" }), false);
    assert.equal(productionRead({ ...staging, STOCK_SOURCE: "sandbox" }),
      false);
  });
});

describe("the e2e build's stock", () => {
  // As bin/e2e/serve.mjs runs: the shell's variables, then the
  // development sample's under them, then e2eEnv over both.
  const sample = readValues(readFileSync(new URL(
    "../.env.development.sample", import.meta.url), "utf8")).values;
  const run = (shell = {}) =>
    ({ ...Object.fromEntries(sample), ...shell, ...e2eEnv(8895) });

  it("never reads production, though development does", () => {
    assert.equal(sample.get("STOCK_SOURCE"), "production");
    assert.equal(productionRead(Object.fromEntries(sample)), true);
    assert.equal(productionRead(run()), false);
    assert.equal(productionRead(run({ STOCK_SOURCE: "production" })), false);
  });

  it("keeps the fakes and STOCK_OVERRIDES", async () => {
    const env = run({ STOCK_OVERRIDES: `${TWO}:1` });
    const prod = production();
    const counts = await liveCounts(testStores(),
      { env, production: via(prod.fetchImpl) });

    assert.equal(env.SQUARE_ENV, "fake");
    assert.equal(env.PAYPAL_ENV, "fake");
    assert.equal(prod.seen.length, 0);
    assert.equal(counts[TWO], 1);
  });

  it("is what serve.mjs runs with", () => {
    const serve = readFileSync(new URL("../bin/e2e/serve.mjs",
      import.meta.url), "utf8");

    assert.match(serve, /Object\.assign\(process\.env, e2eEnv\(port\)\)/);
  });
});

describe("productionStock", () => {
  it("maps production's answer onto the SKUs asked, by SKU", async () => {
    const { fetchImpl, seen } = production();
    const out = await productionStock(
      [TWO, ONE, WINGS, CORNISH, "NFF-NOT-SOLD"], { fetchImpl });

    assert.deepEqual(out, { [TWO]: 2, [ONE]: 1, [WINGS]: 0 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, PRODUCTION_STOCK_URL);
    assert.equal(seen[0].init.method, "GET");
    assert.equal(seen[0].init.body, undefined);
    // No credential of any kind goes to production.
    assert.deepEqual(Object.keys(seen[0].init.headers), ["Accept"]);
  });

  it("is production's public answer, on the site's own host", () => {
    assert.equal(new URL(PRODUCTION_STOCK_URL).host,
      new URL(RECORDED.request.url).host);
  });

  it("throws on a 429 or any answer but 200", async () => {
    for (const status of [429, 500, 503]) {
      await assert.rejects(productionStock([TWO],
        { fetchImpl: production({ status }).fetchImpl }),
      (error) => error.status === status);
    }
  });

  it("throws on a timeout, a network error or a body not JSON",
    async () => {
      const timeout = async () => {
        throw Object.assign(new Error("slow"), { name: "TimeoutError" });
      };
      const down = async () => {
        throw new TypeError("fetch failed");
      };
      const garbled = async () => new Response("<html>", { status: 200 });

      await assert.rejects(productionStock([TWO], { fetchImpl: timeout }),
        (error) => error.code === "timeout");
      await assert.rejects(productionStock([TWO], { fetchImpl: down }));
      await assert.rejects(productionStock([TWO], { fetchImpl: garbled }));
    });
});

describe("liveCounts with the stock source", () => {
  it("reads production's counts by SKU over staging's own", async () => {
    const stores = testStores();
    const sandbox = reader({ [EGGS_VARIATION]: 9 });
    const prod = production({ items: {
      [EGGS]: { inStock: true, available: 2 },
    } });

    await stores.stock.set("counts", { [CORNISH]: 3 });
    const counts = await liveCounts(stores, {
      env: staging, inventory: sandbox.read,
      production: via(prod.fetchImpl),
    });

    assert.equal(prod.seen.length, 1);
    assert.equal(counts[EGGS], 2);
    assert.equal(counts[TWO], 2);
    assert.equal(counts[ONE], 1);
    assert.equal(counts[WINGS], 0);
    // Uncounted in production: staging's own count stands.
    assert.equal(counts[CORNISH], 3);
    assert.ok(!("NFF-NOT-SOLD" in counts));
  });

  it("reads production's counts in development, over the fake Square",
    async () => {
      const stores = testStores();
      const dev = { SITE_CONTEXT: "dev", SQUARE_ENV: "fake",
        STOCK_SOURCE: "production" };
      const prod = production();

      await stores.stock.set("counts", { [CORNISH]: 3 });
      // The fake driver's own read, not a stub: it counts nothing.
      const counts = await liveCounts(stores,
        { env: dev, production: via(prod.fetchImpl), snapshot: true });

      assert.equal(prod.seen.length, 1);
      assert.equal(counts[TWO], 2);
      assert.equal(counts[ONE], 1);
      assert.equal(counts[WINGS], 0);
      assert.equal(counts[CORNISH], 3);
    });

  it("keeps a SKU missing from production's answer as before",
    async () => {
      const stores = testStores();
      const answer = production();
      const fetchImpl = async (url, init) => {
        const res = await answer.fetchImpl(url, init);
        const body = await res.json();

        delete body.items[BIRD];

        return new Response(JSON.stringify(body), { status: 200 });
      };

      await stores.stock.set("counts", { [BIRD]: 5 });
      const counts = await liveCounts(stores,
        { env: staging, production: via(fetchImpl) });

      assert.equal(counts[BIRD], 5);
      assert.equal(counts[TWO], 2);
    });

  it("hides wings 3.0 lbs and up, which production has none of",
    async () => {
      const items = await availability(testStores(), {
        counts: await liveCounts(testStores(), {
          env: staging, production: via(production().fetchImpl),
        }),
      });

      assert.deepEqual(items[WINGS], { inStock: false, available: 0 });
      assert.deepEqual(items[ONE], { inStock: true, available: 1 });
    });

  it("keeps production's in a snapshot of its own", async () => {
    const stores = testStores();
    const now = new Date(Date.UTC(2026, 9, 28, 12));
    const prod = production();
    const opts = { env: staging, production: via(prod.fetchImpl),
      inventory: reader(null).read, snapshot: true, now };

    await liveCounts(stores, opts);
    await liveCounts(stores, opts);
    assert.equal(prod.seen.length, 1);

    const kept = await stores.stock.get(PRODUCTION_SNAPSHOT);

    assert.equal(kept.at, now.toISOString());
    assert.equal(kept.counts[TWO], 2);
    assert.ok(!(CORNISH in kept.counts));
    assert.deepEqual(await stores.stock.get(SNAPSHOT),
      { at: now.toISOString(), counts: null });
  });

  for (const [what, fetchImpl] of [
    ["rate-limits staging", production({ status: 429 }).fetchImpl],
    ["is down", production({ status: 503 }).fetchImpl],
    ["times out", async () => {
      throw Object.assign(new Error("slow"), { name: "TimeoutError" });
    }],
  ]) {
    it(`keeps staging's own counts when production ${what}`, async (t) => {
      const lines = warnings(t);
      const stores = testStores();
      const sandbox = reader({ [EGGS_VARIATION]: 9 });

      await stores.stock.set("counts", { [TWO]: 7 });
      const counts = await liveCounts(stores, {
        env: staging, inventory: sandbox.read, production: via(fetchImpl),
      });

      assert.equal(counts[EGGS], 9);
      assert.equal(counts[TWO], 7);
      assert.deepEqual(lines.map((l) => l.event),
        ["stock.production_unread"]);
    });
  }

  it("asks a failing production once per snapshot, and logs it once",
    async (t) => {
      const lines = warnings(t);
      const stores = testStores();
      const now = new Date(Date.UTC(2026, 9, 28, 12));
      const prod = production({ status: 429 });
      const opts = { env: staging, production: via(prod.fetchImpl),
        inventory: reader(null).read, snapshot: true, now };

      await stores.stock.set("counts", { [TWO]: 7 });
      for (let i = 0; i < 3; i++) {
        assert.equal((await liveCounts(stores, opts))[TWO], 7);
      }
      assert.equal(prod.seen.length, 1);
      assert.equal(lines.filter(
        (l) => l.event === "stock.production_unread").length, 1);
    });

  it("says in the order check's log which counts it sold by",
    async (t) => {
      const lines = [];

      t.mock.method(console, "info", (text) => lines.push(JSON.parse(text)));
      t.mock.method(console, "warn", () => {});
      for (const [status, source] of [[200, "production"],
        [429, "staging"]]) {
        await liveCounts(testStores(), {
          env: staging, inventory: reader(null).read, check: "order",
          production: via(production({ status }).fetchImpl),
        });
        assert.equal(lines.at(-1).event, "stock.checked");
        assert.equal(lines.at(-1).source, source);
      }
    });

  it("lets STOCK_OVERRIDES win over production's counts", async () => {
    const env = { ...staging,
      STOCK_OVERRIDES: `${TWO}:0,${WINGS}:1` };
    const items = await availability(testStores(), {
      counts: await liveCounts(testStores(),
        { env, production: via(production().fetchImpl) }),
    });

    assert.deepEqual(items[TWO], { inStock: false, available: 0 });
    assert.deepEqual(items[WINGS], { inStock: true, available: 1 });
    // The rest read from production.
    assert.deepEqual(items[ONE], { inStock: true, available: 1 });
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
    const prod = production();
    const counts = await liveCounts(testStores(), {
      env, inventory: square.read, production: via(prod.fetchImpl),
    });

    assert.equal(prod.seen.length, 0);
    assert.equal(counts[EGGS], 7);
  });

  it("asks production nothing in the unit suite, by default", async (t) => {
    const lines = warnings(t);

    // The suite's setup (test/setup.mjs) keeps no STOCK_SOURCE and no
    // context.
    assert.equal(process.env.STOCK_SOURCE, undefined);
    assert.equal(productionRead(), false);
    // The real read: it would reach the network, which fails the file.
    await liveCounts(testStores(), { inventory: reader(null).read });
    assert.deepEqual(lines, []);
  });

  it("asks production nothing with the read off", async () => {
    const prod = production();

    await liveCounts(testStores(), {
      env: { ...staging, STOCK_SOURCE: "" },
      inventory: reader(null).read, production: via(prod.fetchImpl),
    });
    assert.equal(prod.seen.length, 0);
  });
});
