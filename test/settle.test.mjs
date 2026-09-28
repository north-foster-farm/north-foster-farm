import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import { applyRefundEvent } from "../netlify/functions/lib/payments.mjs";
import {
  getOrder, refundedTotal, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import {
  STALL_AFTER, checkRefunds, unsettled,
} from "../netlify/functions/lib/settle.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const DAY = 24 * 60 * 60 * 1000;
const made = new Date("2026-10-06T13:00:00Z");
const later = (ms) => new Date(made.getTime() + ms);

const refund = (fields) => ({
  at: made.toISOString(), source: "farm", amount: 700, payment: "PAY-1",
  total: true, squareRefundId: null, paypalRefundId: null,
  status: "PENDING", ...fields,
});

const order = (id, refunds) => ({
  id,
  status: "cancelled",
  submittedAt: "2026-10-06T12:00:00Z",
  paidAt: "2026-10-06T12:00:00Z",
  customer: { name: "Pat Example", email: "pat@example.com", phone: "" },
  lines: [{ sku: "A", label: "Eggs (per dozen), Large", qty: 1, lineTotal: 7 }],
  totals: { subtotal: 700, discountAmount: 0, deliveryFee: 0, total: 700 },
  fulfilment: { method: "onfarm", date: "2026-10-07", onfarm: {} },
  square: { squareOrderId: "SQO", customerId: "CUST" },
  payments: [{
    via: "square", method: "card", amount: 700, squarePaymentId: "PAY-1",
  }],
  refunds,
});

// Square and PayPal, each answering from a table of refund statuses,
// and counting what they were asked.
const processors = (statuses) => {
  const asked = [];
  const answer = (id) => {
    asked.push(id);
    if (statuses[id] instanceof Error) throw statuses[id];

    return statuses[id];
  };

  return {
    asked,
    square: {
      getRefund: async (id) => ({ squareRefundId: id, status: answer(id) }),
    },
    paypal: {
      getRefund: async (id) => ({ paypalRefundId: id, status: answer(id) }),
    },
  };
};

const alerting = () => {
  const sent = [];

  return {
    sent,
    env: { ADMIN_EMAILS: "farm@x.com" },
    mail: async (m) => {
      sent.push(m);

      return { id: `m${sent.length}`, driver: "test" };
    },
    alerts: (kind) => sent
      .filter((m) => m.subject === `Site alert: ${kind}`).length,
  };
};

const history = (o, event) => o.history
  .filter((h) => h.event === event).length;

describe("the refund check (#215)", () => {
  it("lists only the refunds not yet settled", () => {
    const found = unsettled([
      order("NFF-1", [
        refund({ squareRefundId: "R1", status: "COMPLETED" }),
        refund({ squareRefundId: "R2" }),
      ]),
      order("NFF-2", [refund({ paypalRefundId: "P1", status: "FAILED" })]),
      order("NFF-3", [refund({ paypalRefundId: "P2", status: "CANCELLED" })]),
      order("NFF-4", []),
    ]);

    assert.deepEqual(found.map((f) => [f.order.id, f.refund.squareRefundId]),
      [["NFF-1", "R2"]]);
  });

  it("notes a refund Square completed and asks no more", async () => {
    const stores = testStores();
    const { sent, env, mail } = alerting();
    const { square, paypal, asked } = processors({ R1: "COMPLETED" });

    await saveOrder(stores, order("NFF-1", [
      refund({ squareRefundId: "R1" }),
    ]), made);

    const r = await checkRefunds(stores, {
      now: later(DAY), env, mail, square, paypal,
    });

    assert.equal(r.checked, 1);
    assert.equal(r.completed.length, 1);

    const noted = await getOrder(stores, "NFF-1");

    assert.equal(noted.refunds[0].status, "COMPLETED");
    assert.equal(history(noted, "refund.completed"), 1);
    assert.equal(sent.length, 0);

    const again = await checkRefunds(stores, {
      now: later(2 * DAY), env, mail, square, paypal,
    });

    assert.equal(again.checked, 0);
    assert.deepEqual(asked, ["R1"]);
  });

  it("asks PayPal about a Venmo refund, marks one it cancelled and " +
    "alerts the farm", async () => {
    const stores = testStores();
    const { env, mail, alerts } = alerting();
    const { square, paypal, asked } = processors({ P1: "CANCELLED" });

    await saveOrder(stores, order("NFF-1", [
      refund({ paypalRefundId: "P1", squareRefundId: "R-COPY" }),
    ]), made);

    const r = await checkRefunds(stores, {
      now: later(DAY), env, mail, square, paypal,
    });

    assert.deepEqual(asked, ["P1"], "PayPal, not Square's copy");
    assert.deepEqual(r.failed.map((x) => [x.id, x.via, x.status]),
      [["NFF-1", "paypal", "CANCELLED"]]);

    const noted = await getOrder(stores, "NFF-1");

    assert.equal(noted.refunds[0].status, "CANCELLED");
    assert.equal(refundedTotal(noted), 0, "no longer counted as refunded");
    assert.equal(history(noted, "refund.failed"), 1);
    assert.equal(alerts("refund.failed"), 1);
  });

  it("leaves a young pending refund alone and alerts a stalled one " +
    "once", async () => {
    const stores = testStores();
    const { env, mail, alerts } = alerting();
    const { square, paypal } = processors({ R1: "PENDING" });

    await saveOrder(stores, order("NFF-1", [
      refund({ squareRefundId: "R1" }),
    ]), made);

    const young = await checkRefunds(stores, {
      now: later(STALL_AFTER - DAY), env, mail, square, paypal,
    });

    assert.equal(young.pending.length, 1);
    assert.equal(young.stalled.length, 0);

    const old = await checkRefunds(stores, {
      now: later(STALL_AFTER), env, mail, square, paypal,
    });

    assert.equal(old.stalled.length, 1);
    assert.equal(alerts("refund.stalled"), 1);

    const noted = await getOrder(stores, "NFF-1");

    assert.equal(noted.refunds[0].stalledAt, later(STALL_AFTER).toISOString());
    assert.equal(refundedTotal(noted), 700, "a stalled refund still counts");

    const next = await checkRefunds(stores, {
      now: later(STALL_AFTER + 2 * DAY), env, mail, square, paypal,
    });

    assert.equal(next.stalled.length, 1, "still listed");
    assert.equal(alerts("refund.stalled"), 1, "but alerted only once");
  });

  it("calls a refund with no processor id stalled, asking nobody",
    async () => {
      const stores = testStores();
      const { env, mail, alerts } = alerting();
      const { square, paypal, asked } = processors({});

      await saveOrder(stores, order("NFF-1", [refund({ status: null })]),
        made);

      const r = await checkRefunds(stores, {
        now: later(STALL_AFTER), env, mail, square, paypal,
      });

      assert.deepEqual(asked, []);
      assert.deepEqual(r.stalled.map((x) => [x.id, x.via]),
        [["NFF-1", null]]);
      assert.equal(alerts("refund.stalled"), 1);
    });

  it("reports a processor it could not reach and changes nothing",
    async () => {
      const stores = testStores();
      const { sent, env, mail } = alerting();
      const { square } = processors({ R1: new Error("Square 503") });

      await saveOrder(stores, order("NFF-1", [
        refund({ squareRefundId: "R1" }),
        refund({ paypalRefundId: "P1", at: later(1).toISOString() }),
      ]), made);

      const r = await checkRefunds(stores, {
        now: later(DAY), env, mail, square, paypal: null,
      });

      assert.deepEqual(r.errors.map((e) => e.error),
        ["Square 503", "PayPal is not configured."]);
      assert.equal(sent.length, 0);
      assert.deepEqual((await getOrder(stores, "NFF-1")).refunds
        .map((x) => x.status), ["PENDING", "PENDING"]);
    });

  it("keeps a Venmo refund's status when Square's copy of it changes",
    async () => {
      const stores = testStores();
      const { sent, env, mail } = alerting();

      await saveOrder(stores, order("NFF-1", [
        refund({ paypalRefundId: "P1", squareRefundId: "R-COPY" }),
      ]), made);

      const r = await applyRefundEvent(stores, {
        type: "refund.updated",
        data: { object: { refund: {
          id: "R-COPY", "payment_id": "PAY-1", status: "COMPLETED",
          "amount_money": { amount: 700, currency: "USD" },
        } } },
      }, { now: later(1000), env, mail });

      assert.deepEqual(r, { handled: true, id: "NFF-1", repeat: true });
      assert.equal((await getOrder(stores, "NFF-1")).refunds[0].status,
        "PENDING");
      assert.equal(sent.length, 0);
    });
});

describe("the refund check in the jobs", () => {
  // 07:30 and 06:30 in New York, 7 and 8 days after the refund.
  const morning = new Date("2026-10-13T11:30:00Z");
  const early = new Date("2026-10-14T10:30:00Z");

  it("runs once a day from 07:00 and puts what it could not ask on " +
    "the report", async () => {
    const stores = testStores();
    const { env, mail } = alerting();
    const { square, asked } = processors({ R1: new Error("Square 503") });

    await saveOrder(stores, order("NFF-1", [
      refund({ squareRefundId: "R1" }),
    ]), made);

    const first = await runJobs(stores, {
      now: morning, env, mail, square, paypal: null,
    });

    assert.deepEqual(first.refunds, {
      checked: 1, completed: 0, failed: 0, stalled: 0, pending: 0,
    });
    assert.deepEqual(first.errors.map((e) => [e.id, e.step, e.error]),
      [["NFF-1", "refundCheck", "Square 503"]]);

    const second = await runJobs(stores, {
      now: new Date(morning.getTime() + 15 * 60 * 1000), env, mail, square,
      paypal: null,
    });

    assert.equal(second.refunds, null, "done for the day");

    const before = await runJobs(stores, {
      now: early, env, mail, square, paypal: null,
    });

    assert.equal(before.refunds, null, "not before 07:00");
    assert.deepEqual(asked, ["R1"]);
  });
});
