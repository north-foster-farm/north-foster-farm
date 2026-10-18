// A submission's earlier attempts are kept and reconciled before a
// later one is paid (#268): a lost answer after a taken payment must
// never lead to a second charge.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PAGE_GRACE, attemptKey, finishVenmo, rescueCheckout, startVenmo,
} from "../netlify/functions/lib/checkout.mjs";
import { readMark } from "../netlify/functions/lib/health.mjs";
import {
  CHECKOUT_TTL, checkoutByPayPal, checkoutsFor, deleteCheckout, getCheckout,
  getOrder, sweepCheckouts,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-10-06T13:00:00Z");
const later = (ms) => new Date(now.getTime() + ms);
const KEY = "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f";
const quiet = { sleep: async () => {}, env: {}, now };

const order = (overrides = {}) => ({
  id: "NFF-2610-ABCD",
  submittedAt: now.toISOString(),
  customer: {
    firstName: "Pat", lastName: "Example", name: "Pat Example",
    email: "pat@example.com", phone: "401-555-0100", contact: "call",
  },
  fulfilment: {
    method: "delivery", date: "2026-10-08", onfarm: null, state: "agreed",
    delivery: {
      address1: "1 Main St", town: "Foster", zip: "02825", cooler: "Porch",
    },
  },
  lines: [{
    sku: "NFF-CHK-WHL-0350-0400", label: "Whole Chicken, 3.5 – 3.9 lbs",
    name: "Whole Chicken, 3.5 – 3.9 lbs", unitPrice: 30, qty: 2,
    lineTotal: 60, squareVariationId: null,
  }],
  totals: {
    subtotal: 6000, discountTier: 50, discountAmount: 500, deliveryFee: 500,
    areaFee: 0, total: 6000, discountLabel: "Bulk discount ($50+)",
  },
  notes: "",
  source: "",
  flags: { zipUnlisted: false, totalMismatch: false },
  meta: { idempotencyKey: KEY, attempt: 1 },
  ...overrides,
});

const squareOk = () => ({
  createOrder: async () => ({ squareOrderId: "SQO", customerId: "CUST" }),
  createPayment: async () => ({
    squarePaymentId: "PAY-V", status: "COMPLETED", receiptUrl: null,
    brand: null, last4: null, wallet: null,
  }),
});

// A PayPal whose orders are numbered by attempt: PPO-1, PPO-2. `states`
// says how each ended, by id.
const paypalWith = (states = {}) => {
  const calls = [];
  const paypal = {
    createOrder: async (o, k) => {
      calls.push(["create", k]);

      return { paypalOrderId: `PPO-${calls.length}` };
    },
    getOrder: async (id) => {
      calls.push(["get", id]);

      return {
        status: states[id] || "CREATED",
        updatedAt: now.toISOString(),
        capture: null,
      };
    },
    captureOrder: async (id, k) => {
      calls.push(["capture", id, k]);

      return {
        paypalOrderId: id, paypalCaptureId: `CAP-${id}`, status: "COMPLETED",
        amount: 6000, payer: { email: "pat@venmo", name: "Pat" },
      };
    },
  };

  return { paypal, calls };
};

const mailbox = () => ({ mail: async () => ({ id: "m", driver: "test" }) });

describe("a submission's checkouts", () => {
  it("keeps the earlier attempt when a later one starts", async () => {
    const stores = testStores();
    const { paypal } = paypalWith();

    await startVenmo(stores, order(), { key: KEY, attempt: 1 },
      { paypal, ...quiet });
    await startVenmo(stores, order(), { key: KEY, attempt: 2 },
      { paypal, ...quiet });

    assert.equal((await getCheckout(stores, KEY)).paypalOrderId, "PPO-2");
    assert.equal((await getCheckout(stores, KEY, "PPO-1")).attempt, 1);
    assert.equal((await checkoutByPayPal(stores, "PPO-1")).attempt, 1);
    assert.equal((await checkoutByPayPal(stores, "PPO-2")).attempt, 2);
    assert.deepEqual(
      (await checkoutsFor(stores, KEY)).map((c) => c.paypalOrderId),
      ["PPO-2", "PPO-1"]
    );
  });

  it("deletes the one asked for and leaves the others", async () => {
    const stores = testStores();
    const { paypal } = paypalWith();

    await startVenmo(stores, order(), { key: KEY, attempt: 1 },
      { paypal, ...quiet });
    await startVenmo(stores, order(), { key: KEY, attempt: 2 },
      { paypal, ...quiet });

    assert.equal(await deleteCheckout(stores, KEY, "PPO-1"), true);
    assert.equal(await checkoutByPayPal(stores, "PPO-1"), null);
    assert.equal((await getCheckout(stores, KEY)).paypalOrderId, "PPO-2");
    assert.equal((await checkoutsFor(stores, KEY)).length, 1);
  });

  it("sweeps an old attempt like any other checkout", async () => {
    const stores = testStores();
    const { paypal } = paypalWith();

    await startVenmo(stores, order(), { key: KEY, attempt: 1 },
      { paypal, ...quiet });
    await startVenmo(stores, order(), { key: KEY, attempt: 2 },
      { paypal, ...quiet, now: later(CHECKOUT_TTL - 1000) });

    assert.equal(await sweepCheckouts(stores, later(CHECKOUT_TTL + 1000)), 1);
    assert.equal((await checkoutsFor(stores, KEY)).length, 1);
    assert.equal(await checkoutByPayPal(stores, "PPO-1"), null);
  });

  it("finishes the earlier attempt's payment when it is the one " +
    "captured", async () => {
    const stores = testStores();
    const { paypal, calls } = paypalWith();
    const options = { paypal, square: squareOk(), ...mailbox(), ...quiet };

    await startVenmo(stores, order(), { key: KEY, attempt: 1 }, options);
    await startVenmo(stores, order(), { key: KEY, attempt: 2 }, options);

    const saved = await finishVenmo(stores, order(), {
      key: KEY, attempt: 1, paypalOrderId: "PPO-1",
    }, options);

    assert.equal(saved.status, "paid");
    assert.equal(saved.payments[0].paypalOrderId, "PPO-1");
    assert.deepEqual(calls.find((c) => c[0] === "capture"),
      ["capture", "PPO-1", attemptKey(KEY, 1)]);
    assert.equal((await getCheckout(stores, KEY)).paypalOrderId, "PPO-2",
      "the later attempt's checkout is not the one deleted");
    assert.equal(await checkoutByPayPal(stores, "PPO-1"), null);
  });
});

describe("rescuing an earlier attempt", () => {
  it("records the order when the earlier attempt is the one PayPal " +
    "captured", async () => {
    const stores = testStores();
    const { paypal } = paypalWith({ "PPO-1": "COMPLETED" });
    const options = { paypal, square: squareOk(), ...mailbox(), ...quiet };

    await startVenmo(stores, order(), { key: KEY, attempt: 1 }, options);
    await startVenmo(stores, order(), { key: KEY, attempt: 2 }, options);

    const first = await checkoutByPayPal(stores, "PPO-1");
    const saved = await rescueCheckout(stores, first, {
      ...options, now: later(PAGE_GRACE),
    });

    assert.equal(saved.payments[0].paypalOrderId, "PPO-1");
    assert.equal((await getOrder(stores, "NFF-2610-ABCD")).status, "paid");
  });

  it("never captures an earlier attempt once the order is paid " +
    "another way", async () => {
    const stores = testStores();
    const { paypal, calls } = paypalWith({ "PPO-1": "APPROVED" });
    const options = { paypal, square: squareOk(), ...mailbox(), ...quiet };

    await startVenmo(stores, order(), { key: KEY, attempt: 1 }, options);
    await startVenmo(stores, order(), { key: KEY, attempt: 2 }, options);
    // The order is recorded by the second attempt's payment.
    await finishVenmo(stores, order(), {
      key: KEY, attempt: 2, paypalOrderId: "PPO-2",
    }, options);

    const first = await checkoutByPayPal(stores, "PPO-1");
    const before = calls.filter((c) => c[0] === "capture").length;

    assert.equal(await rescueCheckout(stores, first, {
      ...options, now: later(PAGE_GRACE),
    }), null);
    assert.equal(calls.filter((c) => c[0] === "capture").length, before);
    assert.equal(await readMark(stores, "alert/payment.unreconciled"), null,
      "nothing was captured, so nothing is owed back");
  });

  it("alerts the farm when the earlier attempt was captured too",
    async () => {
      const stores = testStores();
      const { paypal } = paypalWith({ "PPO-1": "COMPLETED" });
      const options = {
        paypal, square: squareOk(), ...mailbox(), ...quiet,
        env: { ADMIN_EMAILS: "farm@x.com" },
      };

      await startVenmo(stores, order(), { key: KEY, attempt: 1 }, options);
      await startVenmo(stores, order(), { key: KEY, attempt: 2 }, options);
      await finishVenmo(stores, order(), {
        key: KEY, attempt: 2, paypalOrderId: "PPO-2",
      }, options);

      const first = await checkoutByPayPal(stores, "PPO-1");

      assert.equal(await rescueCheckout(stores, first, {
        ...options, now: later(PAGE_GRACE),
      }), null);
      assert.ok(await readMark(stores, "alert/payment.unreconciled"));
    });
});
