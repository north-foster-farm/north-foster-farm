// The e2e suite's stock pins (#507): the scope id, its cookie, the
// pins a test sets, and the teardown that removes them whatever
// happened (e2e/support/stock.mjs). The deploy's side is in
// test/stock-pins.test.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sweepPins } from "../bin/e2e/sweep.mjs";
import {
  SCOPE_COOKIE, TTL_SECONDS, scopeCookie, scopeFor, stockFixtures, stockFor,
} from "../e2e/support/stock.mjs";
import { SCOPE } from "../netlify/functions/lib/stock-pins.mjs";

const info = (over = {}) => ({
  project: { name: "desktop" },
  testId: "a1b2c3d4e5f6-0123456789abcdef0123",
  retry: 0,
  ...over,
});

const recorder = () => {
  const calls = [];

  return {
    calls,
    ops: async (name, args) => {
      calls.push([name, JSON.parse(JSON.stringify(args))]);

      return {};
    },
  };
};

describe("the stock scope", () => {
  it("is one the deploy reads, and new for every test and retry", () => {
    const ids = [
      scopeFor(info()), scopeFor(info()),
      scopeFor(info({ retry: 1 })),
      scopeFor(info({ project: { name: "phone & co" } })),
      scopeFor(info({ testId: "x".repeat(200) })),
    ];

    for (const id of ids) assert.match(id, SCOPE);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("goes as a cookie on the deploy's own host only", () => {
    assert.deepEqual(scopeCookie("scope-1234",
      "https://staging--north-foster-farm.netlify.app"), {
      name: SCOPE_COOKIE, value: "scope-1234",
      domain: "staging--north-foster-farm.netlify.app", path: "/",
      httpOnly: true, secure: true, sameSite: "Lax", expires: -1,
    });
    // A local run is plain http.
    assert.equal(scopeCookie("scope-1234", "http://localhost:8888").secure,
      false);
  });
});

describe("a test's pins", () => {
  it("lay each set over the last and send the whole", async () => {
    const { calls, ops } = recorder();
    const stock = stockFor("scope-1234", { ops });

    await stock.pin({ A: 99, B: 99 });
    await stock.pin({ B: 0 }, { ttlSeconds: 60 });
    await stock.unpin();
    await stock.unpin();

    assert.deepEqual(calls, [
      ["stock.pin", { scope: "scope-1234", counts: { A: 99, B: 99 },
        ttlSeconds: TTL_SECONDS }],
      ["stock.pin", { scope: "scope-1234", counts: { A: 99, B: 0 },
        ttlSeconds: 60 }],
      ["stock.unpin", { scope: "scope-1234" }],
    ]);
  });

  it("ask nothing of the deploy when none was set", async () => {
    const { calls, ops } = recorder();

    await stockFor("scope-1234", { ops }).unpin();
    assert.deepEqual(calls, []);
  });
});

describe("the stock fixture", () => {
  const [fixture, options] = stockFixtures.stock;

  it("runs for every test", () => {
    assert.equal(options.auto, true);
  });

  it("removes the pins when the test fails", async (t) => {
    const calls = [];

    // The deploy's back office, answered here: the fixture calls it
    // through `op` (e2e/support/staging.mjs).
    t.mock.method(globalThis, "fetch", async (url, init) => {
      calls.push(JSON.parse(init.body).op);

      return new Response("{}", { status: 200 });
    });

    await assert.rejects(fixture({
      stockScope: "scope-1234", stockPins: { A: 1 },
    }, async () => {
      throw new Error("the test failed");
    }), /the test failed/);
    assert.deepEqual(calls, ["stock.pin", "stock.unpin"]);
  });
});

describe("the sweep of stock pins", () => {
  it("removes the lapsed ones and says how many", async () => {
    const { calls, ops } = recorder();

    assert.equal(await sweepPins({
      ops: async (name, args) => {
        await ops(name, args);

        return { removed: 2 };
      },
    }), "2 lapsed removed");
    assert.deepEqual(calls, [["stock.sweep", {}]]);
  });

  it("touches nothing on a dry run, and survives a failure", async () => {
    const { calls, ops } = recorder();

    assert.match(await sweepPins({ dryRun: true, ops }), /would remove/);
    assert.deepEqual(calls, []);
    assert.match(await sweepPins({
      ops: async () => {
        throw new Error("e2e stock.sweep: 502");
      },
    }), /sweep failed .*lapse by themselves/);
  });
});
