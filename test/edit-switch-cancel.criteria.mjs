// Criteria tests for #658, boxes 4 and 5: what a switch between
// delivery and pickup leaves behind when Square's cancel of the old
// fulfillment fails for good. Written before the fix, from the issue
// alone. Held out of `npm test` by its name; turn it on with
//
//   git mv test/edit-switch-cancel.criteria.mjs \
//     test/edit-switch-cancel.test.mjs
//
// The retry itself, and the version conflict it is matched on, are in
// test/square-version-conflict.criteria.mjs (the contract's first
// half).
//
// THE CONTRACT, SECOND HALF
//
// The saved record. A switch puts the fulfillment on a new Square
// order (the carrier) and cancels it on the order that held it (the
// holder: `square.fulfilmentOrderId`, or `square.squareOrderId` before
// any switch). When that cancel fails for good, `syncFulfillment`
// saves
//
//   square.fulfilmentOrderId     the carrier, the new order's id, as a
//                                switch that succeeds saves it
//   square.oldFulfilmentOrderId  the holder whose fulfillment Square
//                                still has open: the step left for the
//                                farm or `bin/nff` to finish
//   square.squareOrderId         unchanged
//   flags.squareOutOfSync        true
//
// `oldFulfilmentOrderId` is the one new field. It keeps the record's
// spelling (`fulfilment`, `fulfilmentOrderId`).
//
// The log line. A failure in `syncFulfillment` writes one
// `log.error` line (one JSON line on console.error):
//
//   { level: "error", event: "square.update_failed", id: <order id>,
//     step: "create" | "pay" | "cancel", code: <SquareError code>,
//     error: <message> }
//
// `step` names the call that failed in a switch: "create"
// (createChangeOrder), "pay" (payZeroOrder) or "cancel"
// (cancelFulfillment). (Not a box, so untested here: the plain
// `updateFulfillment` of a change that is not a switch logs "update".)
// `code` is the SquareError's `code`, Square's own for a refusal
// (VERSION_MISMATCH for the conflict). The line holds no payment
// detail: no payment or refund id, card brand, last four, receipt
// link, nonce or amount, and no email address.
//
// The Square bodies. The cancel's refusal is the recorded version
// conflict (test/version-conflict.mjs). No refusal of POST /v2/orders
// or of POST /v2/orders/{id}/pay has been recorded, so the create and
// pay steps throw the closest recorded refusals, raised by `failure` as
// lib/square.mjs raises Square's: `order-cancel-refused` (400
// INVALID_VALUE, an orders call) and `payment-order-canceled` (400
// BAD_REQUEST, a payment on a cancelled order).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle as placeOrder } from "../netlify/functions/orders.mjs";
import { editOrder } from "../netlify/functions/lib/edit.mjs";
import { getOrder, paymentsOf } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { recorded } from "./recorded.mjs";
import { MORNING, SCHEDULE } from "./schedule-fixture.mjs";
import { CONFLICT, conflictCode, refusal } from "./version-conflict.mjs";

// Tuesday 6 October 2026, 09:00 ET; on-farm pickup Wednesday the 7th.
const now = instant("2026-10-06", 9, 0, "America/New_York");
const SKU = "NFF-CHK-WHL-35-39";
const env = {
  FARM_NOTIFICATIONS_EMAIL: "farm@example.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@example.com",
  URL: "https://x", PICKUP_SCHEDULE: SCHEDULE,
};
const EMAIL = "pat@example.com";
const customer = { email: EMAIL, name: "Pat Example" };
const quiet = { sleep: async () => {} };
const mail = async () => ({});

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

// Square, stubbed at lib/square.mjs's surface, as test/edit.test.mjs
// stubs it. `fail` names the calls that throw, by name and order id.
const stubSquare = (fail = {}) => {
  const calls = [];
  let n = 0;
  const failing = (name, id) => fail[name] && fail[name](id);
  const square = {
    createOrder: async () => ({ squareOrderId: "SQO", customerId: "CUST" }),
    createChangeOrder: async (order, change, key) => {
      calls.push(["createChangeOrder", key]);
      const error = failing("createChangeOrder");

      if (error) throw error;

      return { squareOrderId: `SQC${++n}`, customerId: "CUST" };
    },
    createPayment: async (args) => {
      calls.push(["createPayment", args.squareOrderId]);

      return {
        squarePaymentId: args.squareOrderId === "SQO" ? "PAY1"
          : `PAY-${args.squareOrderId}`,
        status: "COMPLETED", receiptUrl: "https://squareup.com/receipt/r1",
        brand: "VISA", last4: "4242", wallet: null,
      };
    },
    payZeroOrder: async (id) => {
      calls.push(["payZeroOrder", id]);
      const error = failing("payZeroOrder", id);

      if (error) throw error;

      return { squareOrderId: id };
    },
    cancelOrder: async (id) => calls.push(["cancelOrder", id]),
    cancelFulfillment: async (id) => {
      calls.push(["cancelFulfillment", id]);
      const error = failing("cancelFulfillment", id);

      if (error) throw error;

      return { id, cancelled: true };
    },
    updateFulfillment: async (id) => calls.push(["updateFulfillment", id]),
    refundPayment: async ({ squarePaymentId, amount, key }) => {
      calls.push(["refundPayment", squarePaymentId, amount]);

      return { squareRefundId: `R-${key}`, status: "PENDING", amount };
    },
  };

  return { square, calls };
};

