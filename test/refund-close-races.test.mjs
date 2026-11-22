// The implementer's tests for the races and guards security found in
// #783 (closing an order refunded in full elsewhere, #775). Additions
// to test/refund-close.test.mjs, never in its place: a webhook that
// lands while the CLI is refunding, Square's copy of a PayPal refund
// landing before PayPal's handler writes, and the close deciding on
// the record as its write finds it. Refunds arrive as the criteria
// tests deliver them: a signed Square refund.updated built on the
// recorded refund (test/fixtures/square/refund-get.json), and the
// recorded PayPal PAYMENT.CAPTURE.REFUNDED (lib/fake-paypal.mjs).
// Square and PayPal are stubbed at lib/square.mjs's and
// lib/paypal.mjs's surface; nothing reaches a real service.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REFUNDING_MS, cancelOrder, closeRefunded, refundOrder,
} from "../netlify/functions/lib/admin.mjs";
import { webhookDelivery } from "../netlify/functions/lib/fake-paypal.mjs";
import { recordRefund } from "../netlify/functions/lib/payments.mjs";
import {
  amendOrder, getOrder, moveStatus, refundedTotal, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { getCounts, setCount } from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle as paypalHook } from "../netlify/functions/paypal-webhook.mjs";
import {
  handle as squareHook, signature,
} from "../netlify/functions/square-webhook.mjs";
import { body as recordedBody } from "./recorded.mjs";

const now = new Date("2026-11-21T09:27:00Z");
const SKU = "NFF-CHK-EGG-LG";
const TOTAL = 1400;
const FARM = "farm@example.com";
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

const order = (id, { via = "square", status = "paid" } = {}) => ({
  id,
  status,
  submittedAt: "2026-11-20T23:00:00.000Z",
  paidAt: "2026-11-20T23:00:00.000Z",
  customer: { name: "Pat Example", email: "pat@example.com", phone: "" },
  lines: [{ sku: SKU, label: "Eggs (per dozen), Large", qty: 2,
    unitPrice: 7, lineTotal: 14 }],
  totals: { subtotal: TOTAL, discountAmount: 0, deliveryFee: 0,
    total: TOTAL },
  fulfilment: { method: "onfarm", date: "2026-11-23",
    onfarm: { window: "morning", phone: "4015550100" } },
  square: { squareOrderId: `SQO-${id}`, customerId: "CUST" },
  payment: via === "venmo"
    ? {
      via: "venmo", method: "venmo", at: "2026-11-20T23:00:00.000Z",
      squarePaymentId: `PAY-${id}`, paypalOrderId: `PPO-${id}`,
      paypalCaptureId: `CAP-${id}`, amount: TOTAL,
    }
    : {
      via: "square", method: "card", at: "2026-11-20T23:00:00.000Z",
      squarePaymentId: `PAY-${id}`, amount: TOTAL,
    },
});

// One world per case. `w.during` runs inside the processor's refund
// call, before it answers: the webhook that beats the CLI's write.
const world = async (t, record) => {
  const stores = testStores();
  const sent = [];
  const calls = [];
  const w = { stores, sent, calls, during: null, refunded: 0 };

  for (const name of ["info", "warn", "error"]) {
    t.mock.method(console, name, () => {});
  }
  await setCount(stores, SKU, 3);
  await saveOrder(stores, record, now);

  w.mail = async (m) => {
    sent.push(m);

    return { id: `m${sent.length}`, driver: "test" };
  };
  w.square = {
    cancelFulfillment: async (id) => {
      calls.push(["cancelFulfillment", id]);

      return { id, cancelled: true };
    },
    cancelOrder: async (id) => ({ id }),
    getPayment: async (id) => ({
      squarePaymentId: id, status: "COMPLETED", refunded: w.refunded,
    }),
    refundPayment: async ({ squarePaymentId, amount, key }) => {
      calls.push(["refundPayment", squarePaymentId, amount, key]);
      const out = { squareRefundId: `SQR-${key}`, status: "PENDING", amount };

      if (w.during) await w.during(out);

      return out;
    },
  };
  w.paypal = {
    refundCapture: async ({ amount, key }) => {
      calls.push(["refundCapture", amount, key]);
      const out = { paypalRefundId: `PPR-${key}`, status: "COMPLETED" };

      if (w.during) await w.during(out);

      return out;
    },
  };

  return w;
};

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

  return res.json();
};

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

  return res.json();
};

