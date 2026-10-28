// One test's stock counts, pinned for its own scope on staging (#507,
// James in #453 6458262765): the e2e ops, the scope cookie, the TTL,
// the sweep, and the production refusal.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runOp } from "../netlify/functions/lib/e2e.mjs";
import {
  MAX_TTL_SECONDS, SCOPE_COOKIE, TTL_SECONDS, pin, pinKey, pinsAllowed,
  pinsFor, scopeOf, sweepPins, unpin,
} from "../netlify/functions/lib/stock-pins.mjs";
import {
  availability, checkLines, liveCounts,
} from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle as stagingApi } from "../netlify/functions/staging.mjs";
import { handle as stockApi } from "../netlify/functions/stock.mjs";

const EGGS = "NFF-CHK-EGG-LG";
const EGGS_VARIATION = "S7XJNPQUKY6JSYQOEYSL6FYS";
const WINGS = "NFF-CHK-WNG-10-19";

const SCOPE = "run1-desktop-order-abc123";
const OTHER = "run1-phone-order-def456";

const staging = { SITE_CONTEXT: "branch-deploy", SQUARE_ENV: "sandbox" };
const PRODUCTIONS = [
  { SITE_CONTEXT: "production", SQUARE_ENV: "production" },
  { SITE_CONTEXT: "production", SQUARE_ENV: "sandbox" },
  { CONTEXT: "production" },
  // Production's Square, whatever the context says.
  { SITE_CONTEXT: "branch-deploy", SQUARE_ENV: "production" },
  {},
];

const headers = (scope) => new Headers(scope
  ? { cookie: `nff_gate=x; ${SCOPE_COOKIE}=${scope}` } : {});

const sandbox = (counts) => async () => counts;

const at = (minutes) => new Date(Date.UTC(2026, 9, 28, 12, minutes));

describe("where stock pins apply", () => {
  it("is staging, deploy previews and local development", () => {
    for (const SITE_CONTEXT of ["branch-deploy", "deploy-preview", "dev"]) {
      assert.equal(pinsAllowed({ SITE_CONTEXT, SQUARE_ENV: "sandbox" }), true);
      assert.equal(scopeOf(headers(SCOPE), { SITE_CONTEXT }), SCOPE);
    }
  });

  it("is never production, and the cookie is ignored there", () => {
    for (const env of PRODUCTIONS) {
      assert.equal(pinsAllowed(env), false, JSON.stringify(env));
      assert.equal(scopeOf(headers(SCOPE), env), null);
    }
  });

  it("reads only a well-formed scope", () => {
    for (const bad of ["short", "has space here", "x".repeat(65), "a;b=c"]) {
      assert.equal(scopeOf(new Headers({
        cookie: `${SCOPE_COOKIE}=${bad}`,
      }), staging), null);
    }
    assert.equal(scopeOf(headers(null), staging), null);
  });
});

