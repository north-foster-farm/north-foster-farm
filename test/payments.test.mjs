import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readMark } from "../netlify/functions/lib/health.mjs";
import {
  announcePaid, applyRefundEvent, confirmOrder, notifyFarm, recordRefund,
} from "../netlify/functions/lib/payments.mjs";
import {
  getOrder, openOrders, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import {
  handle, signature,
} from "../netlify/functions/square-webhook.mjs";

const now = new Date("2026-10-06T13:00:00Z");

const order = (id, method = "delivery") => ({
  id,
  status: "paid",
  submittedAt: "2026-10-06T12:00:00Z",
  paidAt: "2026-10-06T12:00:00Z",
  customer: {
    name: "Pat Example", firstName: "Pat", email: "pat@example.com",
    phone: "",
  },
  lines: [{ sku: "A", label: "Eggs (per dozen), Large", qty: 1, lineTotal: 7 }],
  totals: { subtotal: 700, discountAmount: 0, deliveryFee: 0, total: 700 },
  fulfilment: {
    method,
    date: "2026-10-08",
    state: method === "onfarm" ? "requested" : "agreed",
    onfarm: method === "onfarm" ? { window: "morning" } : null,
    delivery: method === "delivery" ? {
      address1: "1 Main St", town: "Foster", zip: "02825", cooler: "Porch",
    } : null,
  },
  square: { squareOrderId: "SQO", customerId: "CUST" },
  payment: {
    via: "square", method: "card", at: "2026-10-06T12:00:00Z",
    squarePaymentId: `PAY-${id}`, receiptUrl: "https://sq/receipt",
    brand: "VISA", last4: "4242",
  },
});

const mailbox = () => {
  const sent = [];

  return {
    sent,
    mail: async (m) => {
      sent.push(m);

      return { id: `m${sent.length}`, driver: "test" };
    },
  };
};

describe("announcePaid", () => {
  it("confirms a delivery once and tells the farm how it was paid",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailbox();
      const env = { ADMIN_EMAILS: "farm@x.com, second@x.com" };

      await saveOrder(stores, order("NFF-1"), now);
      const paid = await announcePaid(stores, "NFF-1", { mail, env, now });

      assert.equal(paid.status, "paid");
      assert.equal(sent.length, 2);
      assert.equal(sent[0].to, "pat@example.com");
      assert.match(sent[0].subject, /^Your order is confirmed$/);
      assert.deepEqual(sent[1].to, ["farm@x.com", "second@x.com"]);
      assert.match(sent[1].subject, /^New order NFF-1 — \$7, delivery$/);
      assert.match(sent[1].text, /Paid: \*\*\$7 by Visa ending 4242\*\*/);
      assert.match(sent[1].text,
        new RegExp("View order in Square: https://app\\.squareupsandbox" +
          "\\.com/dashboard/orders/overview/SQO"));

      // The farm's note must not write over the customer's.
      assert.equal(paid.emails.orderConfirmed.id, "m1");
      assert.equal(paid.emails.farmOrderPlaced.id, "m2");
      assert.equal((await readMark(stores, "paid")).id, "NFF-1");

      await announcePaid(stores, "NFF-1", { mail, env, now });
      await announcePaid(stores, "NFF-1", { mail, env, now });
      assert.equal(sent.length, 2, "both sent once");
      assert.equal(await announcePaid(stores, "NFF-9", { mail, env, now }),
        null);
    });

  it("tells an on-farm pickup its payment arrived, not that it is " +
    "confirmed", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await saveOrder(stores, order("NFF-1", "onfarm"), now);
    const paid = await announcePaid(stores, "NFF-1", { mail, env: {}, now });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, "Payment received");
    assert.equal(paid.emails.paymentReceived.id, "m1");
    assert.equal(paid.emails.orderConfirmed, undefined);

    await announcePaid(stores, "NFF-1", { mail, env: {}, now });
    assert.equal(sent.length, 1);
  });

  it("keeps the order open for the delivery reminder", async () => {
    const stores = testStores();
    const { mail } = mailbox();

    await saveOrder(stores, order("NFF-1"), now);
    await announcePaid(stores, "NFF-1", { mail, env: {}, now });
    assert.deepEqual((await openOrders(stores)).map((o) => o.id), ["NFF-1"]);
  });

  it("stays quiet when no one at the farm is listed", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await saveOrder(stores, order("NFF-1"), now);
    await announcePaid(stores, "NFF-1", { mail, env: {}, now });
    assert.equal(sent.length, 1);
  });

  it("still tells the farm when the customer's mail failed", async () => {
    const stores = testStores();
    const sent = [];
    const mail = async (m) => {
      if (m.to === "pat@example.com") throw new Error("resend down");
      sent.push(m);

      return { id: "m1", driver: "test" };
    };

    await saveOrder(stores, order("NFF-1"), now);

    const paid = await announcePaid(stores, "NFF-1", {
      mail, env: { ADMIN_EMAILS: "farm@x.com" }, now,
    });

    assert.equal(paid.status, "paid");
    // The farm gets its notice, and the alert about the failure.
    assert.equal(sent.length, 2);
    assert.ok(sent.some((m) => /^New order NFF-1/.test(m.subject)));
    assert.ok(sent.some((m) => m.subject === "Site alert: mail.failed"));
  });
});

