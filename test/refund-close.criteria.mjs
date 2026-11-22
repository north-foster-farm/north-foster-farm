// Criteria tests for #775: a full refund made elsewhere closes the
// order. One test per (test) box of the issue's "Done when" list,
// written before the fix from the issue and its comment alone. The
// fourth box (whether the customer is emailed) is James's and has no
// test. Held out of `npm test` by its name; turn it on with
//
//   git mv test/refund-close.criteria.mjs test/refund-close.test.mjs
//
// Boxes 1 and 3 fail until the fix. Box 2 passes today: a partial
// refund and a fulfilled order's refund already change nothing else,
// and it holds the fix to that.
//
// THE CONTRACT
//
// A refund made outside the CLI reaches the record through a webhook,
// and the tests deliver it that way:
//
//   Square   a signed refund.updated to the Square webhook's `handle`
//            (netlify/functions/square-webhook.mjs), for a refund made
//            in Square's dashboard;
//   PayPal   a PAYMENT.CAPTURE.REFUNDED to the PayPal webhook's
//            `handle` (netlify/functions/paypal-webhook.mjs), verified
//            by a stub, for a Venmo payment refunded in PayPal.
//
// Each handler is given `{ stores, env, now, mail, square }`, as the
// Square webhook's order events and the PayPal webhook already take
// them. `square` is Square at lib/square.mjs's surface, as the cancel
// tests stub it (test/admin.test.mjs, test/switched-orders.mjs): each
// call answers as lib/square.mjs's own function returns, and is kept
// in `calls`. The close must use the `square`, `env` and `mail` it is
// handed; nothing reaches a real service (test/setup.mjs fails a file
// that tries).
//
// When the refunds recorded on an unfulfilled order reach everything
// paid, the order closes as `bin/nff orders cancel --no-refund`
// closes one: status `cancelled`; its lines' stock back (lib/stock.mjs
// counts); `cancelFulfillment` called once on its Square order
// (`square.squareOrderId`, the only holder these records name); off
// the open index every pickup and delivery list reads (`openOrders`,
// `listOrders({ open: true })`, and the jobs' `dueOn` for its date);
// and no money moved again (no refund asked of Square or PayPal for
// it, and no refund added to the record beyond the one delivered).
//
// Square may refuse the fulfillment close of an order it has refunded
// in full: it did so in production on 2026-11-21 (the issue's
// comment). That answer means already closed: the order still closes,
// no alert goes out (no "Site alert" email), and the record is not
// flagged `squareOutOfSync`. The refusal is a recording,
// test/fixtures/square/fulfillment-cancel-refunded.json, of the PUT
// lib/square.mjs's cancelFulfillment sends for a sandbox order paid
// and then refunded in full. It does not exist yet: the coordinator
// records it (bin/fixtures/record), and until then that case fails on
// its missing recording, saying so.
//
// The notice (box 3): one email to FARM_NOTIFICATIONS_EMAIL that names
// the order's id in its subject or text, per order closed, however
// often the refund is delivered, and none for an order that does not
// close. An alert is not the notice. The log (box 3, the logging rule
// in docs/security.md): at least one line naming the order (`id`),
// who acted (`by`, any non-empty string), and the status before and
// after (`before: "paid"`, `after: "cancelled"`); a redelivery logs
// no second such line, and no line carries the customer's email.
//
// The webhook bodies: PayPal's is the recorded delivery
// (lib/fake-paypal.mjs's webhookDelivery). Square's refund is the
// recorded refund (test/fixtures/square/refund-get.json) with our ids,
// amount and status put in; its event envelope, which no recording
// holds, is built as test/payments.test.mjs builds it.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { listOrders } from "../netlify/functions/lib/admin.mjs";
import { webhookDelivery } from "../netlify/functions/lib/fake-paypal.mjs";
import { dueOn } from "../netlify/functions/lib/jobs.mjs";
import {
  getOrder, openOrders, paidTotal, refundedTotal, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { getCounts, setCount } from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle as paypalHook } from "../netlify/functions/paypal-webhook.mjs";
