import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TENDERS, createFarmOrder, payFarmOrder, planFarmOrder,
} from "../netlify/functions/lib/farm-orders.mjs";
import { readMark } from "../netlify/functions/lib/health.mjs";
import {
  dueOn, getCustomer, openOrders, paymentsOf, setStatus,
} from "../netlify/functions/lib/records.mjs";
import { getCounts, setCount } from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { MORNING, SCHEDULE } from "./schedule-fixture.mjs";

const now = instant("2026-10-06", 9, 0, "America/New_York");
const SKU = "NFF-CHK-WHL-35-39";
const env = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  PICKUP_SCHEDULE: SCHEDULE,
};
const KEY = "farm-0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f";

const body = (overrides = {}) => ({
  customer: {
    firstName: "Pat", lastName: "Example", email: "pat@example.com",
    phone: "401-555-0100", contact: "call",
  },
  lines: [{ sku: SKU, qty: 2 }],
  fulfilment: {
    method: "onfarm", date: "2026-10-07", onfarm: { window: MORNING },
  },
  ...overrides,
});

// A Square that records what it is asked, and answers each payment
// with its own id unless told to repeat one.
const fakeSquare = ({ repeat = false } = {}) => {
  const calls = [];
  let n = 0;
  const square = {
    createOrder: async (order, key) => {
      calls.push(["order", key, order.id]);

      return { squareOrderId: "SQO", customerId: "CUST" };
    },
    createPayment: async (args) => {
      calls.push(["payment", args.key, args.amount, args.source]);
      if (!repeat) n += 1;

      return {
        squarePaymentId: `PAY-${n || 1}`, status: "COMPLETED",
        receiptUrl: null, brand: null, last4: null, wallet: null,
      };
    },
    completeOrder: async (id) => {
      calls.push(["complete", id]);

      return { id, completed: true };
    },
  };

  return { square, calls };
};

const mailbox = () => {
  const sent = [];

  return { sent, mail: async (m) => { sent.push(m); return { id: "m" }; } };
};

const make = async (stores, options = {}) => {
  const { square, calls } = fakeSquare();
  const { sent, mail } = mailbox();
  const r = await createFarmOrder(stores, body(), {
    key: KEY, now, env, mail, square, ...options,
  });

  return { r, calls, sent, square, mail };
};

describe("planFarmOrder", () => {
  it("prices the order as the page would, with the farm's overrides",
    async () => {
      const stores = testStores();
      const r = await planFarmOrder(stores, body(), { now, env });

      assert.equal(r.ok, true);
      assert.equal(r.order.totals.total, 5500);
      assert.equal(r.order.flags.totalMismatch, false);
      assert.equal(r.order.fulfilment.state, "agreed");
      assert.equal(r.order.lines[0].sku, SKU);
    });

  it("refuses what the page refuses: an unknown item, a missing name",
    async () => {
      const stores = testStores();
      const none = await planFarmOrder(stores, body({ lines: [] }),
        { now, env });
      const nameless = await planFarmOrder(stores, body({
        customer: { email: "pat@example.com" },
      }), { now, env });

      assert.equal(none.ok, false);
      assert.ok(none.errors.lines);
      assert.equal(nameless.ok, false);
      assert.ok(nameless.errors["customer.firstName"]);
    });

  it("names a SKU it does not know instead of dropping it", async () => {
    const stores = testStores();
    const r = await planFarmOrder(stores, body({
      lines: [{ sku: SKU, qty: 1 }, { sku: "EGG", qty: 1 }],
    }), { now, env });

    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, { "lines.EGG": "No such SKU: EGG." });
  });

  it("holds the farm to the delivery minimum unless it waives it",
    async () => {
      const stores = testStores();
      const small = body({
        lines: [{ sku: SKU, qty: 1 }],
        fulfilment: {
          method: "delivery", date: "2026-10-08",
          delivery: { address1: "1 Main St", town: "Foster", zip: "02825",
            cooler: "Porch" },
        },
      });
      const held = await planFarmOrder(stores, small, { now, env });
      const waived = await planFarmOrder(stores,
        { ...small, waiveMinimum: true }, { now, env });

      assert.equal(held.ok, false);
      assert.ok(held.errors["delivery.minimum"]);
      assert.equal(waived.ok, true);
      assert.equal(waived.order.flags.minimumWaived, true);
    });

  it("refuses more than the stock holds", async () => {
    const stores = testStores();

    await setCount(stores, SKU, 1);

    const r = await planFarmOrder(stores, body(), { now, env });

    assert.equal(r.ok, false);
    assert.ok(r.errors[`lines.${SKU}`]);
  });
});

