// Criteria tests for #684: a credit restore applied twice moves the
// balance once. Held out of `npm test` by its name; turn it on with
//
//   git mv test/credit-restore-once.criteria.mjs \
//     test/credit-restore-once.test.mjs
//
// One test per box of the issue's "Done when", named for it. Written
// from the boxes alone, before any fix, on next at 8919d5b8.
//
// The issue's spec: a restore records which refund it came from (the
// refund's id), and a restore whose refund id the ledger already holds
// changes nothing. These tests hand restoreCredit that id as
// `refundId`, beside `orderId`, `amount` and `now`. The issue names
// no argument, so the name is this test's guess: the implementer may
// pass the id another way (setup, not an expectation). The tests read
// only balances and holds, never the field the fix adds to an entry.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The client sleeps 5 s before each retry unless NODE_ENV is test
// (src/retry.ts), and test/setup.mjs drops NODE_ENV. Set before the
// client loads (as test/store-conditional.test.mjs does).
process.env.NODE_ENV = "test";

const { getStore } = await import("@netlify/blobs");
const {
  creditBalance, getLedger, grantCredit, heldBy, restoreCredit,
  spendCredit,
} = await import("../netlify/functions/lib/credit.mjs");
const { testStores, wrap } = await import(
  "../netlify/functions/lib/store.mjs");
const { instant } = await import("../assets/scripts/order/lib/zoned.mjs");

const tz = "America/New_York";
const ny = (iso, h = 9) => instant(iso, h, 0, tz);
const EMAIL = "pat@example.com";
const ORDER = "NFF-2611-K3WM";
const EDGE = "https://blobs.test";

// A refund's id: lib/admin.mjs keys each refund `refund-<order>-<ms>-
// <payment>`.
const refund = (n) => `refund-${ORDER}-176400000000${n}-0`;

// The edge API of the customers store, the shape
// test/cancel-lost-write.test.mjs and test/store-conditional.test.mjs
// fake: GET, PUT with If-Match / If-None-Match, DELETE, each answered
// with a bare status and an etag. `after(n, stored)` runs after the nth
// PUT has been stored or refused (`stored`) and may answer it itself
// with a status.
const edge = (seed, after) => {
  const blobs = new Map();
  let tag = 0;
  let puts = 0;
  const put = (path, text) => {
    tag += 1;
    blobs.set(path, { text, etag: `"e${tag}"` });
  };

  for (const [path, value] of seed) put(path, JSON.stringify(value));

  const fetch = async (url, options = {}) => {
    const path = decodeURIComponent(new URL(url).pathname);
    const method = (options.method || "get").toLowerCase();
    const headers = options.headers || {};
    const found = blobs.get(path);

    if (method === "get") {
      return found
        ? new Response(found.text, {
          status: 200, headers: { etag: found.etag },
        })
        : new Response(null, { status: 404 });
    }
    if (method === "delete") {
      blobs.delete(path);

      return new Response(null, { status: 204 });
    }
    if (method !== "put") throw new Error(`fake edge: no ${method}`);

    puts += 1;

    const n = puts;
    const refused = (headers["if-match"]
      && (!found || found.etag !== headers["if-match"]))
      || (headers["if-none-match"] === "*" && found);

    if (!refused) put(path, options.body);

    const own = await after(n, !refused);

    if (own) return new Response(null, { status: own });

    return refused
      ? new Response(null, { status: 412 })
      : new Response(null, {
        status: 200, headers: { etag: blobs.get(path).etag },
      });
  };

  return { fetch };
};

// A ledger as next's lib/credit.mjs wrote it at 8919d5b8, before #684:
// grants of $12 and $8, $15 of them spent on one order, and a partial
// refund of $7 put back. Not written by hand: printed from a memory
// store after grantCredit, grantCredit, spendCredit and restoreCredit
// ran with these values, 2026-11-20. Worth $12 now; the order holds $8.
const BEFORE = {
  email: EMAIL,
  entries: [
    {
      id: "vff/2026-11-08/share",
      amount: 1200,
      from: { group: "vff", round: "2026-11-08", kind: "share" },
      grantedAt: "2026-11-09T14:00:00.000Z",
      expiresAt: "2027-01-01T04:59:00.000Z",
      spent: [
        { orderId: ORDER, amount: 1200, at: "2026-11-24T15:00:00.000Z" },
        {
          orderId: ORDER, amount: -700, at: "2026-11-25T16:00:00.000Z",
          refund: true,
        },
      ],
    },
    {
      id: "vff/2026-11-22/host",
      amount: 800,
      from: { group: "vff", round: "2026-11-22", kind: "host" },
      grantedAt: "2026-11-23T14:00:00.000Z",
      expiresAt: "2027-01-01T04:59:00.000Z",
      spent: [
        { orderId: ORDER, amount: 300, at: "2026-11-24T15:00:00.000Z" },
      ],
    },
  ],
};