describe("confirmOrder and notifyFarm", () => {
  it("confirms once unless told again", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await saveOrder(stores, order("NFF-1"), now);
    let o = await getOrder(stores, "NFF-1");

    o = await confirmOrder(stores, o, { mail, env: {}, now });
    o = await confirmOrder(stores, o, { mail, env: {}, now });
    assert.equal(sent.length, 1);

    const later = new Date(now.getTime() + 60_000);

    o = await confirmOrder(stores, o, {
      mail, env: {}, now: later, again: true,
    });
    assert.equal(sent.length, 2);
    assert.ok(o.emails[`orderConfirmed-${later.getTime()}`]);
  });

  it("notifies the farm once per key, and not at all with nobody listed",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailbox();
      const message = { subject: "Hello", text: "x", html: "<p>x</p>" };

      await saveOrder(stores, order("NFF-1"), now);
      let o = await getOrder(stores, "NFF-1");

      o = await notifyFarm(stores, o, "hello", message, { mail, env: {}, now });
      assert.equal(sent.length, 0);

      const env = { ADMIN_EMAILS: "farm@x.com" };

      o = await notifyFarm(stores, o, "hello", message, { mail, env, now });
      o = await notifyFarm(stores, o, "hello", message, { mail, env, now });
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].to, ["farm@x.com"]);
      assert.ok(o.emails.hello);
    });
});

describe("refunds", () => {
  it("recordRefund notes the money back and whether it was all of it",
    async () => {
      const stores = testStores();

      await saveOrder(stores, order("NFF-1"), now);
      const part = await recordRefund(stores, await getOrder(stores, "NFF-1"), {
        amount: 300, squareRefundId: "REF-1", status: "PENDING",
      }, "farm", now);

      assert.deepEqual(part.refunds, [{
        at: now.toISOString(), source: "farm", amount: 300,
        payment: "PAY-NFF-1", total: false, squareRefundId: "REF-1",
        paypalRefundId: null, status: "PENDING",
      }]);
      assert.equal(part.history.at(-1).event, "refund.recorded");

      const whole = await recordRefund(stores, part, {
        amount: 700, paypalRefundId: "PPR-1",
      }, "paypal", now);

      assert.equal(whole.refunds.at(-1).total, true);
      assert.equal(whole.refunds.at(-1).paypalRefundId, "PPR-1");
      assert.equal(whole.refunds.at(-1).squareRefundId, null);
    });

  const event = (refund) => ({
    type: "refund.updated", data: { object: { refund } },
  });

  it("applyRefundEvent notes a completed refund on the order it paid",
    async () => {
      const stores = testStores();

      await saveOrder(stores, order("NFF-1"), now);
      const r = await applyRefundEvent(stores, event({
        id: "REF-9", payment_id: "PAY-NFF-1", status: "COMPLETED",
        amount_money: { amount: 700, currency: "USD" },
      }), { now });

      assert.deepEqual(r, { handled: true, id: "NFF-1" });

      const noted = (await getOrder(stores, "NFF-1")).refunds.at(-1);

      assert.equal(noted.squareRefundId, "REF-9");
      assert.equal(noted.amount, 700);
      assert.equal(noted.total, true);
      assert.equal(noted.source, "square");

      const again = await applyRefundEvent(stores, event({
        id: "REF-9", payment_id: "PAY-NFF-1", status: "COMPLETED",
        amount_money: { amount: 700, currency: "USD" },
      }), { now });

      assert.deepEqual(again, { handled: true, id: "NFF-1", repeat: true });
      assert.equal((await getOrder(stores, "NFF-1")).history
        .filter((h) => h.event === "refund.recorded").length, 1);
    });

  it("applyRefundEvent completes a refund the farm made from the CLI",
    async () => {
      const stores = testStores();

      await saveOrder(stores, order("NFF-1"), now);
      await recordRefund(stores, await getOrder(stores, "NFF-1"), {
        amount: 700, squareRefundId: "REF-9", status: "PENDING",
      }, "farm", now);

      const r = await applyRefundEvent(stores, event({
        id: "REF-9", payment_id: "PAY-NFF-1", status: "COMPLETED",
        amount_money: { amount: 700, currency: "USD" },
      }), { now });

      assert.deepEqual(r, { handled: true, id: "NFF-1", repeat: true });

      const noted = await getOrder(stores, "NFF-1");

      assert.equal(noted.refunds.at(-1).status, "COMPLETED");
      assert.equal(noted.refunds.at(-1).source, "farm");
      assert.equal(noted.history
        .filter((h) => h.event === "refund.completed").length, 1);
      assert.equal(noted.history
        .filter((h) => h.event === "refund.recorded").length, 1);
    });

  it("applyRefundEvent leaves unknown payments and pending refunds alone",
    async () => {
      const stores = testStores();

      await saveOrder(stores, order("NFF-1"), now);
      assert.equal((await applyRefundEvent(stores, event({
        id: "REF-1", payment_id: "PAY-X", status: "COMPLETED",
      }), { now })).handled, false);
      assert.equal((await applyRefundEvent(stores, event({
        id: "REF-1", payment_id: "PAY-NFF-1", status: "PENDING",
      }), { now })).handled, false);
      assert.equal((await applyRefundEvent(stores, {}, { now })).handled,
        false);
      assert.equal((await getOrder(stores, "NFF-1")).refund, undefined);
    });
});

