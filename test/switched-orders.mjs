// Paid orders in each state a switch between delivery and pickup can
// leave them, made the way a customer makes them: placed through
// /api/orders and switched through Account's edit (lib/edit.mjs), with
// Square stubbed at lib/square.mjs's surface as test/edit.test.mjs and
// test/edit-switch-cancel.test.mjs stub it. Used by the criteria tests
// of #660 and #662.
//
// The stub names Square's orders in the order they are made: SQO, the
// order the customer paid on, then SQC1, SQC2 for each change order.
// Its one Square body, the refused cancel of `staleHolder`, is the
// recorded version conflict (test/version-conflict.mjs); every other
// call answers as lib/square.mjs's own functions return, not with a
// Square response.

import assert from "node:assert/strict";

import { handle as placeOrder } from "../netlify/functions/orders.mjs";
import { editOrder } from "../netlify/functions/lib/edit.mjs";
import { getOrder } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { MORNING, SCHEDULE } from "./schedule-fixture.mjs";
import { CONFLICT, refusal } from "./version-conflict.mjs";

// Tuesday 6 October 2026, 09:00 ET; on-farm pickup Wednesday the 7th.
export const now = instant("2026-10-06", 9, 0, "America/New_York");
export const env = {
  FARM_NOTIFICATIONS_EMAIL: "farm@example.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@example.com",
  URL: "https://x", PICKUP_SCHEDULE: SCHEDULE,
};
export const EMAIL = "pat@example.com";
export const customer = { email: EMAIL, name: "Pat Example" };
export const quiet = { sleep: async () => {} };
export const mail = async () => ({});

const SKU = "NFF-CHK-WHL-35-39";
const ONFARM = {
  method: "onfarm", date: "2026-10-07", onfarm: { window: MORNING },
};
const DELIVERY = {
  method: "delivery", date: "2026-10-08",
  delivery: {
    address1: "1 Main St", town: "Foster", zip: "02825", cooler: "Porch",
  },
};
const CARD = { method: "card", sourceId: "cnon:tok" };

// Square at lib/square.mjs's surface. Every call is kept in `calls` as
// [name, Square order id]. `fail` names the calls that throw, by name
// and order id; a test may change it once the order is made.
export const stubSquare = (fail = {}) => {
  const calls = [];
  let n = 0;
  const failing = (name, id) => fail[name] && fail[name](id);
  const square = {
    createOrder: async () => ({ squareOrderId: "SQO", customerId: "CUST" }),
    createChangeOrder: async () => {
      const id = `SQC${++n}`;

      calls.push(["createChangeOrder", id]);

      return { squareOrderId: id, customerId: "CUST" };
    },
    createPayment: async (args) => {
      calls.push(["createPayment", args.squareOrderId]);

      return {
        squarePaymentId: `PAY-${args.squareOrderId}`,
        status: "COMPLETED", receiptUrl: "https://squareup.com/receipt/r1",
        brand: "VISA", last4: "4242", wallet: null,
      };
    },
    payZeroOrder: async (id) => {
      calls.push(["payZeroOrder", id]);

      return { squareOrderId: id };
    },
    cancelOrder: async (id) => calls.push(["cancelOrder", id]),
    cancelFulfillment: async (id) => {
      calls.push(["cancelFulfillment", id]);
      const error = failing("cancelFulfillment", id);

      if (error) throw error;

      return { id, cancelled: true };
    },
    updateFulfillment: async (id) => {
      calls.push(["updateFulfillment", id]);

      return { id, version: 2 };
    },
    completeOrder: async (id) => {
      calls.push(["completeOrder", id]);

      return { id, completed: true };
    },
    refundPayment: async ({ squarePaymentId, amount, key }) => {
      calls.push(["refundPayment", squarePaymentId]);

      return { squareRefundId: `R-${key}`, status: "PENDING", amount };
    },
  };

  return { square, calls, fail };
};

// The Square order ids that `name` was called with, in order.
export const called = (calls, name) => calls.filter((c) => c[0] === name)
  .map((c) => c[1]);

let orders = 0;
let keys = 0;

