import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PENDING_MS, TENDERS, createFarmOrder, payFarmOrder, payOrder,
  planFarmOrder,
} from "../netlify/functions/lib/farm-orders.mjs";
import { SquareError } from "../netlify/functions/lib/square.mjs";
import { readMark } from "../netlify/functions/lib/health.mjs";
import {
  amendOrder, dueOn, getCustomer, getOrder, openOrders, paymentsOf,
  setStatus, updateOrder,
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
    findPaid: async () => null,
    getOrder: async (id) => ({ id, tenders: [] }),
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

  it("refuses a tender it does not know before anything is made",
    async () => {
      const stores = testStores();
      const odd = await make(stores, { paid: { tender: "goats" } });

      assert.equal(odd.r.ok, false);
      assert.ok(odd.r.errors.paid);
      assert.deepEqual(odd.calls, [], "nothing reached Square");
      assert.deepEqual(await openOrders(stores), []);
    });

  it("leaves the order unpaid and names the fix when the tender fails " +
    "after the order is made", async () => {
    const stores = testStores();
    const { square, calls } = fakeSquare();

    square.createPayment = async () => { throw new Error("Square 503"); };

    const r = await createFarmOrder(stores, body(), {
      key: KEY, now, env, mail: mailbox().mail, square,
      paid: { tender: "cash" },
    });

    assert.equal(r.ok, false);
    assert.match(r.errors.paid, /was made and is unpaid/);
    assert.match(r.errors.paid, new RegExp(`orders pay ${r.order.id} --cash`));
    assert.equal(r.order.status, "unpaid");
    assert.deepEqual(calls.map((c) => c[0]), ["order"]);
    assert.equal((await openOrders(stores)).length, 1);
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

  it("takes the whole of what is due, once: a second tender finds " +
    "nothing due", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square, calls } = fakeSquare();
    const { mail } = mailbox();
    const opts = { now, env, mail, square };
    const first = await payFarmOrder(stores, order.id,
      { tender: "venmo", ref: "V-1" }, opts);
    const again = await payFarmOrder(stores, order.id, { tender: "cash" },
      opts);

    assert.equal(first.ok, true);
    assert.equal(first.payment.amount, 5500);
    assert.equal(again.ok, false);
    assert.ok(again.errors.order);
    assert.equal(calls.filter((c) => c[0] === "payment").length, 1);
    assert.equal(await stores.orders.get(`pay-pending/${order.id}`), null,
      "the claim is released");
  });

  it("records a tender Square already holds instead of taking the " +
    "farm's, and says so", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square, calls } = fakeSquare();
    const { sent, mail } = mailbox();

    // A cash write that died after Square took it; the farm runs the
    // command again.
    square.getOrder = async (id) => ({
      id, tenders: [{ id: "T-3", "payment_id": "PAY-CASH", type: "CASH",
        "amount_money": { amount: 5500, currency: "USD" } }],
    });

    const r = await payFarmOrder(stores, order.id, { tender: "cash" },
      { now, env, mail, square });

    assert.equal(r.ok, true);
    assert.equal(r.found, true);
    assert.equal(r.order.status, "paid");
    assert.deepEqual([r.payment.via, r.payment.by, r.payment.squarePaymentId],
      ["cash", "farm", "PAY-CASH"]);
    assert.deepEqual(calls.filter((c) => c[0] === "payment"), []);
    assert.ok(sent.length, "the confirmation goes");
  });

  it("refuses a tender while a payment of the order is under way",
    async () => {
      const stores = testStores();
      const order = await unpaid(stores);
      const { square, calls } = fakeSquare();

      await stores.orders.create(`pay-pending/${order.id}`, {
        key: "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f", attempt: 1,
        at: now.toISOString(),
      });

      const r = await payFarmOrder(stores, order.id, { tender: "cash" },
        { now, env, square });

      assert.equal(r.ok, false);
      assert.match(r.errors.order, /under way/);
      assert.deepEqual(calls, []);

      // A claim older than PENDING_MS no longer holds the order.
      const later = new Date(now.getTime() + PENDING_MS + 1000);
      const after = await payFarmOrder(stores, order.id, { tender: "cash" },
        { now: later, env, mail: mailbox().mail, square });

      assert.equal(after.ok, true);
    });

  it("keeps a write made between its read and its swap", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square } = fakeSquare();
    const { mail } = mailbox();
    const orders = stores.orders;
    const swap = orders.swap;
    let raced = false;

    // Another writer notes the order while the tender is being written.
    orders.swap = async (...args) => {
      if (!raced && args[0] === `order/${order.id}`) {
        raced = true;
        await amendOrder(stores, order.id, { notes: "Ring twice" },
          "farm.changed", now);
      }

      return swap(...args);
    };

    const r = await payFarmOrder(stores, order.id, { tender: "cash" },
      { now, env, mail, square });

    assert.equal(r.ok, true);
    assert.equal(r.order.notes, "Ring twice");
    assert.equal(r.order.status, "paid");
    assert.equal(paymentsOf(r.order).length, 1);
    assert.ok(raced);
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