describe("pin and unpin", () => {
  it("keep a scope's counts until its time, then read as none",
    async () => {
      const stores = testStores();
      const record = await pin(stores, {
        scope: SCOPE, counts: { [EGGS]: 3, [WINGS]: 0 },
      }, { env: staging, now: at(0) });

      assert.equal(record.until, at(TTL_SECONDS / 60).toISOString());
      assert.deepEqual(await pinsFor(stores, SCOPE,
        { env: staging, now: at(14) }), { [EGGS]: 3, [WINGS]: 0 });
      assert.deepEqual(await pinsFor(stores, SCOPE,
        { env: staging, now: at(15) }), {});
      assert.deepEqual(await pinsFor(stores, OTHER,
        { env: staging, now: at(1) }), {});

      await unpin(stores, { scope: SCOPE }, { env: staging });
      assert.equal(await stores.stock.get(pinKey(SCOPE)), null);
    });

  it("refuses what isn't a pin", async () => {
    const stores = testStores();
    const tries = [
      { scope: "short", counts: { [EGGS]: 1 } },
      { scope: SCOPE },
      { scope: SCOPE, counts: {} },
      { scope: SCOPE, counts: [1] },
      { scope: SCOPE, counts: { "NFF-NOT-SOLD": 1 } },
      { scope: SCOPE, counts: { [EGGS]: 1.5 } },
      { scope: SCOPE, counts: { [EGGS]: "2" } },
      { scope: SCOPE, counts: { [EGGS]: 1 }, ttlSeconds: 0 },
      { scope: SCOPE, counts: { [EGGS]: 1 }, ttlSeconds: MAX_TTL_SECONDS + 1 },
    ];

    for (const args of tries) {
      await assert.rejects(pin(stores, args, { env: staging }),
        undefined, JSON.stringify(args));
    }
    assert.deepEqual(await stores.stock.list("pins/"), []);
  });

  it("is refused in production, and a stored pin is never read there",
    async () => {
      const stores = testStores();

      await pin(stores, { scope: SCOPE, counts: { [EGGS]: 0 } },
        { env: staging });
      for (const env of PRODUCTIONS) {
        await assert.rejects(pin(stores, {
          scope: SCOPE, counts: { [EGGS]: 1 },
        }, { env }), /off here/);
        await assert.rejects(unpin(stores, { scope: SCOPE }, { env }),
          /off here/);
        await assert.rejects(sweepPins(stores, { env }), /off here/);
        assert.deepEqual(await pinsFor(stores, SCOPE, { env }), {});

        const counts = await liveCounts(stores, {
          env, scope: SCOPE, inventory: sandbox({ [EGGS_VARIATION]: 7 }),
        });

        assert.equal(counts[EGGS], 7, JSON.stringify(env));
      }
    });
});

describe("liveCounts with a scope", () => {
  it("lays the scope's pins over every source, overrides included",
    async () => {
      const stores = testStores();
      const env = { ...staging, STOCK_OVERRIDES: `${EGGS}:9,${WINGS}:9` };

      await stores.stock.set("counts", { [WINGS]: 4 });
      await pin(stores, { scope: SCOPE, counts: { [EGGS]: 2 } }, { env });

      const pinned = await liveCounts(stores, {
        env, scope: SCOPE, inventory: sandbox({ [EGGS_VARIATION]: 5 }),
      });
      const unpinned = await liveCounts(stores, {
        env, inventory: sandbox({ [EGGS_VARIATION]: 5 }),
      });
      const other = await liveCounts(stores, {
        env, scope: OTHER, inventory: sandbox({ [EGGS_VARIATION]: 5 }),
      });

      assert.equal(pinned[EGGS], 2);
      assert.equal(pinned[WINGS], 9);
      assert.equal(unpinned[EGGS], 9);
      assert.equal(other[EGGS], 9);
    });

  it("holds the order check to the scope's pins", async () => {
    const stores = testStores();
    const lines = [{ sku: EGGS, qty: 2 }];
    const inventory = sandbox({ [EGGS_VARIATION]: 0 });

    await pin(stores, { scope: SCOPE, counts: { [EGGS]: 3 } },
      { env: staging });

    assert.equal((await checkLines(stores, lines,
      { env: staging, inventory, scope: SCOPE })).ok, true);
    assert.equal((await checkLines(stores, lines,
      { env: staging, inventory })).ok, false);
    assert.equal((await checkLines(stores, lines,
      { env: staging, inventory, scope: OTHER })).ok, false);
  });
});