import {
  handle as squareHook, signature,
} from "../netlify/functions/square-webhook.mjs";
import { body as recordedBody } from "./recorded.mjs";
import { refusal } from "./version-conflict.mjs";

// Saturday 21 November 2026, 04:27 ET, when the issue's refund was
// made; the pickup is Monday the 23rd.
const now = new Date("2026-11-21T09:27:00Z");
const DAY = "2026-11-23";
const EMAIL = "pat@example.com";
const FARM = "farm@example.com";
const SKU = "NFF-CHK-EGG-LG";
const TOTAL = 1400;
const SQUARE_URL = "https://x/api/square/webhook";
const SQUARE_KEY = "square-test-key";
const env = {
  FARM_NOTIFICATIONS_EMAIL: FARM,
  DEV_NOTIFICATIONS_EMAIL: "dev@example.com",
  URL: "https://x",
  SQUARE_WEBHOOK_SIGNATURE_KEY: SQUARE_KEY,
  SQUARE_WEBHOOK_URL: SQUARE_URL,
  PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s",
  PAYPAL_WEBHOOK_ID: "WH", PAYPAL_ENV: "sandbox",
};

const REFUSED = "fulfillment-cancel-refunded";
const REFUSED_FILE = fileURLToPath(new URL(
  `./fixtures/square/${REFUSED}.json`, import.meta.url));

// A paid order, as the site saves one: two dozen eggs, $14, paid by
// card through Square or by Venmo through PayPal, for on-farm pickup
// or delivery on DAY.
const order = (id, { via = "square", method = "onfarm",
  status = "paid" } = {}) => ({
  id,
  status,
  submittedAt: "2026-11-20T23:00:00.000Z",
  paidAt: "2026-11-20T23:00:00.000Z",
  ...(status === "fulfilled"
    ? { fulfilledAt: "2026-11-21T01:00:00.000Z" } : {}),
  customer: { name: "Pat Example", email: EMAIL, phone: "" },
  lines: [{ sku: SKU, label: "Eggs (per dozen), Large", qty: 2,
    unitPrice: 7, lineTotal: 14 }],
  totals: { subtotal: TOTAL, discountAmount: 0, deliveryFee: 0,
    total: TOTAL },
  fulfilment: method === "onfarm"
    ? { method, date: DAY, onfarm: { window: "morning",
      phone: "4015550100" } }
    : { method, date: DAY, delivery: { address1: "1 Main St",
      town: "Foster", zip: "02825", cooler: "Porch" } },
  square: { squareOrderId: `SQO-${id}`, customerId: "CUST" },
  payment: via === "venmo"
    ? {
      via: "venmo", method: "venmo", at: "2026-11-20T23:00:00.000Z",
      squarePaymentId: `PAY-${id}`, receiptUrl: null,
      paypalOrderId: `PPO-${id}`, paypalCaptureId: `CAP-${id}`,
      amount: TOTAL,
    }
    : {
      via: "square", method: "card", at: "2026-11-20T23:00:00.000Z",
      squarePaymentId: `PAY-${id}`, receiptUrl: "https://r/x",
      brand: "VISA", last4: "4242", amount: TOTAL,
    },
});

// Square at lib/square.mjs's surface. `fail.cancelFulfillment`, when
// set, answers the Square order id with the error to throw.
const stubSquare = () => {
  const calls = [];
  const fail = {};
  const square = {
    cancelFulfillment: async (id) => {
      calls.push(["cancelFulfillment", id]);
      const error = fail.cancelFulfillment && fail.cancelFulfillment(id);

      if (error) throw error;

      return { id, cancelled: true };
    },
    cancelOrder: async (id) => {
      calls.push(["cancelOrder", id]);

      return { id };
    },
    updateFulfillment: async (id) => {
      calls.push(["updateFulfillment", id]);

      return { id, version: 2 };
    },
    completeOrder: async (id) => {
      calls.push(["completeOrder", id]);

      return { id, completed: true };
    },
    // The Square copy of a Venmo payment, nothing refunded on it yet.
    getPayment: async (id) => {
      calls.push(["getPayment", id]);

      return { squarePaymentId: id, status: "COMPLETED", refunded: 0 };
    },
    refundPayment: async ({ squarePaymentId, amount, key }) => {
      calls.push(["refundPayment", squarePaymentId, amount, key]);

      return { squareRefundId: `SQR-${key}`, status: "PENDING", amount };
    },
  };

  return { square, calls, fail };
};

