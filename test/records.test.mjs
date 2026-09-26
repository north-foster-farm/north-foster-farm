import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHECKOUT_TTL, OPEN, allOrders, amendOrder, byPaymentKey, checkoutByPayPal,
  deleteCheckout, deleteOrder, getCheckout, getCustomer, getOrder,
  moneyPatch, openOrders, orderByPayment, ordersFor, paidTotal, paymentRef,
  paymentsOf, refundedTotal, refundsOf, saveCheckout, saveOrder, setStatus,
  sweepCheckouts, touchCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-10-06T13:00:00Z");
const later = new Date("2026-10-06T14:00:00Z");

// An order is born paid; a Venmo one carries its PayPal capture too.
const order = (id, email = "pat@example.com", at = "2026-10-06T13:00:00Z") => ({
  id,
  status: "paid",
  submittedAt: at,
  paidAt: at,
  customer: { name: "Pat Example", email, phone: "" },
  lines: [{ sku: "X", qty: 1 }],
  totals: { total: 100 },
  fulfilment: { method: "onfarm", date: "2026-10-07" },
  square: { squareOrderId: "SQO", customerId: "CUST" },
  payment: {
    via: "square", method: "card", at, squarePaymentId: `PAY-${id}`,
    receiptUrl: "https://r/x", brand: "VISA", last4: "4242",
  },
});

describe("order records", () => {
  it("save with a history line and the indexes", async () => {
    const stores = testStores();

    await saveOrder(stores, order("NFF-1"), now);

    const saved = await getOrder(stores, "NFF-1");

    assert.equal(saved.history[0].event, "paid");
    assert.deepEqual(
      (await ordersFor(stores, "Pat@Example.com")).map((o) => o.id), ["NFF-1"]
    );
    assert.deepEqual((await openOrders(stores)).map((o) => o.id), ["NFF-1"]);
    assert.deepEqual(OPEN, ["paid"]);
  });

  it("save twice as one record", async () => {
    const stores = testStores();

    await saveOrder(stores, order("NFF-1"), now);
    await saveOrder(stores, order("NFF-1"), now);
    assert.equal((await allOrders(stores)).length, 1);
    assert.equal((await ordersFor(stores, "pat@example.com")).length, 1);
  });

  it("list a customer's orders newest first", async () => {
    const stores = testStores();

    await saveOrder(stores, order("NFF-A", undefined, "2026-10-01T00:00:00Z"));
    await saveOrder(stores, order("NFF-B", undefined, "2026-10-03T00:00:00Z"));
    await saveOrder(stores, order("NFF-C", "other@example.com"));
    assert.deepEqual(
      (await ordersFor(stores, "pat@example.com")).map((o) => o.id),
      ["NFF-B", "NFF-A"]
    );
  });

  it("find an order by the payment that paid it", async () => {
    const stores = testStores();
    const venmo = order("NFF-2");

    venmo.payment = {
      via: "venmo", method: "venmo", at: now.toISOString(),
      squarePaymentId: "PAY-NFF-2", paypalOrderId: "PPO-2",
      paypalCaptureId: "CAP-2",
    };
    await saveOrder(stores, order("NFF-1"), now);
    await saveOrder(stores, venmo, now);

    assert.equal(byPaymentKey("PAY-NFF-1"), "by-payment/PAY-NFF-1");
    assert.equal((await orderByPayment(stores, "PAY-NFF-1")).id, "NFF-1");
    assert.equal((await orderByPayment(stores, "PAY-NFF-2")).id, "NFF-2");
    assert.equal((await orderByPayment(stores, "CAP-2")).id, "NFF-2",
      "the PayPal capture names it too");
    assert.equal(await orderByPayment(stores, "PPO-2"), null,
      "the PayPal order id is not a payment");
    assert.equal(await orderByPayment(stores, "nope"), null);

    // A record with no payment (before the checkout moved onto the
    // page) indexes nothing and saves all the same.
    const legacy = { ...order("NFF-3"), status: "submitted", payment: null };

    await saveOrder(stores, legacy, now);
    assert.equal((await getOrder(stores, "NFF-3")).status, "submitted");
  });

  it("change status, stamp the time and leave the open index", async () => {
    const stores = testStores();

    await saveOrder(stores, order("NFF-1"), now);
    assert.equal((await openOrders(stores)).length, 1, "paid is open");

    const done = await setStatus(stores, "NFF-1", "fulfilled", later);

    assert.equal(done.status, "fulfilled");
    assert.equal(done.fulfilledAt, later.toISOString());
    assert.equal(done.history.at(-1).event, "fulfilled");
    assert.equal((await openOrders(stores)).length, 0);

    const again = await setStatus(stores, "NFF-1", "fulfilled", later);

    assert.equal(again.history.length, 2, "a repeat is not a new line");
    assert.equal(await setStatus(stores, "NFF-9", "paid", later), null);
  });

  it("cancelled orders leave the open index; a legacy unpaid one is not " +
    "open either", async () => {
    const stores = testStores();

    await saveOrder(stores, order("NFF-1"), now);
    await saveOrder(stores, { ...order("NFF-2"), status: "submitted" }, now);
    assert.deepEqual((await openOrders(stores)).map((o) => o.id), ["NFF-1"]);

    const cancelled = await setStatus(stores, "NFF-1", "cancelled", later, {
      source: "farm",
    });

    assert.equal(cancelled.cancelledAt, later.toISOString());
    assert.equal(cancelled.history.at(-1).source, "farm");
    assert.equal((await openOrders(stores)).length, 0);
    assert.equal((await ordersFor(stores, "pat@example.com")).length, 2);
  });

  it("amend with an event", async () => {
    const stores = testStores();

    await saveOrder(stores, order("NFF-1"), now);

    const amended = await amendOrder(
      stores, "NFF-1", { notes: "gate code 1234" }, "notes.changed", later
    );

    assert.equal(amended.notes, "gate code 1234");
    assert.equal(amended.history.at(-1).event, "notes.changed");
    assert.equal(await amendOrder(stores, "NFF-9", {}, "x", later), null);
  });

  it("delete cleanly, indexes included", async () => {
    const stores = testStores();

    await saveOrder(stores, order("NFF-1"), now);
    assert.equal(await deleteOrder(stores, "NFF-1"), true);
    assert.equal(await getOrder(stores, "NFF-1"), null);
    assert.equal((await ordersFor(stores, "pat@example.com")).length, 0);
    assert.equal((await openOrders(stores)).length, 0);
    assert.equal(await orderByPayment(stores, "PAY-NFF-1"), null);
    assert.equal(await deleteOrder(stores, "NFF-1"), false);
  });
});