describe("/api/stock with the scope cookie", () => {
  const page = async (stores, env, scope) => (await (await stockApi(
    new Request("https://x/api/stock", { headers: headers(scope) }), {
      stores, env, inventory: sandbox({ [EGGS_VARIATION]: 6 }),
    })).json()).items;

  it("answers a test's browser with its pins, and no one else",
    async () => {
      const stores = testStores();

      await pin(stores, { scope: SCOPE, counts: { [EGGS]: 0 } },
        { env: staging });

      assert.deepEqual((await page(stores, staging, SCOPE))[EGGS],
        { inStock: false, available: 0 });
      assert.deepEqual((await page(stores, staging, null))[EGGS],
        { inStock: true, available: 6 });
      assert.deepEqual((await page(stores, staging, OTHER))[EGGS],
        { inStock: true, available: 6 });
    });

  it("ignores the cookie in production", async () => {
    const stores = testStores();

    await pin(stores, { scope: SCOPE, counts: { [EGGS]: 0 } },
      { env: staging });

    const env = { SITE_CONTEXT: "production", SQUARE_ENV: "production" };

    assert.deepEqual((await page(stores, env, SCOPE))[EGGS],
      { inStock: true, available: 6 });
  });

  it("keeps the pins off the counts the farm's notice reads", async () => {
    const stores = testStores();
    const counts = { [EGGS]: 6 };

    await pin(stores, { scope: SCOPE, counts: { [EGGS]: 0 } },
      { env: staging });
    await page(stores, staging, SCOPE);
    assert.deepEqual((await availability(stores, { counts }))[EGGS],
      { inStock: true, available: 6 });
  });
});

describe("the sweep of pins", () => {
  it("removes pins past their time and leaves those in force",
    async () => {
      const stores = testStores();

      await pin(stores, { scope: SCOPE, counts: { [EGGS]: 1 } },
        { env: staging, now: at(0) });
      await pin(stores, { scope: OTHER, counts: { [EGGS]: 1 } },
        { env: staging, now: at(10) });

      assert.equal(await sweepPins(stores, { env: staging, now: at(20) }), 1);
      assert.deepEqual((await stores.stock.list("pins/")).map((k) => k.key),
        [pinKey(OTHER)]);
    });
});

describe("the stock.pin, stock.unpin and stock.sweep ops", () => {
  it("pin, unpin and sweep on staging", async () => {
    const stores = testStores();
    const pinned = await runOp(stores, {
      op: "stock.pin", scope: SCOPE, counts: { [EGGS]: 1 }, ttlSeconds: 60,
    }, staging);

    assert.equal(pinned.status, 200);
    assert.deepEqual(pinned.body.pin.counts, { [EGGS]: 1 });
    assert.deepEqual(await pinsFor(stores, SCOPE, { env: staging }),
      { [EGGS]: 1 });

    assert.deepEqual(await runOp(stores, { op: "stock.sweep" }, staging),
      { status: 200, body: { removed: 0 } });
    assert.deepEqual(await runOp(stores,
      { op: "stock.unpin", scope: SCOPE }, staging),
    { status: 200, body: { removed: true } });
    assert.deepEqual(await pinsFor(stores, SCOPE, { env: staging }), {});
  });

  it("are refused where SQUARE_ENV is production", async () => {
    const env = { ...staging, SQUARE_ENV: "production" };

    for (const op of ["stock.pin", "stock.unpin", "stock.sweep"]) {
      const done = await runOp(testStores(), {
        op, scope: SCOPE, counts: { [EGGS]: 1 },
      }, env);

      assert.equal(done.status, 400);
      assert.match(done.body.error, /off here/);
    }
  });

  it("are a 404 on the production build", async () => {
    const stores = testStores();
    const res = await stagingApi(new Request("https://x/api/staging/e2e", {
      method: "POST",
      headers: {
        Authorization: "Bearer e2e", "Content-Type": "application/json",
      },
      body: JSON.stringify({
        op: "stock.pin", scope: SCOPE, counts: { [EGGS]: 0 },
      }),
    }), {
      stores,
      env: { SITE_CONTEXT: "production", SQUARE_ENV: "production",
        E2E_STAGING_TOKEN: "e2e" },
    });

    assert.equal(res.status, 404);
    assert.deepEqual(await stores.stock.list("pins/"), []);
  });
});