describe("payOrder: the customer pays later", () => {
  const PAT = { email: "pat@example.com" };
  const SUB = "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f";
  const card = {
    idempotencyKey: SUB, attempt: 1,
    payment: { method: "card", sourceId: "cnon:tok" },
  };
  const unpaid = async (stores) => (await make(stores)).r.order;

  it("takes what is due on the order's own Square order, and the order " +
    "is paid with its confirmation", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square, calls } = fakeSquare();
    const { sent, mail } = mailbox();
    const r = await payOrder(stores, PAT, order.id, card, {
      now, env, mail, square,
    });

    assert.equal(r.ok, true);
    assert.equal(r.difference, 5500);
    assert.equal(r.order.status, "paid");
    assert.equal(r.order.due, 0);
    assert.deepEqual(r.order.payments.map((p) => [p.via, p.method,
      p.amount]), [["square", "card", 5500]]);
    assert.deepEqual(calls.map((c) => c[0]), ["payment"],
      "never a second Square order");
    assert.equal(calls[0][2], 5500);
    assert.deepEqual(calls[0][3], { sourceId: "cnon:tok",
      verificationToken: undefined });
    assert.ok(sent.length, "the confirmation goes");
  });

  it("answers a retry of a key already paid with the record, charging " +
    "nothing", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square, calls } = fakeSquare();
    const { mail } = mailbox();
    const opts = { now, env, mail, square };

    await payOrder(stores, PAT, order.id, card, opts);

    const again = await payOrder(stores, PAT, order.id, card, opts);

    assert.equal(again.ok, true);
    assert.equal(again.difference, 0);
    assert.equal(again.order.payments.length, 1);
    assert.equal(calls.length, 1);
  });

  it("refuses another customer's order, a paid one, a missing key, " +
    "Venmo and a card with no token", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square, calls } = fakeSquare();
    const opts = { now, env, square };
    const sam = await payOrder(stores, { email: "sam@example.com" },
      order.id, card, opts);
    const nokey = await payOrder(stores, PAT, order.id,
      { ...card, idempotencyKey: "" }, opts);
    const venmo = await payOrder(stores, PAT, order.id, {
      ...card, payment: { method: "venmo", stage: "create" },
    }, opts);
    const bare = await payOrder(stores, PAT, order.id, {
      ...card, payment: { method: "card" },
    }, opts);

    assert.equal(sam.status, 404);
    assert.equal(nokey.status, 422);
    assert.equal(venmo.status, 422);
    assert.equal(bare.status, 422);
    assert.deepEqual(calls, []);

    await payFarmOrder(stores, order.id, { tender: "cash" }, opts);

    const settled = await payOrder(stores, PAT, order.id, card, opts);

    assert.equal(settled.status, 409);
  });

  it("refuses a second submission while one is under way, and Square's " +
    "own source names", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square, calls } = fakeSquare();
    const opts = { now, env, square };

    await stores.orders.create(`pay-pending/${order.id}`, {
      key: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", attempt: 1,
      at: now.toISOString(),
    });

    const busy = await payOrder(stores, PAT, order.id, card, opts);

    assert.equal(busy.status, 409);
    assert.match(busy.errors.order, /under way/);

    await stores.orders.delete(`pay-pending/${order.id}`);

    for (const sourceId of ["CASH", "EXTERNAL", "external"]) {
      const r = await payOrder(stores, PAT, order.id, {
        ...card, payment: { method: "card", sourceId },
      }, opts);

      assert.equal(r.status, 422, sourceId);
    }
    assert.deepEqual(calls, []);
  });

  it("a later attempt records the payment Square already took instead " +
    "of charging again, read from the order's own Square order", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square, calls } = fakeSquare();
    const { sent, mail } = mailbox();

    // The Square order was made days ago, outside findPaid's window
    // (it answers null): its tenders are the record of the money.
    square.getOrder = async (id) => ({
      id, state: "COMPLETED",
      "created_at": new Date(now.getTime() - 5 * 86_400_000).toISOString(),
      tenders: [{ id: "T-1", "payment_id": "PAY-LOST", type: "CARD",
        "amount_money": { amount: 5500, currency: "USD" } }],
    });

    const r = await payOrder(stores, PAT, order.id, { ...card, attempt: 2 },
      { now, env, mail, square });

    assert.equal(r.ok, true);
    assert.equal(r.order.status, "paid");
    assert.deepEqual(paymentsOf(await getOrder(stores, order.id))
      .map((p) => [p.squarePaymentId, p.by]), [["PAY-LOST", "customer"]]);
    assert.deepEqual(calls.filter((c) => c[0] === "payment"), [],
      "nothing charged");
    assert.ok(sent.length);
  });

  it("charges once when a second tab pays between the first tab's read " +
    "and its claim", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square, calls } = fakeSquare();
    const { mail } = mailbox();
    const opts = { now, env, mail, square };
    const other = {
      ...card, idempotencyKey: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    };
    const create = stores.orders.create.bind(stores.orders);
    let crossed = false;

    // Tab B has read the order unpaid; before its claim lands, tab A
    // pays, records and releases.
    stores.orders.create = async (key, value) => {
      if (!crossed && key === `pay-pending/${order.id}`) {
        crossed = true;
        stores.orders.create = create;
        await payOrder(stores, PAT, order.id, other, opts);
      }

      return create(key, value);
    };

    const b = await payOrder(stores, PAT, order.id, card, opts);

    assert.ok(crossed);
    assert.equal(b.ok, false);
    assert.equal(b.status, 409);
    assert.equal(calls.filter((c) => c[0] === "payment").length, 1,
      "Square took the money once");
    assert.equal(paymentsOf(await getOrder(stores, order.id)).length, 1);
    assert.equal(await stores.orders.get(`pay-pending/${order.id}`), null);
  });

  it("charges nothing when the farm's tender lands between the page's " +
    "read and its claim, and the farm's tender finds nothing due after " +
    "a customer's", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square, calls } = fakeSquare();
    const { mail } = mailbox();
    const opts = { now, env, mail, square };
    const create = stores.orders.create.bind(stores.orders);
    let crossed = false;

    stores.orders.create = async (key, value) => {
      if (!crossed && key === `pay-pending/${order.id}`) {
        crossed = true;
        stores.orders.create = create;
        await payFarmOrder(stores, order.id, { tender: "cash" }, opts);
      }

      return create(key, value);
    };

    const page = await payOrder(stores, PAT, order.id, card, opts);

    assert.ok(crossed);
    assert.equal(page.status, 409);
    assert.equal(calls.filter((c) => c[0] === "payment").length, 1);

    const second = (await make(stores, { key: `${KEY}-2` })).r.order;

    crossed = false;
    stores.orders.create = async (key, value) => {
      if (!crossed && key === `pay-pending/${second.id}`) {
        crossed = true;
        stores.orders.create = create;
        await payOrder(stores, PAT, second.id, card, opts);
      }

      return create(key, value);
    };

    const farm = await payFarmOrder(stores, second.id, { tender: "cash" },
      opts);

    assert.ok(crossed);
    assert.equal(farm.ok, false);
    assert.match(farm.errors.order, /Nothing is due/);
    assert.equal(calls.filter((c) => c[0] === "payment").length, 2);
  });

  it("records money Square already holds under a fresh key instead of " +
    "charging again, on the first attempt", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square, calls } = fakeSquare();
    const { mail } = mailbox();

    // The first request died after the charge; its marker is stale and
    // the customer presses Pay again with a new submission.
    square.getOrder = async (id) => ({
      id, tenders: [{ id: "T-1", "payment_id": "PAY-LOST", type: "CARD",
        "amount_money": { amount: 5500, currency: "USD" } }],
    });

    const r = await payOrder(stores, PAT, order.id, {
      ...card, idempotencyKey: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    }, { now, env, mail, square });

    assert.equal(r.ok, true);
    assert.equal(r.order.status, "paid");
    assert.deepEqual(calls.filter((c) => c[0] === "payment"), []);
    assert.deepEqual(paymentsOf(await getOrder(stores, order.id))
      .map((p) => [p.squarePaymentId, p.via, p.by]),
    [["PAY-LOST", "square", "customer"]]);
  });

  it("reads a found cash tender as the farm's, not the customer's card",
    async () => {
      const stores = testStores();
      const order = await unpaid(stores);
      const { square, calls } = fakeSquare();
      const { mail } = mailbox();

      square.getOrder = async (id) => ({
        id, tenders: [{ id: "T-2", "payment_id": "PAY-CASH", type: "CASH",
          "amount_money": { amount: 5500, currency: "USD" } }],
      });

      const r = await payOrder(stores, PAT, order.id, card, {
        now, env, mail, square,
      });
      const record = await getOrder(stores, order.id);

      assert.equal(r.ok, true);
      assert.deepEqual(calls.filter((c) => c[0] === "payment"), []);
      assert.deepEqual(paymentsOf(record).map((p) => [p.via, p.by]),
        [["cash", "farm"]]);
      assert.equal(r.order.canCancel, false, "handed back by the farm");
    });

  it("leaves a cancelled order alone when the money lands after the " +
    "cancel, and raises the alarm", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square } = fakeSquare();
    const { sent, mail } = mailbox();
    const pay = square.createPayment;

    // The farm cancels the unpaid order while Square is taking the card.
    square.createPayment = async (args) => {
      await setStatus(stores, order.id, "cancelled", now, { source: "farm" });

      return pay(args);
    };

    await payOrder(stores, PAT, order.id, card, {
      now, env: { ...env, DEV_NOTIFICATIONS_EMAIL: "dev@x.com" }, mail, square,
    });

    const record = await getOrder(stores, order.id);

    assert.equal(record.status, "cancelled");
    assert.deepEqual(paymentsOf(record), []);
    assert.ok(sent.some((m) => /paid_twice/.test(m.subject)
      && /cancelled/.test(m.text || "")), "the farm hears, with the status");
  });

  it("lets exactly one of two takers have a stale claim", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square, calls } = fakeSquare();
    const { mail } = mailbox();
    const stale = new Date(now.getTime() - PENDING_MS - 60_000);

    await stores.orders.create(`pay-pending/${order.id}`, {
      key: "dead-dead-dead", attempt: 1, at: stale.toISOString(),
    });

    const [a, b] = await Promise.all([
      payOrder(stores, PAT, order.id, card, { now, env, mail, square }),
      payOrder(stores, PAT, order.id, {
        ...card, idempotencyKey: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }, { now, env, mail, square }),
    ]);

    assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
    assert.equal(calls.filter((c) => c[0] === "payment").length, 1);
  });

  it("refuses a later attempt of the same key while its first stands",
    async () => {
      const stores = testStores();
      const order = await unpaid(stores);
      const { square, calls } = fakeSquare();

      await stores.orders.create(`pay-pending/${order.id}`, {
        key: card.idempotencyKey, attempt: 1, at: now.toISOString(),
      });

      const r = await payOrder(stores, PAT, order.id, { ...card, attempt: 2 },
        { now, env, square });

      assert.equal(r.status, 409);
      assert.deepEqual(calls, []);
    });

  it("raises the alarm, keeping the record as it is, when money reaches " +
    "Square for an order already settled", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square } = fakeSquare();
    const { sent, mail } = mailbox();
    const pay = square.createPayment;

    // The farm's tender lands on the record while Square is taking the
    // card: the record will not take a second payment.
    square.createPayment = async (args) => {
      await updateOrder(stores, order.id, (o) => ({
        ...o, status: "paid", payments: [{ amount: 5500, via: "cash",
          method: "cash", squarePaymentId: "PAY-CASH", by: "farm" }],
      }));

      return pay(args);
    };

    const r = await payOrder(stores, PAT, order.id, card, {
      now, env: { ...env, DEV_NOTIFICATIONS_EMAIL: "dev@x.com" }, mail, square,
    });

    assert.equal(r.ok, true, "the customer is not told to pay again");
    assert.equal(r.refused, true);
    assert.deepEqual(paymentsOf(await getOrder(stores, order.id))
      .map((p) => p.squarePaymentId), ["PAY-CASH"]);
    assert.ok(sent.some((m) => /paid_twice/.test(m.subject)
      || /paid_twice/.test(m.text || "")), "the farm hears");
    // No confirmation and no mark for a payment the record refused, and
    // the claim is released.
    assert.ok(!sent.some((m) => /order/i.test(m.subject)
      && !/paid_twice/.test(m.subject)), "no confirmation");
    assert.equal(await readMark(stores, "paid"), null);
    assert.equal(await stores.orders.get(`pay-pending/${order.id}`), null);
  });

  it("tells the farm to refund in Square, not \"Recorded\", when the " +
    "record refuses its tender", async () => {
    const stores = testStores();
    const order = await unpaid(stores);
    const { square } = fakeSquare();
    const { sent, mail } = mailbox();
    const pay = square.createPayment;

    // A customer's card lands on the record while Square takes the
    // farm's cash.
    square.createPayment = async (args) => {
      await updateOrder(stores, order.id, (o) => ({
        ...o, status: "paid", payments: [{ amount: 5500, via: "square",
          method: "card", squarePaymentId: "PAY-CARD", by: "customer" }],
      }));

      return pay(args);
    };

    const r = await payFarmOrder(stores, order.id, { tender: "cash" }, {
      now, env: { ...env, DEV_NOTIFICATIONS_EMAIL: "dev@x.com" }, mail, square,
    });

    assert.equal(r.ok, false);
    assert.match(r.errors.order, /This order is paid/);
    assert.match(r.errors.order, /refund Square payment PAY-1/);
    assert.deepEqual(paymentsOf(await getOrder(stores, order.id))
      .map((p) => p.squarePaymentId), ["PAY-CARD"]);
    assert.ok(sent.some((m) => /paid_twice/.test(m.subject)));
    assert.ok(!sent.some((m) => /order/i.test(m.subject)
      && !/paid_twice/.test(m.subject)), "no confirmation");
  });

  it("answers a decline as the order endpoint does, recording nothing",
    async () => {
      const stores = testStores();
      const order = await unpaid(stores);
      const { square } = fakeSquare();

      square.createPayment = async () => {
        throw new SquareError("Square 402", {
          declined: true, code: "CARD_DECLINED",
        });
      };

      const r = await payOrder(stores, PAT, order.id, card, {
        now, env, square,
      });

      assert.equal(r.ok, false);
      assert.equal(r.status, 402);
      assert.equal(r.declined, true);
      assert.ok(r.errors.payment);
      assert.equal(dueOn(await getOrder(stores, order.id)), 5500);
    });
});