describe("the money on an order", () => {
  const old = {
    id: "NFF-OLD", status: "paid", submittedAt: "2026-09-20T12:00:00Z",
    customer: { email: "pat@example.com" }, totals: { total: 1400 },
    payment: { via: "square", squarePaymentId: "PAY-1" },
    refund: { amount: 400, squareRefundId: "R-1" },
  };

  it("reads an old record's single payment and refund as lists", () => {
    assert.deepEqual(paymentsOf(old),
      [{ amount: 1400, via: "square", squarePaymentId: "PAY-1" }]);
    assert.deepEqual(refundsOf(old), [old.refund]);
    assert.equal(paidTotal(old), 1400);
    assert.equal(refundedTotal(old), 400);
    assert.deepEqual(paymentsOf({ ...old, payment: null }), []);
    assert.deepEqual(refundsOf({ ...old, refund: undefined }), []);
    assert.deepEqual(paymentsOf(null), []);
  });

  it("names a payment by its processor's id", () => {
    assert.equal(paymentRef({ squarePaymentId: "PAY-1" }), "PAY-1");
    assert.equal(paymentRef({ squarePaymentId: "PAY-2",
      paypalCaptureId: "CAP-2" }), "CAP-2", "Venmo goes by the capture");
    assert.equal(paymentRef(null), null);
  });

  it("rewrites an old record in the list shape when its money changes, " +
    "and indexes every payment", async () => {
    const stores = testStores();

    await saveOrder(stores, old);
    const saved = await amendOrder(stores, "NFF-OLD", moneyPatch(old, {
      payments: [...paymentsOf(old), {
        amount: 600, via: "venmo", paypalCaptureId: "CAP-2",
      }],
    }), "test");

    assert.equal(saved.payment, undefined);
    assert.equal(saved.refund, undefined);
    assert.equal(saved.payments.length, 2);
    assert.deepEqual(saved.refunds, [old.refund]);
    assert.equal((await orderByPayment(stores, "PAY-1")).id, "NFF-OLD");
    assert.equal((await orderByPayment(stores, "CAP-2")).id, "NFF-OLD");

    await deleteOrder(stores, "NFF-OLD");
    assert.equal(await stores.orders.get(byPaymentKey("CAP-2")), null);
  });
});

