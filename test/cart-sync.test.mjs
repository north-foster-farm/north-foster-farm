import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cartOf, settle,
} from "../assets/scripts/order/lib/cart-sync.mjs";
import { getCart, saveCart } from "../netlify/functions/lib/account.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import {
  deleteCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/account.mjs";

const now = new Date("2026-10-05T13:00:00Z");
const T = now.getTime();
const pat = { email: "pat@example.com", name: "Pat Example" };

const payload = (lines = [{ sku: "A", qty: 2 }]) => ({
  formVersion: "3",
  customer: { firstName: "Pat", lastName: "Example",
    email: "pat@example.com", phone: "", contact: "text", marketing: false },
  lines,
  fulfilment: { method: "onfarm", date: "2026-10-07",
    onfarm: { window: "morning" }, delivery: {} },
  code: "HELLO",
  claimedTotal: 1400,
  idempotencyKey: "k",
  attempt: 2,
  website: "",
});

describe("the cart across devices (#149)", () => {
  it("carries the cart and details, not a payment attempt", () => {
    const cart = cartOf(payload([
      { sku: "A", qty: 2 }, { sku: "B", qty: 0 }, { sku: "", qty: 1 },
      { sku: "C", qty: 500 },
    ]));

    assert.deepEqual(cart.lines, [{ sku: "A", qty: 2 }, { sku: "C", qty: 99 }]);
    assert.equal(cart.code, "HELLO");
    assert.equal(cart.customer.firstName, "Pat");
    assert.equal(cart.fulfilment.onfarm.window, "morning");
    assert.equal(cart.fulfilment.delivery.address1, "");
    for (const key of ["claimedTotal", "idempotencyKey", "attempt",
      "website"]) {
      assert.equal(key in cart, false, key);
    }
    assert.deepEqual(cartOf("junk").lines, []);
  });

  it("the copy saved last wins", () => {
    const local = { payload: payload(), savedAt: 200 };

    assert.equal(settle(local, null), "local");
    assert.equal(settle(null, null), null);
    assert.equal(settle(local, { payload: payload(), savedAt: 300 }),
      "remote");
    assert.equal(settle(local, { payload: payload(), savedAt: 100 }),
      "local");
    assert.equal(settle(local, { payload: payload(), savedAt: 200 }), null);
    assert.equal(settle(null, { payload: payload(), savedAt: 100 }),
      "remote");
    // An order placed elsewhere clears an older cart here.
    assert.equal(settle(local, { payload: null, savedAt: 300 }), "remote");
  });

  it("keeps the newer copy and says which stands", async () => {
    const stores = testStores();

    assert.deepEqual(await getCart(stores, pat), { ok: true, cart: null });

    const first = await saveCart(stores, pat,
      { payload: payload(), savedAt: T - 1000 }, { now });

    assert.equal(first.kept, true);
    assert.equal(first.cart.payload.idempotencyKey, undefined);

    const older = await saveCart(stores, pat,
      { payload: payload([]), savedAt: T - 2000 }, { now });

    assert.equal(older.kept, false);
    assert.deepEqual(older.cart.payload.lines, [{ sku: "A", qty: 2 }]);

    const cleared = await saveCart(stores, pat,
      { payload: null, savedAt: T - 500 }, { now });

    assert.equal(cleared.kept, true);
    assert.deepEqual((await getCart(stores, pat)).cart,
      { payload: null, savedAt: T - 500 });
  });

  it("brings a fast clock back to the server's", async () => {
    const stores = testStores();
    const saved = await saveCart(stores, pat,
      { payload: payload(), savedAt: T + 60_000 }, { now });

    assert.equal(saved.cart.savedAt, T);
  });

  it("refuses a cart with no time or no shape", async () => {
    const stores = testStores();

    for (const body of [{ payload: payload() }, { payload: "x", savedAt: 1 },
      null, { payload: payload(), savedAt: -1 }]) {
      const result = await saveCart(stores, pat, body, { now });

      assert.equal(result.ok, false);
      assert.equal(result.status, 422);
    }
    assert.equal((await getCart(stores, pat)).cart, null);
  });

  it("goes when the customer does", async () => {
    const stores = testStores();

    await saveCustomer(stores, pat);
    await saveCart(stores, pat, { payload: payload(), savedAt: T }, { now });
    await deleteCustomer(stores, pat.email);
    assert.equal((await getCart(stores, pat)).cart, null);
  });

  it("is routed under the session", async () => {
    const stores = testStores();
    const req = (method, body, cookie) => new Request(
      "https://x/api/account/cart", {
        method,
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "same-origin",
          ...(cookie ? { cookie: `nff_session=${cookie}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    assert.equal((await handle(req("GET"), { stores, now })).status, 401);

    const session = await createSession(stores, pat.email, { now });
    const put = await handle(req("PUT", {
      payload: payload(), savedAt: T,
    }, session.id), { stores, now });

    assert.equal(put.status, 200);
    assert.equal((await put.json()).kept, true);

    const got = await handle(req("GET", undefined, session.id),
      { stores, now });

    assert.deepEqual((await got.json()).cart.payload.lines,
      [{ sku: "A", qty: 2 }]);
  });
});