// A paid on-farm pickup, placed the way the page places one.
// -> { stores, id }
const placed = async (square) => {
  const stores = testStores();
  const res = await placeOrder(new Request("http://x/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: `0f7c1e3a-9c9b-4b3a-8e9d-${
        String(++orders).padStart(12, "0")}`,
      customer: {
        firstName: "Pat", lastName: "Example", email: EMAIL,
        phone: "401-555-0100", contact: "call",
      },
      lines: [{ sku: SKU, qty: 2 }],
      fulfilment: ONFARM,
      claimedTotal: 5500,
      payment: CARD,
    }),
  }), { stores, square, now, env, mail, ...quiet });

  assert.equal(res.status, 200);

  return { stores, id: (await res.json()).orderId };
};

// A switch from Account: asks once to learn the total, as the page
// does, then sends it.
const switchTo = async (stores, id, body, square) => {
  const opts = { now, env, mail, square, ...quiet };
  const full = { idempotencyKey: `edit-key-660662-${++keys}`, ...body };
  let result = await editOrder(stores, customer, id, full, opts);

  if (!result.ok && result.errors.total) {
    result = await editOrder(stores, customer, id, {
      ...full, claimedTotal: result.totals.total,
    }, opts);
  }
  assert.equal(result.ok, true, JSON.stringify(result.errors));
};

const toDelivery = (stores, id, square) => switchTo(stores, id, {
  fulfilment: DELIVERY, payment: CARD,
}, square);
const toPickup = (stores, id, square) => switchTo(stores, id, {
  fulfilment: ONFARM,
}, square);

// Each builder -> { stores, id, square, calls, fail }. Once the order
// is made, `calls` is emptied, so it holds only what the test then
// does, and `fail` is emptied, so every call succeeds until the test
// names one that throws.
const made = async ({ stores, id }, { square, calls, fail }, want) => {
  const saved = await getOrder(stores, id);

  for (const [key, value] of Object.entries(want)) {
    assert.equal(saved.square[key], value, `setup: square.${key}`);
  }
  calls.length = 0;
  for (const key of Object.keys(fail)) delete fail[key];

  return { stores, id, square, calls, fail };
};

// Never switched: an on-farm pickup on SQO.
export const neverSwitched = async () => {
  const stub = stubSquare();
  const order = await placed(stub.square);

  return made(order, stub, {
    squareOrderId: "SQO", fulfilmentOrderId: undefined,
    oldFulfilmentOrderId: undefined,
  });
};

// Switched once: pickup to delivery, the fee paid on SQC1, which now
// holds the delivery; SQO's pickup is cancelled.
export const switchedOnce = async () => {
  const stub = stubSquare();
  const order = await placed(stub.square);

  await toDelivery(order.stores, order.id, stub.square);

  return made(order, stub, {
    squareOrderId: "SQO", fulfilmentOrderId: "SQC1",
    oldFulfilmentOrderId: undefined,
  });
};

// Switched twice: pickup to delivery (SQC1) and back to pickup, whose
// $0 order SQC2 now holds it. SQO's and SQC1's fulfillments are
// cancelled.
export const switchedTwice = async () => {
  const stub = stubSquare();
  const order = await placed(stub.square);

  await toDelivery(order.stores, order.id, stub.square);
  await toPickup(order.stores, order.id, stub.square);

  return made(order, stub, {
    squareOrderId: "SQO", fulfilmentOrderId: "SQC2",
    oldFulfilmentOrderId: undefined,
  });
};

// Switched twice, the second switch's cancel of SQC1 refused for good
// (#658): SQC2 holds the pickup, SQC1's delivery is still open in
// Square and the record names it as `oldFulfilmentOrderId`. The refusal
// is setup only: once the order is made, SQC1's cancel succeeds unless
// the test says otherwise.
export const staleHolder = async () => {
  const stub = stubSquare({
    cancelFulfillment: (holder) => (holder === "SQC1"
      ? refusal(CONFLICT, `/v2/orders/${holder}`) : null),
  });
  const order = await placed(stub.square);

  await toDelivery(order.stores, order.id, stub.square);
  await toPickup(order.stores, order.id, stub.square);

  return made(order, stub, {
    squareOrderId: "SQO", fulfilmentOrderId: "SQC2",
    oldFulfilmentOrderId: "SQC1",
  });
};