describe("checkouts", () => {
  const checkout = (key, at = now) => ({
    key,
    attempt: 1,
    at: at.toISOString(),
    order: order(`NFF-${key}`),
    paypalOrderId: `PPO-${key}`,
  });

  it("are kept by key and found by their PayPal order", async () => {
    const stores = testStores();

    await saveCheckout(stores, checkout("k1"));
    assert.equal((await getCheckout(stores, "k1")).paypalOrderId, "PPO-k1");
    assert.equal((await checkoutByPayPal(stores, "PPO-k1")).key, "k1");
    assert.equal(await checkoutByPayPal(stores, "PPO-zz"), null);
    assert.equal(await getCheckout(stores, "zz"), null);

    // Without a PayPal order there is nothing to index.
    await saveCheckout(stores, { ...checkout("k2"), paypalOrderId: null });
    assert.equal((await getCheckout(stores, "k2")).key, "k2");
    assert.equal((await stores.orders.list("by-paypal/")).length, 1);
  });

  it("are deleted with their index", async () => {
    const stores = testStores();

    await saveCheckout(stores, checkout("k1"));
    assert.equal(await deleteCheckout(stores, "k1"), true);
    assert.equal(await getCheckout(stores, "k1"), null);
    assert.equal(await checkoutByPayPal(stores, "PPO-k1"), null);
    assert.equal(await deleteCheckout(stores, "k1"), false);
  });

  it("are swept once older than the TTL", async () => {
    const stores = testStores();
    const old = new Date(now.getTime() - CHECKOUT_TTL - 60_000);
    const fresh = new Date(now.getTime() - CHECKOUT_TTL + 60_000);

    await saveCheckout(stores, checkout("old", old));
    await saveCheckout(stores, checkout("fresh", fresh));
    assert.equal(await sweepCheckouts(stores, now), 1);
    assert.equal(await getCheckout(stores, "old"), null);
    assert.equal(await checkoutByPayPal(stores, "PPO-old"), null);
    assert.equal((await getCheckout(stores, "fresh")).key, "fresh");
    assert.equal(await sweepCheckouts(stores, now), 0);
    assert.equal(CHECKOUT_TTL, 24 * 60 * 60_000);
  });
});

describe("customer records", () => {
  it("are created from a first order and only filled in after", async () => {
    const stores = testStores();
    const first = await touchCustomer(stores, {
      firstName: "Pat", lastName: "Example", name: "Pat Example",
      email: "Pat@Example.com", phone: "",
    }, now);

    assert.equal(first.email, "pat@example.com");
    assert.equal(first.firstName, "Pat");
    assert.equal(first.lastName, "Example");
    assert.equal(first.discountGroup, null);
    assert.equal(first.createdAt, now.toISOString());

    const second = await touchCustomer(stores, {
      name: "Patricia Example", email: "pat@example.com", phone: "4015550100",
    }, later);

    assert.equal(second.name, "Pat Example", "a chosen name is kept");
    assert.equal(second.firstName, "Pat", "and so are its parts");
    assert.equal(second.phone, "4015550100", "a blank phone is filled");
    assert.equal(second.lastOrderAt, later.toISOString());
    assert.equal((await getCustomer(stores, "PAT@example.com")).createdAt,
      now.toISOString());
  });

  it("opt in to farm news from an order, and never out", async () => {
    const stores = testStores();
    const who = { name: "Pat Example", email: "pat@example.com", phone: "" };
    const first = await touchCustomer(stores, who, now);

    assert.equal(first.marketing, false, "off unless ticked");
    assert.equal(first.marketingAt, null);

    const ticked = await touchCustomer(stores, { ...who, marketing: true },
      later);

    assert.equal(ticked.marketing, true);
    assert.equal(ticked.marketingAt, later.toISOString());
    assert.equal(ticked.marketingSource, "order");

    const unticked = await touchCustomer(stores, who, later);

    assert.equal(unticked.marketing, true, "an unticked box changes nothing");
    assert.equal(unticked.marketingAt, later.toISOString(), "same date");
  });
});
