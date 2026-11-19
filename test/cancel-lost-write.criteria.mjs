// Criteria test for the lost cancel of staging run 44500827895
// (RF-03 on phone, 2026-11-19). Held out of `npm test` by its name;
// turn it on with
//
//   git mv test/cancel-lost-write.criteria.mjs \
//     test/cancel-lost-write.test.mjs
//
// The 412 case passes today; the 409 case fails until the fix.
//
// WHAT THE RUN SHOWED
//
// `nff orders cancel <id> --no-refund` returned without error, yet the
// record read back was `paid`, its history ending paid,
// mail.orderConfirmed, mail.farmOrderPlaced (all stamped at the
// payment), then mail.orderCancelled, with no `cancelled` line.
// cancelOrder (lib/admin.mjs) writes mail.orderCancelled only after
// setStatus has answered with a cancelled record, and that write
// merges into the record as it finds it (amendOrder). So the cancel's
// own write was reported as saved and did not stand: the email's note
// was merged into a record without it. No read in the test can show
// that shape.
//
// The order had been paid 1.7 s before. Its emails go after the
// answer (announceNew in lib/checkout.mjs, by waitUntil), so the
// farm's notice was being noted on the record while the cancel wrote:
// two conditional writes to one blob at once. updateOrder
// (lib/records.mjs) trusts the store's `swap`, which trusts
// @netlify/blobs 11.1.0, and that client answers a conditional PUT
// with `{ modified: true }` for every status but 412 (dist/main.js,
// Store#setJSON: `res.status === 412 ? { modified: false } : { etag,
// modified: true }`). A refusal with any other code, or an error the
// client has stopped retrying, passes as saved. Which code Blobs gave
// that night is not in the log; 409 stands for any of them here.
//
// THE CRITERION
//
// A cancel ends cancelled, whatever writes to the record meanwhile
// and however the store refuses a write that lost: the final record
// is `cancelled`, its history holds `cancelled` and
// `mail.orderCancelled`, and the other writer's change stays too.
//
// The store here is the real @netlify/blobs client over a fake of its
// edge API (GET, PUT with If-Match / If-None-Match, DELETE), so
// lib/store.mjs's wrap, updateOrder and the client all run as on
// Netlify. The interleaving is forced: when the cancel's write of
// `status: "cancelled"` arrives, the farm notice's note is written
// first (through amendOrder, as sendForOrder writes it), and the
// cancel's write is then refused with the code under test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getStore } from "@netlify/blobs";

import { cancelOrder } from "../netlify/functions/lib/admin.mjs";
import { amendOrder, getOrder } from "../netlify/functions/lib/records.mjs";
import { wrap } from "../netlify/functions/lib/store.mjs";
import { env, mail, neverSwitched, now } from "./switched-orders.mjs";

const EDGE = "https://blobs.test";
const FARM = "farmOrderPlaced";

// The edge API of one store, kept in `blobs` by URL path. `before(path,
// body)` may answer a PUT itself (a Response) before the store's own
// rules apply.
const fakeEdge = (seed, before) => {
  const blobs = new Map();
  let n = 0;
  const put = (path, text) => {
    n += 1;
    blobs.set(path, { text, etag: `"e${n}"` });
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

    const early = await before(path, options.body);

    if (early) return early;
    if (headers["if-match"] && (!found || found.etag !== headers["if-match"])) {
      return new Response(null, { status: 412 });
    }
    if (headers["if-none-match"] === "*" && found) {
      return new Response(null, { status: 412 });
    }
    put(path, options.body);

    return new Response(null, {
      status: 200, headers: { etag: blobs.get(path).etag },
    });
  };

  return { fetch, blobs };
};

// A paid order whose farm notice is not yet noted, on a Blobs-backed
// orders store whose first write of the cancel loses to that note and
// is refused with `status`. -> { stores, id, square }
const racing = async (status) => {
  const { stores, id, square } = await neverSwitched();
  const seed = new Map();
  const at = new Date(now.getTime() + 1_700);

  for (const [key, value] of stores.orders.data) {
    const record = key === `order/${id}` ? { ...value } : value;

    if (record === value) {
      seed.set(`/site/site:orders/${key}`, value);
      continue;
    }
    // The notice is noted after the answer: not on the record yet.
    record.emails = { ...record.emails };
    delete record.emails[FARM];
    record.history = record.history.filter((h) => h.event !== `mail.${FARM}`);
    seed.set(`/site/site:orders/${key}`, record);
  }

  let forced = false;
  const edge = fakeEdge(seed, async (path, body) => {
    if (forced || path !== `/site/site:orders/order/${id}`) return null;
    if (JSON.parse(body).status !== "cancelled") return null;
    forced = true;
    // The note of the farm notice (announceNew) lands first.
    await amendOrder(stores, id, (f) => ({
      emails: { ...(f.emails || {}), [FARM]: { at: now.toISOString() } },
    }), `mail.${FARM}`, now);

    return new Response(null, { status });
  });

  stores.orders = wrap(getStore({
    name: "orders", siteID: "site", token: "t", consistency: "strong",
    edgeURL: EDGE, uncachedEdgeURL: EDGE, fetch: edge.fetch,
  }));

  assert.equal((await getOrder(stores, id)).status, "paid", "setup");

  return { stores, id, square, at, forced: () => forced };
};

describe("a cancel racing another write to the order (RF-03)", () => {
  for (const status of [412, 409]) {
    it(`ends cancelled with its email noted, the other write kept, ` +
      `when the store refuses the losing write with ${status}`,
    async () => {
      const { stores, id, square, at, forced } = await racing(status);

      await cancelOrder(stores, id, {
        now: at, env, mail, square, refund: false,
        reasonText: "Test order.",
      }).catch(() => {});

      assert.equal(forced(), true, "setup: the interleaving was forced");

      const record = await getOrder(stores, id);
      const events = record.history.map((h) => h.event);

      assert.equal(record.status, "cancelled", JSON.stringify(events));
      assert.ok(events.includes("cancelled"), JSON.stringify(events));
      assert.ok(events.includes("mail.orderCancelled"),
        JSON.stringify(events));
      assert.ok(record.emails.orderCancelled, "emails.orderCancelled");
      assert.ok(events.includes(`mail.${FARM}`), JSON.stringify(events));
      assert.ok(record.emails[FARM], `emails.${FARM}`);
      assert.deepEqual(record.refunds || [], []);
    });
  }
});