describe("createFarmOrder", () => {
  it("makes an unpaid order: the Square order, the record, the stock, " +
    "the customer, and no email", async () => {
    const stores = testStores();

    await setCount(stores, SKU, 5);

    const { r, calls, sent } = await make(stores);

    assert.equal(r.ok, true);
    assert.match(r.order.id, /^NFF-2610-[A-Z2-9]{6}$/);
    assert.equal(r.order.status, "unpaid");
    assert.deepEqual(paymentsOf(r.order), []);
    assert.equal(dueOn(r.order), 5500);
    assert.deepEqual(r.order.square, { squareOrderId: "SQO",
      customerId: "CUST" });
    assert.equal(r.order.meta.source, "farm");
    assert.equal(r.order.meta.idempotencyKey, KEY);
    assert.deepEqual(calls.map((c) => c[0]), ["order"]);
    assert.deepEqual((await openOrders(stores)).map((o) => o.id),
      [r.order.id], "open: the jobs remind and close it");
    assert.equal((await getCounts(stores))[SKU], 3);
    assert.ok(await getCustomer(stores, "pat@example.com"));
    assert.deepEqual(sent, []);
    assert.ok(await readMark(stores, "order"));
  });

  it("finds the order the same key made, instead of making a second",
    async () => {
      const stores = testStores();
      const first = await make(stores);
      const again = await make(stores);

      assert.equal(again.r.order.id, first.r.order.id);
      assert.equal(again.r.found, true);
      assert.deepEqual(again.calls, [], "nothing asked of Square");
    });

  it("records money already in hand: paid from the start, in Square " +
    "and on the record, with the confirmation", async () => {
    const stores = testStores();
    const { r, calls, sent } = await make(stores, {
      paid: { tender: "cash" },
    });

    assert.equal(r.ok, true);
    assert.equal(r.order.status, "paid");
    assert.ok(r.order.paidAt);
    assert.equal(dueOn(r.order), 0);
    assert.deepEqual(paymentsOf(r.order).map((p) => [p.via, p.amount,
      p.squarePaymentId, p.by]), [["cash", 5500, "PAY-1", "farm"]]);
    assert.deepEqual(calls[1].slice(0, 1), ["payment"]);
    assert.equal(calls[1][2], 5500);
    assert.deepEqual(calls[1][3], { cash: true });
    assert.ok(sent.some((m) => /order/i.test(m.subject)),
      "the usual confirmation goes");
    assert.ok(await readMark(stores, "paid"));
  });

  it("tells Square a Venmo payment by its reference, and a check as a " +
    "check", async () => {
    const stores = testStores();
    const venmo = await make(stores, {
      paid: { tender: "venmo", ref: "VENMO-123" },
    });
    const check = await make(stores, {
      key: `${KEY}-2`, paid: { tender: "check", ref: "1042" },
    });

    assert.deepEqual(venmo.calls[1][3], {
      external: { type: "SOCIAL", source: "Venmo", sourceId: "VENMO-123" },
    });
    assert.equal(paymentsOf(venmo.r.order)[0].via, "venmo");
    assert.equal(paymentsOf(venmo.r.order)[0].ref, "VENMO-123");
    assert.deepEqual(check.calls[1][3], {
      external: { type: "CHECK", source: "Check", sourceId: "1042" },
    });
    assert.equal(paymentsOf(check.r.order)[0].via, "check");
  });

  it("refuses a tender it does not know, and an amount over the total",
    async () => {
      const stores = testStores();
      const odd = await make(stores, { paid: { tender: "goats" } });
      const much = await make(stores, {
        paid: { tender: "cash", amount: 5501 },
      });

      assert.equal(odd.r.ok, false);
      assert.ok(odd.r.errors.paid);
      assert.equal(much.r.ok, false);
      assert.ok(much.r.errors.amount);
      assert.deepEqual(much.calls, [], "nothing reached Square");
    });

  it("a dry run prices and checks, and changes nothing", async () => {
    const stores = testStores();

    await setCount(stores, SKU, 5);

    const { r, calls, sent } = await make(stores, { dryRun: true });

    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.order.totals.total, 5500);
    assert.equal(r.order.id, undefined);
    assert.deepEqual(calls, []);
    assert.deepEqual(sent, []);
    assert.equal((await getCounts(stores))[SKU], 5);
    assert.deepEqual(await openOrders(stores), []);
  });
});