const called = (calls, name) => calls.filter((c) => c[0] === name)
  .map((c) => c[1]);

// One world per case: the stores, Square, the mail sent, the log.
const world = async (t, records) => {
  const stores = testStores();
  const sent = [];
  const lines = [];
  const keep = (...args) => {
    for (const a of args) {
      try {
        lines.push(JSON.parse(a));
      } catch {
        // Not a log line.
      }
    }
  };

  t.mock.method(console, "info", keep);
  t.mock.method(console, "warn", keep);
  t.mock.method(console, "error", keep);

  await setCount(stores, SKU, 3);
  for (const record of records) await saveOrder(stores, record, now);

  const mail = async (m) => {
    sent.push(m);

    return { id: `m${sent.length}`, driver: "test" };
  };

  return { stores, sent, lines, mail, ...stubSquare() };
};

// A refund made in Square's dashboard, as Square delivers it.
const squareRefund = async (w, { orderId, refundId, amount }) => {
  const refund = {
    ...recordedBody("square", "refund-get").refund,
    id: refundId,
    "payment_id": `PAY-${orderId}`,
    status: "COMPLETED",
    "amount_money": { amount, currency: "USD" },
  };
  const text = JSON.stringify({
    "merchant_id": "MERCHANT", type: "refund.updated",
    "event_id": `evt-${refundId}`, "created_at": now.toISOString(),
    data: { type: "refund", id: refundId, object: { refund } },
  });
  const res = await squareHook(new Request(SQUARE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-square-hmacsha256-signature": signature(SQUARE_KEY, SQUARE_URL,
        text),
    },
    body: text,
  }), { stores: w.stores, env, now, mail: w.mail, square: w.square });

  assert.equal(res.status, 200, "the Square webhook answers 200");

  return res.json();
};

// A Venmo payment refunded in PayPal, as PayPal delivers it.
const paypalRefund = async (w, { orderId, refundId, amount }) => {
  const { headers, body } = webhookDelivery("PAYMENT.CAPTURE.REFUNDED", {
    orderId, paypalOrderId: `PPO-${orderId}`,
    paypalCaptureId: `CAP-${orderId}`, paypalRefundId: refundId, amount,
  });
  const res = await paypalHook(new Request("https://x/api/paypal/webhook", {
    method: "POST", headers, body,
  }), {
    stores: w.stores, env, now, mail: w.mail, square: w.square,
    verify: async () => true,
  });

  assert.equal(res.status, 200, "the PayPal webhook answers 200");

  return res.json();
};

const stock = async (stores) => (await getCounts(stores))[SKU];

// Whether the order is on the lists the farm works from.
const listed = async (stores, id) => {
  const open = await openOrders(stores);

  return {
    open: open.some((o) => o.id === id),
    listOpen: (await listOrders(stores, { open: true }))
      .some((o) => o.id === id),
    due: dueOn(open, DAY).some((o) => o.id === id),
  };
};

const ON = { open: true, listOpen: true, due: true };
const OFF = { open: false, listOpen: false, due: false };

const alerts = (sent) => sent.filter((m) => /^Site alert/.test(m.subject));

const toFarm = (m) => [].concat(m.to).includes(FARM);

// The farm's notices naming the order: emails to the farm that are not
// alerts and carry the order's id.
const notices = (sent, id) => sent.filter((m) => toFarm(m)
  && !/^Site alert/.test(m.subject)
  && `${m.subject}\n${m.text}`.includes(id));

// The log lines that record the order's close.
const closes = (lines, id) => lines.filter((l) => l.id === id
  && l.before === "paid" && l.after === "cancelled");

