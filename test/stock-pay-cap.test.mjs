// The check before paying (#908, rule 6) is counted apart from
// browsing, under a cap of its own, so ?final=1 is no way around
// /api/stock's limit. netlify/functions/stock.mjs handle().

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/stock.mjs";

const PAY_CAP = 60;

const pay = (ip) => handle(new Request("http://x/api/stock?final=1"), {
  stores: testStores(), env: { CONTEXT: "production" }, ip,
  inventory: async () => null,
});

describe("the check before paying", () => {
  it("has a cap of its own, per address", async () => {
    for (let i = 0; i < PAY_CAP; i++) {
      assert.equal((await pay("198.51.100.61")).status, 200, `check ${i}`);
    }

    const over = await pay("198.51.100.61");

    assert.equal(over.status, 429);
    assert.equal(over.headers.get("cache-control"), "no-store");
    assert.equal((await pay("198.51.100.62")).status, 200,
      "another address is its own");
  });
});