describe("payFarmOrder", () => {
  const unpaid = async (stores) => (await make(stores)).r.order;

  it("records a tender for what is due, and the order is paid", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square, calls } = fakeSquare();
    const { sent, mail } = mailbox();
    const r = await payFarmOrder(stores, order.id, { tender: "cash" }, {
      now, env, mail, square,
    });

    assert.equal(r.ok, true);
    assert.equal(r.order.status, "paid");
    assert.equal(dueOn(r.order), 0);
    assert.equal(r.payment.amount, 5500);
    assert.deepEqual(calls.map((c) => c[0]), ["payment"],
      "on the order's own Square order, never a second one");
    assert.equal(calls[0][2], 5500);
    assert.ok(sent.length, "the confirmation goes once it is paid");
    assert.deepEqual(r.order.history.map((h) => h.event).slice(0, 3),
      ["unpaid", "farm.paid", "paid"]);
  });

  it("takes part of what is due, then the rest; never more; whole cents",
    async () => {
      const stores = testStores();
      const order = await unpaid(stores);
      const { square, calls } = fakeSquare();
      const { sent, mail } = mailbox();
      const opts = { now, env, mail, square };
      const part = await payFarmOrder(stores, order.id,
        { tender: "cash", amount: 2000 }, opts);

      assert.equal(part.ok, true);
      assert.equal(part.order.status, "unpaid");
      assert.equal(dueOn(part.order), 3500);
      assert.deepEqual(sent, [], "not paid yet, no confirmation");

      const over = await payFarmOrder(stores, order.id,
        { tender: "cash", amount: 3501 }, opts);
      const cents = await payFarmOrder(stores, order.id,
        { tender: "cash", amount: 35.5 }, opts);

      assert.equal(over.ok, false);
      assert.ok(over.errors.amount);
      assert.equal(cents.ok, false);
      assert.ok(cents.errors.amount);
      assert.equal(calls.length, 1, "neither reached Square");

      const rest = await payFarmOrder(stores, order.id,
        { tender: "venmo", ref: "V-1" }, opts);

      assert.equal(rest.ok, true);
      assert.equal(rest.order.status, "paid");
      assert.deepEqual(paymentsOf(rest.order).map((p) => [p.via, p.amount]),
        [["cash", 2000], ["venmo", 3500]]);
      assert.notEqual(calls[0][1], calls[1][1], "each tender its own key");

      const none = await payFarmOrder(stores, order.id, { tender: "cash" },
        opts);

      assert.equal(none.ok, false);
      assert.ok(none.errors.order);
    });

  it("records a tender Square already holds once: a retry after a lost " +
    "answer does not double it", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square, calls } = fakeSquare({ repeat: true });
    const { mail } = mailbox();
    const opts = { now, env, mail, square };
    const first = await payFarmOrder(stores, order.id,
      { tender: "cash", amount: 2000 }, opts);
    // The same amount again: Square answers with the same payment.
    const again = await payFarmOrder(stores, order.id,
      { tender: "cash", amount: 2000 }, opts);

    assert.equal(first.ok, true);
    assert.equal(again.ok, true);
    assert.equal(paymentsOf(again.order).length, 1);
    assert.equal(dueOn(again.order), 3500);
    assert.equal(calls.length, 2, "Square was asked, and said the same");
  });

  it("completes a delivered-first order in Square once it is paid",
    async () => {
      const stores = testStores();
      const order = await unpaid(stores);

      await setStatus(stores, order.id, "fulfilled", now, { source: "jobs" });

      const { square, calls } = fakeSquare();
      const { mail } = mailbox();
      const r = await payFarmOrder(stores, order.id, { tender: "cash" }, {
        now, env, mail, square,
      });

      assert.equal(r.ok, true);
      assert.equal(r.order.status, "fulfilled");
      assert.ok(r.order.paidAt);
      assert.deepEqual(calls.map((c) => c[0]), ["payment", "complete"]);
    });

  it("refuses a cancelled order and an unknown one", async () => {
    const stores = testStores();
    const order = await unpaid(stores);

    await setStatus(stores, order.id, "cancelled", now, { source: "farm" });

    const { square } = fakeSquare();
    const gone = await payFarmOrder(stores, order.id, { tender: "cash" },
      { now, env, square });
    const none = await payFarmOrder(stores, "NFF-0000-XXXXXX",
      { tender: "cash" }, { now, env, square });

    assert.equal(gone.ok, false);
    assert.equal(none.ok, false);
    assert.deepEqual(Object.keys(TENDERS), ["cash", "check", "venmo"]);
  });
});
