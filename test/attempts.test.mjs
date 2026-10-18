// A submission's earlier attempts are kept and reconciled before a
// later one is paid (#268): a lost answer after a taken payment must
// never lead to a second charge.

/* eslint-disable camelcase -- Square names its fields its way */
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
import { PayPalError } from "../netlify/functions/lib/paypal.mjs";
import { findPaid } from "../netlify/functions/lib/square.mjs";
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
  let made = 0;
  const paypal = {
    createOrder: async (o, k) => {
      calls.push(["create", k]);
      made += 1;

      return { paypalOrderId: `PPO-${made}` };
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
    const states = {};
    const { paypal } = paypalWith(states);
    const options = { paypal, square: squareOk(), ...mailbox(), ...quiet };

    await startVenmo(stores, order(), { key: KEY, attempt: 1 }, options);
    await startVenmo(stores, order(), { key: KEY, attempt: 2 }, options);
    // Only now does PayPal say the first was paid.
    states["PPO-1"] = "COMPLETED";

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
      const states = {};
      const { paypal } = paypalWith(states);
      const options = {
        paypal, square: squareOk(), ...mailbox(), ...quiet,
        env: { ADMIN_EMAILS: "farm@x.com" },
      };

      await startVenmo(stores, order(), { key: KEY, attempt: 1 }, options);
      await startVenmo(stores, order(), { key: KEY, attempt: 2 }, options);
      await finishVenmo(stores, order(), {
        key: KEY, attempt: 2, paypalOrderId: "PPO-2",
      }, options);
      states["PPO-1"] = "COMPLETED";

      const first = await checkoutByPayPal(stores, "PPO-1");

      assert.equal(await rescueCheckout(stores, first, {
        ...options, now: later(PAGE_GRACE),
      }), null);
      assert.ok(await readMark(stores, "alert/payment.unreconciled"));
    });
});

describe("a later Venmo attempt, before it is paid", () => {
  it("records an earlier attempt PayPal already captured, and starts " +
    "no new payment", async () => {
    const stores = testStores();
    const states = {};
    const { paypal, calls } = paypalWith(states);
    const options = { paypal, square: squareOk(), ...mailbox(), ...quiet };

    await startVenmo(stores, order(), { key: KEY, attempt: 1 }, options);
    // The capture went through; the answer, and the record, were lost.
    states["PPO-1"] = "COMPLETED";

    const edited = order({ notes: "Gate code 1234" });
    const out = await startVenmo(stores, edited, { key: KEY, attempt: 2 },
      options);

    assert.equal(out.paypalOrderId, undefined);
    assert.equal(out.paid.status, "paid");
    assert.equal(out.paid.payments[0].paypalOrderId, "PPO-1");
    assert.equal(out.paid.notes, "", "the order that was paid is kept");
    assert.equal(calls.filter((c) => c[0] === "create").length, 1,
      "no second PayPal order");
    assert.equal((await getOrder(stores, "NFF-2610-ABCD")).status, "paid");
  });

  it("tells the farm when the cart changed after the payment, and " +
    "answers with the order that was paid", async () => {
    const stores = testStores();
    const states = {};
    const { paypal } = paypalWith(states);
    const options = {
      paypal, square: squareOk(), ...mailbox(), ...quiet,
      env: { ADMIN_EMAILS: "farm@x.com" },
    };

    await startVenmo(stores, order(), { key: KEY, attempt: 1 }, options);
    states["PPO-1"] = "COMPLETED";

    // An unchanged cart (only a note differs) raises nothing.
    const same = await startVenmo(stores, order({ notes: "Gate" }),
      { key: KEY, attempt: 2 }, options);

    assert.equal(same.paid.totals.total, 6000);
    assert.equal(await readMark(stores, "alert/payment.unreconciled"), null);

    const stores2 = testStores();

    await startVenmo(stores2, order(), { key: KEY, attempt: 1 }, options);
    states["PPO-2"] = "COMPLETED";

    const bigger = order({
      totals: { ...order().totals, total: 9000, subtotal: 9500 },
    });
    const out = await startVenmo(stores2, bigger, { key: KEY, attempt: 2 },
      options);

    assert.equal(out.paid.totals.total, 6000, "what they paid for");
    assert.equal(out.paid.payments[0].amount, 6000);

    const raised = await readMark(stores2, "alert/payment.unreconciled");

    assert.ok(raised, "the farm is told");
  });

  it("starts the new payment when the earlier one was not paid",
    async () => {
      const stores = testStores();
      const { paypal, calls } = paypalWith({ "PPO-1": "APPROVED" });
      const options = { paypal, square: squareOk(), ...mailbox(), ...quiet };

      await startVenmo(stores, order(), { key: KEY, attempt: 1 }, options);

      const out = await startVenmo(stores, order(), { key: KEY, attempt: 2 },
        options);

      assert.equal(out.paypalOrderId, "PPO-2");
      assert.ok(calls.some((c) => c[0] === "get" && c[1] === "PPO-1"));
      assert.equal(await getOrder(stores, "NFF-2610-ABCD"), null);
    });

  it("passes over an earlier order PayPal has forgotten", async () => {
    const stores = testStores();
    const { paypal } = paypalWith();
    const options = { paypal, square: squareOk(), ...mailbox(), ...quiet };

    await startVenmo(stores, order(), { key: KEY, attempt: 1 }, options);

    const gone = {
      ...paypal,
      getOrder: async () => {
        throw new PayPalError("PayPal 404", { status: 404 });
      },
    };
    const out = await startVenmo(stores, order(), { key: KEY, attempt: 2 },
      { ...options, paypal: gone });

    assert.equal(out.paypalOrderId, "PPO-2");
  });

  it("starts nothing when PayPal cannot say", async () => {
    const stores = testStores();
    const { paypal, calls } = paypalWith();
    const options = { paypal, square: squareOk(), ...mailbox(), ...quiet };

    await startVenmo(stores, order(), { key: KEY, attempt: 1 }, options);

    const down = {
      ...paypal,
      getOrder: async () => {
        throw new PayPalError("PayPal 503", { status: 503, retryable: true });
      },
    };

    await assert.rejects(
      startVenmo(stores, order(), { key: KEY, attempt: 2 },
        { ...options, paypal: down }),
      (e) => e.retryable === true
    );
    assert.equal(calls.filter((c) => c[0] === "create").length, 1);
    assert.equal((await getCheckout(stores, KEY)).attempt, 1);
  });

  it("does not ask on the first attempt", async () => {
    const stores = testStores();
    const { paypal, calls } = paypalWith();

    await startVenmo(stores, order(), { key: KEY, attempt: 1 },
      { paypal, ...quiet });
    assert.ok(!calls.some((c) => c[0] === "get"));
  });
});