// A member with a $20 grant, $15 of it spent on ORDER: worth $5.
const member = async (stores) => {
  await grantCredit(stores, EMAIL, {
    amount: 2_000, from: { group: "vff", round: "2026-11-22", kind: "host" },
    now: ny("2026-11-23"), timeZone: tz,
  });
  await spendCredit(stores, EMAIL, {
    orderId: ORDER, amount: 1_500, now: ny("2026-11-24"),
  });
};

describe("a credit restore (#684)", () => {
  it("applies the same restore twice to one ledger, as the race " +
    "would, and the balance moves once", async (t) => {
    t.mock.method(console, "warn", () => {});

    const now = ny("2026-11-25");
    const memory = testStores();

    await member(memory);

    // The ledger on a Blobs-backed customers store: the real client
    // and lib/store.mjs's wrap, as on Netlify.
    const key = `credit/${EMAIL}`;
    const stores = {};
    let restorePut = 0;
    let raced = false;
    const fake = edge(
      [[`/site/site:customers/${key}`, memory.customers.data.get(key)]],
      async (n, stored) => {
        // The restore's write lands and its answer is lost. Before the
        // client's retry and the read-back, another writer changes the
        // same ledger: a grant from the next round, through
        // grantCredit. The retry then meets a 412 and the read-back
        // finds the other writer's ledger, not the restore's.
        if (raced || n !== restorePut || !stored) return null;
        raced = true;
        await grantCredit(stores, EMAIL, {
          amount: 300,
          from: { group: "vff", round: "2026-12-06", kind: "share" },
          now: ny("2026-12-07"), timeZone: tz,
        });

        return 500;
      },
    );

    stores.customers = wrap(getStore({
      name: "customers", siteID: "site", token: "t",
      consistency: "strong", edgeURL: EDGE, uncachedEdgeURL: EDGE,
      fetch: fake.fetch,
    }));
    assert.equal(await creditBalance(stores, EMAIL, now), 500, "setup");

    // A partial refund of $4: the order still holds $11 after it, so
    // a second application would find more to put back.
    restorePut = 1;
    await restoreCredit(stores, EMAIL, {
      orderId: ORDER, amount: 400, refundId: refund(1), now,
    }).catch(() => {});

    assert.equal(raced, true, "setup: the race was forced");

    const later = ny("2026-12-08");

    // $5, the $4 restored once, and the other writer's $3 grant kept.
    assert.equal(await creditBalance(stores, EMAIL, later), 1_200);
    assert.equal(heldBy(await getLedger(stores, EMAIL), ORDER), 1_100);
  });

  it("restores their own amount for each of two different partial " +
    "refunds of one order", async () => {
    const now = ny("2026-11-25");
    const stores = testStores();

    await member(stores);

    const one = await restoreCredit(stores, EMAIL, {
      orderId: ORDER, amount: 400, refundId: refund(1), now,
    });

    assert.equal(one.restored, 400);
    assert.equal(await creditBalance(stores, EMAIL, now), 900);

    const two = await restoreCredit(stores, EMAIL, {
      orderId: ORDER, amount: 600, refundId: refund(2), now,
    });

    assert.equal(two.restored, 600);
    assert.equal(await creditBalance(stores, EMAIL, now), 1_500);

    // A third refund of the same amount as the first is its own
    // refund, not the first one again.
    const three = await restoreCredit(stores, EMAIL, {
      orderId: ORDER, amount: 400, refundId: refund(3), now,
    });

    assert.equal(three.restored, 400);
    assert.equal(await creditBalance(stores, EMAIL, now), 1_900);
    assert.equal(heldBy(await getLedger(stores, EMAIL), ORDER), 100);
  });

  it("reads a ledger written before the change and restores from it " +
    "as before", async () => {
    const now = ny("2026-11-26");
    const stores = testStores();

    await stores.customers.set(`credit/${EMAIL}`,
      JSON.parse(JSON.stringify(BEFORE)));

    // It reads: worth $12, the order holding $8.
    assert.equal(await creditBalance(stores, EMAIL, now), 1_200);
    assert.equal(heldBy(await getLedger(stores, EMAIL), ORDER), 800);

    // A new partial refund puts back its $5.
    const one = await restoreCredit(stores, EMAIL, {
      orderId: ORDER, amount: 500, refundId: refund(4), now,
    });

    assert.equal(one.restored, 500);
    assert.equal(await creditBalance(stores, EMAIL, now), 1_700);

    // A refund of more than the order holds puts back only the $3
    // left, as a restore always has.
    const two = await restoreCredit(stores, EMAIL, {
      orderId: ORDER, amount: 1_000, refundId: refund(5), now,
    });

    assert.equal(two.restored, 300);
    assert.equal(await creditBalance(stores, EMAIL, now), 2_000);
    assert.equal(heldBy(await getLedger(stores, EMAIL), ORDER), 0);
  });
});