// Everything a close checks, on an order that was paid and on DAY.
const assertClosed = async (w, id, label) => {
  const saved = await getOrder(w.stores, id);

  assert.equal(saved.status, "cancelled", `${label}: status`);
  assert.equal(await stock(w.stores), 5, `${label}: stock back`);
  assert.deepEqual(called(w.calls, "cancelFulfillment"), [`SQO-${id}`],
    `${label}: the Square fulfillment closed, once`);
  assert.deepEqual(await listed(w.stores, id), OFF,
    `${label}: off the pickup and delivery lists`);
  assert.equal(saved.refunds.length, 1, `${label}: no second refund`);

  return saved;
};

describe("#775: a full refund made elsewhere closes the order", () => {
  it("box 1: a webhook-recorded refund that covers everything paid on " +
    "an unfulfilled order closes it as a cancellation would: cancelled, " +
    "stock back, Square fulfillment closed, off the pickup and delivery " +
    "lists", async (t) => {
    await t.test("refunded in Square's dashboard, an on-farm pickup",
      async (s) => {
        const w = await world(s, [order("NFF-A")]);

        assert.deepEqual(await listed(w.stores, "NFF-A"), ON, "setup");
        await squareRefund(w, {
          orderId: "NFF-A", refundId: "SQ-REF-A", amount: TOTAL,
        });
        await assertClosed(w, "NFF-A", "Square");
        assert.deepEqual(called(w.calls, "refundPayment"), [],
          "Square is asked for no refund");
      });

    await t.test("refunded in PayPal, a Venmo delivery", async (s) => {
      const w = await world(s, [order("NFF-B", {
        via: "venmo", method: "delivery",
      })]);

      assert.deepEqual(await listed(w.stores, "NFF-B"), ON, "setup");
      await paypalRefund(w, {
        orderId: "NFF-B", refundId: "PP-REF-B", amount: TOTAL,
      });
      await assertClosed(w, "NFF-B", "PayPal");
      // The one refund asked of Square is the webhook's own copy of
      // PayPal's, which it made before this issue.
      assert.equal(called(w.calls, "refundPayment").length, 1,
        "Square is asked only for the copy of PayPal's refund");
    });

    await t.test("Square refuses the fulfillment close of the order it " +
      "refunded: the order still closes and no alert fires", async (s) => {
      assert.ok(existsSync(REFUSED_FILE), `no recording of Square's ` +
        `refusal at test/fixtures/square/${REFUSED}.json: the ` +
        "coordinator records it with bin/fixtures/record");

      const w = await world(s, [order("NFF-C")]);

      w.fail.cancelFulfillment = (id) => refusal(REFUSED, `/v2/orders/${id}`);
      await squareRefund(w, {
        orderId: "NFF-C", refundId: "SQ-REF-C", amount: TOTAL,
      });

      const saved = await assertClosed(w, "NFF-C", "refused");

      assert.deepEqual(alerts(w.sent).map((m) => m.subject), [],
        "no alert");
      assert.ok(!(saved.flags && saved.flags.squareOutOfSync),
        "not flagged out of sync with Square");
    });
  });

  it("box 2: a partial refund leaves the order as it was; a full refund " +
    "of a fulfilled order leaves it fulfilled and marks it refunded",
  async (t) => {
    await t.test("a partial refund, from Square or from PayPal",
      async (s) => {
        const w = await world(s, [
          order("NFF-D"), order("NFF-E", { via: "venmo" }),
        ]);

        await squareRefund(w, {
          orderId: "NFF-D", refundId: "SQ-REF-D", amount: 500,
        });
        await paypalRefund(w, {
          orderId: "NFF-E", refundId: "PP-REF-E", amount: 500,
        });

        for (const id of ["NFF-D", "NFF-E"]) {
          const saved = await getOrder(w.stores, id);

          assert.equal(saved.status, "paid", `${id}: status`);
          assert.equal(refundedTotal(saved), 500, `${id}: refund noted`);
          assert.equal(saved.refunds.at(-1).total, false,
            `${id}: not refunded in full`);
          assert.deepEqual(await listed(w.stores, id), ON,
            `${id}: still on the lists`);
          assert.deepEqual(notices(w.sent, id), [], `${id}: no notice`);
        }
        assert.equal(await stock(w.stores), 3, "stock stays out");
        assert.deepEqual(called(w.calls, "cancelFulfillment"), [],
          "no Square fulfillment closed");
      });

    await t.test("a full refund of a fulfilled order", async (s) => {
      const w = await world(s, [order("NFF-F", { status: "fulfilled" })]);

      await squareRefund(w, {
        orderId: "NFF-F", refundId: "SQ-REF-F", amount: TOTAL,
      });

      const saved = await getOrder(w.stores, "NFF-F");

      assert.equal(saved.status, "fulfilled", "stays fulfilled");
      assert.equal(refundedTotal(saved), paidTotal(saved),
        "refunded in full");
      assert.equal(saved.refunds.at(-1).total, true, "marked refunded");
      assert.equal(await stock(w.stores), 3, "no stock back");
      assert.deepEqual(w.calls.filter((c) => [
        "cancelFulfillment", "cancelOrder", "updateFulfillment",
        "completeOrder",
      ].includes(c[0])), [], "Square's order is left as it is");
      assert.deepEqual(notices(w.sent, "NFF-F"), [], "no notice");
    });
  });

  it("box 3: the farm gets one notice naming the order each time this " +
    "happens, and the change is logged", async (t) => {
    await t.test("refunded in Square's dashboard, then delivered again",
      async (s) => {
        const w = await world(s, [order("NFF-G")]);
        const refund = {
          orderId: "NFF-G", refundId: "SQ-REF-G", amount: TOTAL,
        };

        await squareRefund(w, refund);
        assert.equal(notices(w.sent, "NFF-G").length, 1, "one notice");

        const logged = closes(w.lines, "NFF-G");

        assert.equal(logged.length, 1, "the close is logged");
        assert.equal(typeof logged[0].by, "string", "who acted");
        assert.ok(logged[0].by.length > 0, "who acted");
        assert.ok(logged[0]._time, "when");

        await squareRefund(w, refund);
        assert.equal(notices(w.sent, "NFF-G").length, 1,
          "a redelivery sends no second notice");
        assert.equal(closes(w.lines, "NFF-G").length, 1,
          "a redelivery logs no second close");
        for (const line of w.lines.filter((l) => l.id === "NFF-G")) {
          assert.ok(!JSON.stringify(line).includes(EMAIL),
            "no line carries the customer's email");
        }
      });

    await t.test("refunded in PayPal: PayPal's delivery, Square's for " +
      "its copy, then PayPal's again", async (s) => {
      const w = await world(s, [order("NFF-H", { via: "venmo" })]);
      const refund = {
        orderId: "NFF-H", refundId: "PP-REF-H", amount: TOTAL,
      };

      await paypalRefund(w, refund);

      const copy = (await getOrder(w.stores, "NFF-H")).refunds.at(-1)
        .squareRefundId;

      assert.ok(copy, "setup: Square holds a copy of PayPal's refund");
      await squareRefund(w, {
        orderId: "NFF-H", refundId: copy, amount: TOTAL,
      });
      await paypalRefund(w, refund);
      assert.equal(notices(w.sent, "NFF-H").length, 1, "one notice");
      assert.equal(closes(w.lines, "NFF-H").length, 1, "logged once");
    });

    await t.test("two orders, each refunded in full: a notice for each",
      async (s) => {
        const w = await world(s, [order("NFF-I"), order("NFF-J")]);

        await squareRefund(w, {
          orderId: "NFF-I", refundId: "SQ-REF-I", amount: TOTAL,
        });
        await squareRefund(w, {
          orderId: "NFF-J", refundId: "SQ-REF-J", amount: TOTAL,
        });
        assert.equal(notices(w.sent, "NFF-I").length, 1, "NFF-I's");
        assert.equal(notices(w.sent, "NFF-J").length, 1, "NFF-J's");
        assert.equal(closes(w.lines, "NFF-I").length, 1, "NFF-I logged");
        assert.equal(closes(w.lines, "NFF-J").length, 1, "NFF-J logged");
      });
  });
});