describe("findPaid", () => {
  const sq = {
    SQUARE_ACCESS_TOKEN: "tok", SQUARE_LOCATION_ID: "LOC",
    SQUARE_ENV: "sandbox",
  };
  const ID = "NFF-2610-ABCD";
  // Square answers each path from a list of pages, in turn.
  const host = ({ pages, payment }) => {
    const calls = [];
    let page = 0;
    const impl = async (url, init) => {
      const path = new URL(url).pathname;

      calls.push({
        path, method: init.method, body: init.body ? JSON.parse(init.body)
          : null,
      });

      if (path === "/v2/orders/search") {
        return new Response(JSON.stringify(pages[page++] || {}),
          { status: 200 });
      }

      return new Response(JSON.stringify({ payment }), { status: 200 });
    };

    return { impl, calls };
  };
  const completed = {
    id: "PAY-1", status: "COMPLETED", receipt_url: "https://r",
    amount_money: { amount: 6000, currency: "USD" },
    card_details: { card: { card_brand: "VISA", last_4: "4242" } },
  };
  const find = (impl, extra = {}) => findPaid(order(), {
    env: sq, fetchImpl: impl, now, ...extra,
  });

  it("finds the payment on the order with this reference", async () => {
    const { impl, calls } = host({
      pages: [{ orders: [
        { id: "O-OTHER", reference_id: "NFF-2610-ZZZZ",
          tenders: [{ payment_id: "PAY-X" }] },
        { id: "O-1", reference_id: ID, customer_id: "C-1",
          tenders: [{ id: "T-1", payment_id: "PAY-1" }] },
      ] }],
      payment: completed,
    });
    const found = await find(impl);

    assert.equal(found.squarePaymentId, "PAY-1");
    assert.equal(found.squareOrderId, "O-1");
    assert.equal(found.customerId, "C-1");
    assert.equal(found.amount, 6000);
    assert.equal(found.last4, "4242");
    assert.equal(found.external, false);

    const search = calls[0];

    assert.equal(search.body.location_ids[0], "LOC");
    assert.equal(search.body.query.filter.date_time_filter.created_at
      .start_at, "2026-10-04T13:00:00.000Z", "two days back");
    assert.equal(calls[1].path, "/v2/payments/PAY-1");
    assert.equal(calls[1].method, "GET");
  });

  it("reads on through the pages, and ends without a payment", async () => {
    const { impl, calls } = host({
      pages: [
        { orders: [{ id: "O-A", reference_id: "x" }], cursor: "c1" },
        { orders: [{ id: "O-B", reference_id: ID, tenders: [] }] },
      ],
    });

    assert.equal(await find(impl), null);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.cursor, "c1");
  });

  it("ignores an order with a payment that is not complete", async () => {
    const { impl } = host({
      pages: [{ orders: [{ id: "O-1", reference_id: ID,
        tenders: [{ payment_id: "PAY-1" }] }] }],
      payment: { ...completed, status: "FAILED" },
    });

    assert.equal(await find(impl), null);
  });

  it("marks money that came through Venmo", async () => {
    const { impl } = host({
      pages: [{ orders: [{ id: "O-1", reference_id: ID,
        tenders: [{ payment_id: "PAY-1" }] }] }],
      payment: { ...completed, source_type: "EXTERNAL" },
    });

    assert.equal((await find(impl)).external, true);
  });

  it("does not guess when there are more orders than it can read",
    async () => {
      const page = { orders: [], cursor: "more" };
      const { impl } = host({ pages: [page, page, page, page, page] });

      await assert.rejects(find(impl), (e) => e.name === "SquareError"
        && e.retryable === false && e.code === "search.too_many");
    });

  it("is answered by the fake as nothing paid", async () => {
    assert.equal(await findPaid(order(), {
      env: { SQUARE_ENV: "fake", SITE_CONTEXT: "dev" },
    }), null);
  });
});