describe("POST /api/square/webhook", () => {
  const env = {
    SQUARE_WEBHOOK_SIGNATURE_KEY: "wh_secret",
    SQUARE_WEBHOOK_URL: "https://northfosterfarm.com/api/square/webhook",
  };
  const post = (body, sig) => new Request("http://x/api/square/webhook", {
    method: "POST",
    headers: sig ? { "x-square-hmacsha256-signature": sig } : {},
    body,
  });
  const body = JSON.stringify({
    type: "refund.updated",
    data: { object: { refund: {
      id: "REF-1", payment_id: "PAY-NFF-1", status: "COMPLETED",
      amount_money: { amount: 700, currency: "USD" },
    } } },
  });

  it("rejects a missing or wrong signature", async () => {
    const stores = testStores();

    assert.equal((await handle(post(body), { stores, env })).status, 401);
    assert.equal(
      (await handle(post(body, "nope"), { stores, env })).status, 401
    );
    assert.equal(
      (await handle(
        post(body, signature("other", env.SQUARE_WEBHOOK_URL, body)),
        { stores, env }
      )).status,
      401
    );
  });

  it("applies a signed refund event and marks the webhook alive",
    async () => {
      const stores = testStores();

      await saveOrder(stores, order("NFF-1"), now);

      const sig = signature(env.SQUARE_WEBHOOK_SIGNATURE_KEY,
        env.SQUARE_WEBHOOK_URL, body);
      const res = await handle(post(body, sig), { stores, env, now });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.deepEqual(data, { handled: true, id: "NFF-1" });
      assert.equal((await getOrder(stores, "NFF-1")).refunds.at(-1)
        .squareRefundId, "REF-1");
      assert.deepEqual(await readMark(stores, "webhook"),
        { at: now.toISOString(), type: "refund.updated" });
    });

  it("answers 200 for an unknown payment so Square stops retrying",
    async () => {
      const stores = testStores();
      const sig = signature(env.SQUARE_WEBHOOK_SIGNATURE_KEY,
        env.SQUARE_WEBHOOK_URL, body);
      const res = await handle(post(body, sig), { stores, env, now });

      assert.equal(res.status, 200);
      assert.equal((await res.json()).handled, false);
    });

  it("ignores other event types", async () => {
    const stores = testStores();
    const other = JSON.stringify({ type: "payment.updated", data: {} });
    const sig = signature(env.SQUARE_WEBHOOK_SIGNATURE_KEY,
      env.SQUARE_WEBHOOK_URL, other);
    const res = await handle(post(other, sig), { stores, env, now });

    assert.equal((await res.json()).reason, "ignored");
    assert.equal((await readMark(stores, "webhook")).type, "payment.updated");
  });

  it("rejects what is not JSON or not an event", async () => {
    const stores = testStores();
    const raw = "{nope";
    const sig = signature(env.SQUARE_WEBHOOK_SIGNATURE_KEY,
      env.SQUARE_WEBHOOK_URL, raw);

    assert.equal((await handle(post(raw, sig), { stores, env })).status, 400);

    const empty = JSON.stringify({ data: {} });
    const sig2 = signature(env.SQUARE_WEBHOOK_SIGNATURE_KEY,
      env.SQUARE_WEBHOOK_URL, empty);

    assert.equal((await handle(post(empty, sig2), { stores, env })).status,
      400);
  });
});