const stock = async (stores) => (await getCounts(stores))[SKU];
const count = (calls, name) => calls.filter((c) => c[0] === name).length;
const toFarm = (sent) => sent.filter((m) => [].concat(m.to).includes(FARM));

describe("a webhook that beats the CLI's refund write (#783)", () => {
  it("orders cancel restocks, closes Square and emails once", async (t) => {
    const id = "NFF-2611-RCA1";
    const w = await world(t, order(id));

    w.during = (out) => squareRefund(w, {
      orderId: id, refundId: out.squareRefundId, amount: TOTAL,
    });

    await cancelOrder(w.stores, id, {
      now, env, mail: w.mail, square: w.square, paypal: w.paypal,
    });
    const after = await getOrder(w.stores, id);

    assert.equal(after.status, "cancelled");
    assert.equal(await stock(w.stores), 5, "two dozen back, once");
    assert.equal(count(w.calls, "cancelFulfillment"), 1);
    assert.equal(refundedTotal(after), TOTAL, "the refund counted once");
    assert.deepEqual(after.refunds.map((r) => r.source), ["farm"],
      "the CLI's refund, though Square's webhook wrote it first");
    assert.equal(w.sent.length, 1, "the customer's email alone");
    assert.equal(toFarm(w.sent).length, 0, "no refunded-elsewhere notice");
    assert.equal(await w.stores.orders.get(`refunding/${id}`), null,
      "the marker is cleared");
  });

  it("orders refund in full keeps the order open", async (t) => {
    const id = "NFF-2611-RCB1";
    const w = await world(t, order(id));

    w.during = (out) => squareRefund(w, {
      orderId: id, refundId: out.squareRefundId, amount: TOTAL,
    });

    await refundOrder(w.stores, id, {
      now, env, square: w.square, paypal: w.paypal,
    });
    const after = await getOrder(w.stores, id);

    assert.equal(after.status, "paid");
    assert.equal(await stock(w.stores), 3);
    assert.equal(count(w.calls, "cancelFulfillment"), 0);
    assert.equal(w.sent.length, 0);
  });

  it("a Venmo refund in full keeps the order open", async (t) => {
    const id = "NFF-2611-RCB2";
    const w = await world(t, order(id, { via: "venmo" }));

    w.during = (out) => (out.paypalRefundId
      ? paypalRefund(w, { orderId: id, refundId: out.paypalRefundId,
        amount: TOTAL })
      : null);

    await refundOrder(w.stores, id, {
      now, env, square: w.square, paypal: w.paypal,
    });
    const after = await getOrder(w.stores, id);

    assert.equal(after.status, "paid");
    assert.equal(refundedTotal(after), TOTAL, "the refund counted once");
    assert.equal(await stock(w.stores), 3);
    assert.equal(w.sent.length, 0);
  });

  it("a stale marker never keeps an order from closing", async (t) => {
    const id = "NFF-2611-RCB3";
    const w = await world(t, order(id));

    await w.stores.orders.set(`refunding/${id}`, {
      key: "refund-dead",
      at: new Date(now.getTime() - REFUNDING_MS - 1).toISOString(),
    });
    await squareRefund(w, { orderId: id, refundId: "SQR-DASH", amount: TOTAL });

    assert.equal((await getOrder(w.stores, id)).status, "cancelled");
  });
});

