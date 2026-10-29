// Checkout applies a signed-in customer's perks (#514): free delivery
// takes the fee off, the minimum waived lets a small delivery through,
// an expired perk does neither, and a perk never spends a pass.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import terms from "../data/delivery.json" with { type: "json" };
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { computeTotals } from "../assets/scripts/order/lib/totals.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { handle } from "../netlify/functions/orders.mjs";
import {
  createSession, publicCustomer,
} from "../netlify/functions/lib/auth.mjs";
import { getPass, issuePass } from "../netlify/functions/lib/passes.mjs";
import { addPerk } from "../netlify/functions/lib/perks.mjs";
import { getCustomer, getOrder } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { MORNING } from "./schedule-fixture.mjs";

const now = instant("2026-10-06", 9, 0, "America/New_York");
const KEY = "5b1d0f3e-2c4a-4e6b-9a8d-7c6b5a4f3e2d";
const SKU = "NFF-CHK-WHL-35-39";
const PAT = "pat@example.com";
const index = indexCatalog(catalog);
const quiet = { sleep: async () => {} };

const square = () => ({
  createOrder: async () => ({ squareOrderId: "SQO", customerId: "CUST" }),
  createPayment: async () => ({
    squarePaymentId: "PAY", status: "COMPLETED", receiptUrl: null,
    brand: "VISA", last4: "4242", wallet: null,
  }),
  cancelOrder: async (id) => ({ id, cancelled: true }),
  findPaid: async () => null,
});

// A delivery of `qty` chickens at $30, with the total the page shows.
const delivery = (qty, claimedTotal, extra = {}) => ({
  idempotencyKey: KEY,
  attempt: 1,
  customer: {
    firstName: "Pat", lastName: "Example", email: PAT,
    phone: "401-555-0100", contact: "call",
  },
  lines: [{ sku: SKU, qty }],
  fulfilment: {
    method: "delivery",
    date: "2026-10-08",
    delivery: {
      address1: "1 Main St", town: "Foster", zip: "02825", cooler: "Porch",
    },
  },
  claimedTotal,
  payment: { method: "card", sourceId: "cnon:tok" },
  ...extra,
});

const post = (payload, session) => new Request("http://x/api/orders", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(session ? { cookie: `nff_session=${session.id}` } : {}),
  },
  body: JSON.stringify(payload),
});

const quietLog = (t) => {
  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, () => {});
  }
};

// Pat, signed in, holding `type` from `start` through `end`.
const holder = async (type, { start = "2026-10-01", end = null } = {}) => {
  const stores = testStores();
  const session = await createSession(stores, PAT, { now });

  await addPerk(stores, PAT, type, { start, end, by: "james", now,
    owner: type === "family" });

  return { stores, session };
};

const place = (stores, payload, session) => handle(post(payload, session), {
  stores, square: square(), now, ...quiet,
});

describe("computeTotals with perks", () => {
  const lines = [{ sku: SKU, qty: 1 }];
  const at = (perks, zipStatus = "approved") => computeTotals({
    lines, method: "delivery", index, money: terms.money, zipStatus, perks,
  });

  it("takes the delivery fee and the outside-area fee off for free " +
    "delivery, and names the perks", () => {
    const plain = at([], "unlisted");
    const free = at(["free-delivery"], "unlisted");

    assert.equal(plain.deliveryFee, 800);
    assert.equal(plain.perks, undefined, "no other record changes");
    assert.equal(free.deliveryFee, 0);
    assert.equal(free.areaFee, 0);
    assert.equal(free.feeWaived, true);
    assert.equal(free.total, 3000);
    assert.deepEqual(free.perks, ["free-delivery"]);
  });

  it("leaves the fee alone for the minimum waived alone", () => {
    const t = at(["minimum-waived"]);

    assert.equal(t.deliveryFee, 500);
    assert.equal(t.feeWaived, undefined);
    assert.deepEqual(t.perks, ["minimum-waived"]);
  });
});

describe("POST /api/orders with a perk", () => {
  it("charges no delivery fee for free delivery", async (t) => {
    quietLog(t);

    const { stores, session } = await holder("free-delivery",
      { end: "2027-12-31" });
    // $60 less the $5 tier, and no fee.
    const res = await place(stores, delivery(2, 5500), session);
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.totals.deliveryFee, 0);
    assert.equal(data.totals.feeWaived, true);
    assert.deepEqual(data.totals.perks, ["free-delivery"]);

    const order = await getOrder(stores, data.orderId);

    assert.equal(order.pass, null);
    assert.equal(order.totals.total, 5500);
  });

  it("takes a delivery under the minimum for the minimum waived",
    async (t) => {
      quietLog(t);

      const { stores, session } = await holder("minimum-waived");
      // $30 and the $5 fee: under the $40 minimum.
      const res = await place(stores, delivery(1, 3500), session);
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.totals.deliveryFee, 500);

      const order = await getOrder(stores, data.orderId);

      assert.equal(order.flags.minimumWaived, true);
    });

  it("applies no perk once it has ended, with no step to end it",
    async (t) => {
      quietLog(t);

      const { stores, session } = await holder("minimum-waived",
        { end: "2026-10-05" });
      const res = await place(stores, delivery(1, 3500), session);

      assert.equal(res.status, 422);
      assert.match((await res.json()).errors["delivery.minimum"],
        /Delivery requires \$40/);
    });

  it("applies none to an order not signed in, whatever its email",
    async (t) => {
      quietLog(t);

      const { stores } = await holder("free-delivery");
      const res = await place(stores, delivery(2, 5500));

      assert.equal(res.status, 422);
      assert.equal((await res.json()).totals.total, 6000);
    });

  it("never spends a pass on what a perk already lifts", async (t) => {
    quietLog(t);

    const { stores, session } = await holder("minimum-waived");
    const pass = await issuePass(stores, { email: PAT, now });
    const res = await place(stores, delivery(1, 3500, { pass: pass.code }),
      session);
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal((await getOrder(stores, data.orderId)).pass, null);

    const after = await getPass(stores, pass.code);

    assert.equal(after.usedBy, null);
    assert.equal(after.heldBy, null);
  });

  it("still uses a fee pass for the fee a minimum perk leaves", async (t) => {
    quietLog(t);

    const { stores, session } = await holder("minimum-waived");
    const pass = await issuePass(stores, { email: PAT, waiveFee: true, now });
    const res = await place(stores, delivery(1, 3000, { pass: pass.code }),
      session);
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal((await getOrder(stores, data.orderId)).pass, pass.code);
    assert.equal((await getPass(stores, pass.code)).usedBy, data.orderId);
  });
});

describe("the perks /api/me shows", () => {
  it("are those in force today, in public shape", async (t) => {
    quietLog(t);

    const { stores } = await holder("free-delivery", { end: "2027-12-31" });

    await addPerk(stores, PAT, "minimum-waived", {
      start: "2026-09-01", end: "2026-09-30", now,
    });

    const c = await getCustomer(stores, PAT);

    assert.deepEqual(publicCustomer(c, now).perks, [
      { type: "free-delivery", start: "2026-10-01", end: "2027-12-31" },
    ]);
  });
});

// Keeps the fixture's import honest: a pickup ignores perks entirely.
describe("a pickup with a perk", () => {
  it("has no fee to waive and pays as before", async (t) => {
    quietLog(t);

    const { stores, session } = await holder("free-delivery");
    const res = await place(stores, {
      ...delivery(2, 5500),
      fulfilment: {
        method: "onfarm", date: "2026-10-07", onfarm: { window: MORNING },
      },
    }, session);
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.totals.feeWaived, undefined);
  });
});