// A paid order, placed the way the page places one. -> { stores, id }
const placed = async () => {
  const stores = testStores();
  const res = await placeOrder(new Request("http://x/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
      customer: {
        firstName: "Pat", lastName: "Example", email: EMAIL,
        phone: "401-555-0100", contact: "call",
      },
      lines: [{ sku: SKU, qty: 2 }],
      fulfilment: ONFARM,
      claimedTotal: 5500,
      payment: CARD,
    }),
  }), { stores, square: stubSquare().square, now, env, mail, ...quiet });

  assert.equal(res.status, 200);

  return { stores, id: (await res.json()).orderId };
};

let keys = 0;
const editKey = () => `edit-key-658000-${++keys}`;

// A customer's edit from Account: asks once to learn the total, as the
// page does, then sends it.
const edit = async (stores, id, body, square) => {
  const opts = { now, env, mail, square, ...quiet };
  const full = { idempotencyKey: editKey(), ...body };
  const first = await editOrder(stores, customer, id, full, opts);

  if (first.ok || !first.errors.total) return first;

  return editOrder(stores, customer, id, {
    ...full, claimedTotal: first.totals.total,
  }, opts);
};

// The JSON lines written to console.error while `run` runs.
const errorLines = async (t, run) => {
  const lines = [];

  t.mock.method(console, "error", (text) => {
    try {
      lines.push(JSON.parse(text));
    } catch {
      // Not a log line.
    }
  });
  try {
    await run();
  } finally {
    t.mock.restoreAll();
  }

  return lines;
};

describe("#658: a switch whose cancel fails for good", () => {
  it("box 4: the saved record holds the new Square order's id as well " +
    "as the old holder's, and is flagged squareOutOfSync", async () => {
    const { stores, id } = await placed();
    // The second switch's cancel, of the delivery's order, is refused.
    const { square, calls } = stubSquare({
      cancelFulfillment: (holder) => (holder === "SQC1"
        ? refusal(CONFLICT, `/v2/orders/${holder}`) : null),
    });

    // A paid delivery order: on-farm pickup switched to delivery, its
    // fee paid on the change order SQC1, which now holds the delivery.
    const toDelivery = await edit(stores, id, {
      fulfilment: DELIVERY, payment: CARD,
    }, square);

    assert.equal(toDelivery.ok, true, JSON.stringify(toDelivery.errors));
    assert.equal((await getOrder(stores, id)).square.fulfilmentOrderId,
      "SQC1");

    // Back to on-farm pickup from Account: the fee is refunded, a $0
    // pickup order is made and paid, and the cancel on SQC1 fails.
    const toPickup = await edit(stores, id, { fulfilment: ONFARM }, square);

    assert.equal(toPickup.ok, true, JSON.stringify(toPickup.errors));
    assert.ok(calls.some((c) => c[0] === "refundPayment"));
    assert.ok(calls.some((c) => c[0] === "payZeroOrder" && c[1] === "SQC2"));

    const saved = await getOrder(stores, id);

    assert.equal(saved.square.fulfilmentOrderId, "SQC2",
      "the new Square order, which holds the pickup");
    assert.equal(saved.square.oldFulfilmentOrderId, "SQC1",
      "the old holder, whose delivery Square still has open");
    assert.equal(saved.square.squareOrderId, "SQO");
    assert.equal(saved.flags.squareOutOfSync, true);
  });

  it("box 5: square.update_failed carries Square's error code and the " +
    "step that failed, and no payment detail", async (t) => {
    const STEPS = [
      {
        step: "create", fixture: "order-cancel-refused",
        fail: { createChangeOrder: () => refusal("order-cancel-refused",
          "/v2/orders") },
      },
      {
        step: "pay", fixture: "payment-order-canceled",
        fail: { payZeroOrder: (carrier) => refusal("payment-order-canceled",
          `/v2/orders/${carrier}/pay`) },
      },
      {
        step: "cancel", fixture: CONFLICT,
        fail: { cancelFulfillment: (holder) => refusal(CONFLICT,
          `/v2/orders/${holder}`) },
      },
    ];

    for (const { step, fixture, fail } of STEPS) {
      const { stores, id } = await placed();
      const { square } = stubSquare(fail);
      const code = recorded("square", fixture).response.errors[0].code;
      // To the drop site, which charges no fee: a switch with nothing
      // to pay, so all three steps run (create, pay, cancel).
      const lines = await errorLines(t, async () => {
        const result = await edit(stores, id, {
          fulfilment: { method: "scituate", date: "2026-10-17" },
        }, square);

        assert.equal(result.ok, true, JSON.stringify(result.errors));
      });
      const failed = lines.filter((l) => l.event === "square.update_failed");

      assert.equal(failed.length, 1, `${step}: one line`);

      const [line] = failed;

      assert.equal(line.level, "error", step);
      assert.equal(line.id, id, step);
      assert.equal(line.step, step);
      assert.equal(line.code, code, `${step}: Square's code`);
      if (step === "cancel") assert.equal(line.code, conflictCode());

      // No payment detail, and no email address.
      const text = JSON.stringify(line);
      const saved = await getOrder(stores, id);

      for (const p of paymentsOf(saved)) {
        for (const value of [p.squarePaymentId, p.receiptUrl, p.last4,
          p.brand]) {
          if (value) {
            assert.ok(!text.includes(value), `${step}: holds ${value}`);
          }
        }
      }
      for (const key of ["payment", "payments", "refund", "refunds",
        "amount", "squarePaymentId", "squareRefundId", "receiptUrl",
        "brand", "last4", "sourceId", "card", "totals"]) {
        assert.ok(!(key in line), `${step}: holds ${key}`);
      }
      assert.ok(!text.includes("cnon:"), `${step}: holds the nonce`);
      assert.ok(!text.includes(EMAIL), `${step}: holds the email`);
    }
  });
});