describe("Square's copy of a PayPal refund (#783)", () => {
  it("a half refund landing first, then redelivered, stays half",
    async (t) => {
      const id = "NFF-2611-RCC1";
      const w = await world(t, order(id, { via: "venmo" }));

      w.during = (out) => squareRefund(w, {
        orderId: id, refundId: out.squareRefundId, amount: 700,
      });

      await paypalRefund(w, { orderId: id, refundId: "PPREF-1", amount: 700 });
      w.during = null;
      w.refunded = 700;
      await paypalRefund(w, { orderId: id, refundId: "PPREF-1", amount: 700 });
      const after = await getOrder(w.stores, id);

      assert.equal(after.status, "paid");
      assert.equal(refundedTotal(after), 700);
      assert.equal(after.refunds.length, 1);
      assert.equal(after.refunds[0].paypalRefundId, "PPREF-1");
      assert.equal(after.refunds[0].source, "paypal");
    });

  it("an unknown refund on a Venmo payment is left to PayPal",
    async (t) => {
      const id = "NFF-2611-RCC2";
      const w = await world(t, order(id, { via: "venmo" }));
      const result = await squareRefund(w, {
        orderId: id, refundId: "SQR-COPY", amount: TOTAL,
      });
      const after = await getOrder(w.stores, id);

      assert.equal(result.repeat, true);
      assert.equal(after.status, "paid");
      assert.equal(refundedTotal(after), 0);
    });

  it("recordRefund merges the PayPal id onto the entry it matches",
    async (t) => {
      const id = "NFF-2611-RCC3";
      const w = await world(t, order(id, { via: "venmo" }));
      const first = await getOrder(w.stores, id);

      await recordRefund(w.stores, first, {
        amount: 700, payment: `CAP-${id}`, squareRefundId: "SQR-1",
        status: "COMPLETED",
      }, "square", now);
      await recordRefund(w.stores, first, {
        amount: 700, payment: `CAP-${id}`, squareRefundId: "SQR-1",
        paypalRefundId: "PPREF-9", status: "COMPLETED",
      }, "paypal", now);
      const after = await getOrder(w.stores, id);

      assert.equal(after.refunds.length, 1);
      assert.equal(after.refunds[0].paypalRefundId, "PPREF-9");
      assert.equal(after.refunds[0].squareRefundId, "SQR-1");
      assert.equal(after.refunds[0].source, "paypal");
      assert.equal(refundedTotal(after), 700);
    });
});

describe("the close's own guards (#783)", () => {
  it("decides on the record as its write finds it", async (t) => {
    const id = "NFF-2611-RCD1";
    const w = await world(t, order(id));

    await amendOrder(w.stores, id, () => ({
      refunds: [{ at: now.toISOString(), source: "square", amount: TOTAL,
        payment: `PAY-${id}`, squareRefundId: "SQR-D1",
        status: "COMPLETED" }],
    }), "refund.recorded", now);

    // A second payment lands between the close's read and its write.
    const { getTagged } = w.stores.orders;
    let once = false;

    t.mock.method(w.stores.orders, "getTagged", async (key) => {
      if (!once && key === `order/${id}`) {
        once = true;
        const found = await getTagged.call(w.stores.orders, key);

        await w.stores.orders.set(key, {
          ...found.value,
          payments: [found.value.payment, { via: "square", method: "card",
            at: now.toISOString(), squarePaymentId: "PAY-2", amount: 300 }],
          payment: undefined,
        });
      }

      return getTagged.call(w.stores.orders, key);
    });

    await closeRefunded(w.stores, id, {
      now, env, mail: w.mail, square: w.square, source: "square",
    });
    const after = await getOrder(w.stores, id);

    assert.equal(after.status, "paid", "$3 is still paid");
    assert.equal(await stock(w.stores), 3);
    assert.equal(w.sent.length, 0);
  });

  it("leaves an unpaid order alone while a payment is under way",
    async (t) => {
      const id = "NFF-2611-RCD2";
      const w = await world(t, order(id, { status: "unpaid" }));

      await amendOrder(w.stores, id, () => ({
        refunds: [{ at: now.toISOString(), source: "square", amount: TOTAL,
          payment: `PAY-${id}`, squareRefundId: "SQR-D2",
          status: "COMPLETED" }],
      }), "refund.recorded", now);
      await w.stores.orders.create(`pay-pending/${id}`, {
        key: "farm-pay", attempt: 1, at: now.toISOString(),
      });

      await closeRefunded(w.stores, id, {
        now, env, mail: w.mail, square: w.square, source: "square",
      });

      assert.equal((await getOrder(w.stores, id)).status, "unpaid");
      assert.equal(w.sent.length, 0);
    });

  it("moveStatus says which writer made the move", async (t) => {
    const id = "NFF-2611-RCD3";
    const w = await world(t, order(id));
    const first = await moveStatus(w.stores, id, "cancelled", now);
    const second = await moveStatus(w.stores, id, "cancelled", now);

    assert.equal(first.moved, true);
    assert.equal(first.before, "paid");
    assert.equal(second.moved, false);
    assert.equal(second.order.status, "cancelled");
  });
});
