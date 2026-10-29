// Every place that closes a Square order a payment left open reaches
// square.cancelOrder, which must cancel the open fulfillment before the
// order: Square refuses the order alone (INVALID_VALUE, recorded in
// test/fixtures/square/order-cancel-refused.json). These run the real
// cancelOrder, behind a stub of Square that serves the recorded order.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  payWithCredit, payWithSquare,
} from "../netlify/functions/lib/checkout.mjs";
import { sweepSquareOrders } from "../netlify/functions/lib/jobs.mjs";
import {
  SITE_VERSION, SquareError, cancelOrder,
} from "../netlify/functions/lib/square.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { recorded } from "./recorded.mjs";

const ENV = {
  SQUARE_ENV: "sandbox", SQUARE_ACCESS_TOKEN: "tok",
  SQUARE_LOCATION_ID: "LOC",
};
const KEY = "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f";
const now = new Date("2026-10-07T09:00:00Z");

// An open order whose fulfillment is still proposed, as Square sent one
// (order-get-before-cancel), and an answer to each update that moves the
// version on.
const host = (name = "order-get-before-cancel") => {
  const open = recorded("square", name).response.order;
  const calls = [];
  const impl = async (url, init) => {
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;

    calls.push({ method, path: new URL(url).pathname, body });

    return new Response(JSON.stringify({
      order: { ...open, version: open.version + calls.length - 1 },
    }));
  };

  return { open, calls, impl };
};

// The two updates a cancel must send, in order.
const assertCancelled = ({ open, calls }) => {
  const puts = calls.filter((c) => c.method === "PUT");

  assert.equal(puts.length, 2, "the fulfillment, then the order");
  assert.deepEqual(puts[0].body.order.fulfillments,
    [{ uid: open.fulfillments[0].uid, state: "CANCELED" }]);
  assert.equal(puts[0].body.order.version, open.version);
  assert.equal(puts[0].body.order.state, undefined);
  assert.equal(puts[1].body.order.state, "CANCELED");
  assert.equal(puts[1].body.order.version, open.version + 1);
};

// A Square whose only real call is the cancel.
const squareWith = (extra) => ({ cancelOrder, ...extra });

const order = (totals = {}) => ({
  id: "NFF-2610-ABCD",
  submittedAt: now.toISOString(),
  customer: {
    firstName: "Pat", lastName: "Example", name: "Pat Example",
    email: "pat@example.com", phone: "401-555-0100", contact: "call",
  },
  fulfilment: {
    method: "onfarm", date: "2026-10-08", onfarm: { window: "morning" },
    delivery: null, state: "agreed",
  },
  lines: [{
    sku: "NFF-CHK-WHL-35-39", label: "Whole Chicken", name: "Whole Chicken",
    unitPrice: 30, qty: 2, lineTotal: 60, squareVariationId: null,
  }],
  totals: {
    subtotal: 6000, discountTier: 0, discountAmount: 0, deliveryFee: 0,
    areaFee: 0, total: 6000, ...totals,
  },
  notes: "",
  source: "",
  flags: { zipUnlisted: false, totalMismatch: false },
  meta: { idempotencyKey: KEY, attempt: 1 },
});

describe("an order a payment left open is cancelled whole", () => {
  it("cancels the fulfillment, then the order, after a declined card",
    async () => {
      const net = host();
      const square = squareWith({
        createOrder: async () => ({ squareOrderId: "SQO", customerId: "C" }),
        createPayment: async () => {
          throw new SquareError("no", { declined: true, code: "CVV_FAILURE" });
        },
      });

      await assert.rejects(payWithSquare(testStores(), order(), {
        key: KEY, method: "card", sourceId: "tok",
      }, { square, env: ENV, fetchImpl: net.impl, sleep: async () => {} }),
      (e) => e.declined);
      assertCancelled(net);
    });

  it("cancels it the same way when the $0 order cannot be paid",
    async () => {
      const net = host();
      const square = squareWith({
        createOrder: async () => ({ squareOrderId: "SQO", customerId: "C" }),
        payZeroOrder: async () => {
          throw new SquareError("no", { retryable: false });
        },
      });

      await assert.rejects(payWithCredit(testStores(),
        order({ total: 0, credit: 6000 }), { key: KEY },
      { square, env: ENV, fetchImpl: net.impl, sleep: async () => {} }));
      assertCancelled(net);
    });

  it("cancels it the same way in the sweep of orders left open",
    async () => {
      const net = host("order-get-line-discount");
      const square = squareWith({
        searchOpenOrders: async () => [{
          id: "SQO", referenceId: "NFF-2610-ABCD", siteVersion: SITE_VERSION,
          createdAt: "2026-10-05T12:00:00Z", tenders: 0, total: 6000,
        }],
      });
      const out = await sweepSquareOrders(testStores(), {
        env: ENV, now, square, fetchImpl: net.impl, cancel: true,
      });

      assert.deepEqual(out.map((o) => o.cancelled), [true]);
      assertCancelled(net);
    });

  it("leaves an order whose fulfillment is done to one update",
    async () => {
      const net = host();
      const done = { ...net.open, fulfillments: [{
        ...net.open.fulfillments[0], state: "COMPLETED",
      }] };
      const impl = async (url, init) => (init.method === "PUT"
        ? net.impl(url, init)
        : new Response(JSON.stringify({ order: done })));

      await cancelOrder("SQO", { env: ENV, fetchImpl: impl });
      assert.equal(net.calls.length, 1);
      assert.equal(net.calls[0].body.order.state, "CANCELED");
    });
});
