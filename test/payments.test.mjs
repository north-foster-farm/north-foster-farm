import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyInvoiceEvent, markPaid, pollUnpaid,
} from "../netlify/functions/lib/payments.mjs";
import {
  getOrder, openOrders, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import {
  handle, signature,
} from "../netlify/functions/square-webhook.mjs";

const now = new Date("2026-10-06T13:00:00Z");

const order = (id, invoiceId = "INV-1") => ({
  id,
  status: "submitted",
  submittedAt: "2026-10-06T12:00:00Z",
  customer: { name: "Pat Example", email: "pat@example.com", phone: "" },
  lines: [{ sku: "A", label: "Eggs (per dozen), Large", qty: 1, lineTotal: 7 }],
  totals: { subtotal: 700, discountAmount: 0, deliveryFee: 0, total: 700 },
  fulfilment: {
    method: "onfarm", date: "2026-10-08", onfarm: { window: "morning" },
  },
  square: { invoiceId, invoiceUrl: "https://pay/x" },
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

describe("markPaid", () => {
  it("moves the order to paid and sends one confirmation", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await saveOrder(stores, order("NFF-1"), now);
    const paid = await markPaid(stores, "NFF-1", { mail, env: {}, now });

    assert.equal(paid.status, "paid");
    assert.equal(paid.paidAt, now.toISOString());
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /^Your order is confirmed$/);
    assert.equal(paid.emails.orderConfirmed.id, "m1");

    await markPaid(stores, "NFF-1", { mail, env: {}, now });
    await markPaid(stores, "NFF-1", { mail, env: {}, now });
    assert.equal(sent.length, 1, "confirmed once");
    assert.equal(await markPaid(stores, "NFF-9", { mail, env: {}, now }), null);
  });

  it("keeps the order open for the delivery reminder", async () => {
    const stores = testStores();
    const { mail } = mailbox();

    await saveOrder(stores, order("NFF-1"), now);
    await markPaid(stores, "NFF-1", { mail, env: {}, now });
    assert.deepEqual((await openOrders(stores)).map((o) => o.id), ["NFF-1"]);
  });

  it("tells the farm too, once, without losing the customer's", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const env = { ADMIN_EMAILS: "farm@x.com, second@x.com" };

    await saveOrder(stores, order("NFF-1"), now);

    const paid = await markPaid(stores, "NFF-1", { mail, env, now });

    assert.equal(sent.length, 2);
    assert.equal(sent[0].to, "pat@example.com");
    assert.deepEqual(sent[1].to, ["farm@x.com", "second@x.com"]);
    assert.match(sent[1].subject, /^Paid: order NFF-1/);

    // The farm's note must not write over the customer's.
    assert.equal(paid.emails.orderConfirmed.id, "m1");
    assert.equal(paid.emails.farmOrderPaid.id, "m2");

    await markPaid(stores, "NFF-1", { mail, env, now });
    assert.equal(sent.length, 2, "both sent once");
  });

  it("stays quiet when no one at the farm is listed", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await saveOrder(stores, order("NFF-1"), now);
    await markPaid(stores, "NFF-1", { mail, env: {}, now });
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

    const paid = await markPaid(stores, "NFF-1", {
      mail, env: { ADMIN_EMAILS: "farm@x.com" }, now,
    });

    assert.equal(paid.status, "paid");
    // The farm gets its paid notice, and the alert about the failure.
    assert.equal(sent.length, 2);
    assert.ok(sent.some((m) => /^Paid: order NFF-1/.test(m.subject)));
    assert.ok(sent.some((m) => m.subject === "Site alert: mail.failed"));
  });
});

describe("applyInvoiceEvent", () => {
  const event = (type, status, id = "INV-1") => ({
    type, data: { object: { invoice: { id, status } } },
  });

  it("pays the order the invoice belongs to", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await saveOrder(stores, order("NFF-1"), now);
    const r = await applyInvoiceEvent(
      stores, event("invoice.payment_made", "PAID"), { mail, env: {}, now }
    );

    assert.deepEqual(r, { handled: true, id: "NFF-1", status: "paid" });
    assert.equal((await getOrder(stores, "NFF-1")).status, "paid");
    assert.equal(sent.length, 1);
  });

  it("ignores unknown invoices and non-invoice events", async () => {
    const stores = testStores();
    const r = await applyInvoiceEvent(
      stores, event("invoice.updated", "PAID", "INV-X"), { env: {}, now }
    );

    assert.equal(r.handled, false);
    assert.equal((await applyInvoiceEvent(stores, {}, {})).handled, false);
  });

  it("cancels on a cancelled invoice, leaves paid orders alone", async () => {
    const stores = testStores();
    const { mail } = mailbox();

    await saveOrder(stores, order("NFF-1"), now);
    await applyInvoiceEvent(
      stores, event("invoice.updated", "CANCELED"), { mail, env: {}, now }
    );
    assert.equal((await getOrder(stores, "NFF-1")).status, "cancelled");

    await saveOrder(stores, order("NFF-2", "INV-2"), now);
    await markPaid(stores, "NFF-2", { mail, env: {}, now });
    const r = await applyInvoiceEvent(
      stores, event("invoice.updated", "CANCELED", "INV-2"), { mail, now }
    );

    assert.equal(r.status, "paid");
  });
});

describe("a pending bank transfer", () => {
  const event = (type, status, id = "INV-1") => ({
    type, data: { object: { invoice: { id, status } } },
  });
  const pending = event("invoice.updated", "PAYMENT_PENDING");

  it("holds the order until Square says paid", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const opts = { mail, env: {}, now };

    await saveOrder(stores, order("NFF-1"), now);
    const r = await applyInvoiceEvent(stores, pending, opts);
    const held = await getOrder(stores, "NFF-1");

    assert.deepEqual(r, { handled: true, id: "NFF-1", status: "held" });
    assert.equal(held.status, "submitted");
    assert.equal(held.paymentPending.at, now.toISOString());
    assert.equal(sent.length, 0, "Square tells the customer, not us");

    await applyInvoiceEvent(stores, pending, opts);
    const holds = (await getOrder(stores, "NFF-1")).history
      .filter((h) => h.event === "payment.pending");

    assert.equal(holds.length, 1, "held once");

    await applyInvoiceEvent(
      stores, event("invoice.payment_made", "PAID"), opts
    );
    assert.equal((await getOrder(stores, "NFF-1")).status, "paid");
    assert.equal(sent.length, 1);
  });

  it("does not take a payment event for a payment", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await saveOrder(stores, order("NFF-1"), now);
    const r = await applyInvoiceEvent(
      stores, event("invoice.payment_made", "PAYMENT_PENDING"),
      { mail, env: {}, now }
    );

    assert.equal(r.status, "held");
    assert.equal(sent.length, 0);
  });

  it("lifts the hold when the transfer fails", async () => {
    const stores = testStores();
    const opts = { env: {}, now };

    await saveOrder(stores, order("NFF-1"), now);
    await applyInvoiceEvent(stores, pending, opts);
    const r = await applyInvoiceEvent(
      stores, event("invoice.updated", "UNPAID"), opts
    );
    const back = await getOrder(stores, "NFF-1");

    assert.equal(r.status, "submitted");
    assert.equal(back.paymentPending, null);
    assert.equal(back.history.at(-1).event, "payment.failed");
  });

  it("is held by the poll too", async () => {
    const stores = testStores();
    const invoice = async (id) => ({ id, status: "PAYMENT_PENDING" });

    await saveOrder(stores, order("NFF-1"), now);
    const paid = await pollUnpaid(stores, await openOrders(stores), {
      invoice, env: {}, now,
    });

    assert.deepEqual(paid, []);
    assert.ok((await getOrder(stores, "NFF-1")).paymentPending);
  });
});

describe("pollUnpaid", () => {
  it("asks Square about each unpaid order and pays the paid ones", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const asked = [];
    const invoice = async (id) => {
      asked.push(id);

      return { id, status: id === "INV-2" ? "PAID" : "UNPAID" };
    };

    await saveOrder(stores, order("NFF-1", "INV-1"), now);
    await saveOrder(stores, order("NFF-2", "INV-2"), now);
    await saveOrder(stores, order("NFF-3", "INV-3"), now);
    await markPaid(stores, "NFF-3", { mail, env: {}, now });

    const paid = await pollUnpaid(stores, await openOrders(stores), {
      invoice, mail, env: {}, now,
    });

    assert.deepEqual(paid, ["NFF-2"]);
    assert.deepEqual(asked.sort(), ["INV-1", "INV-2"], "paid ones not asked");
    assert.equal((await getOrder(stores, "NFF-2")).status, "paid");
    assert.equal(sent.length, 2);
  });

  it("survives a Square error on one invoice", async () => {
    const stores = testStores();
    const { mail } = mailbox();
    const invoice = async (id) => {
      if (id === "INV-1") throw new Error("boom");

      return { id, status: "PAID" };
    };

    await saveOrder(stores, order("NFF-1", "INV-1"), now);
    await saveOrder(stores, order("NFF-2", "INV-2"), now);
    const paid = await pollUnpaid(stores, await openOrders(stores), {
      invoice, mail, env: {}, now,
    });

    assert.deepEqual(paid, ["NFF-2"]);
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
    type: "invoice.payment_made",
    data: { object: { invoice: { id: "INV-1", status: "PAID" } } },
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

  it("applies a signed event", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await saveOrder(stores, order("NFF-1"), now);

    const sig = signature(env.SQUARE_WEBHOOK_SIGNATURE_KEY,
      env.SQUARE_WEBHOOK_URL, body);
    const res = await handle(post(body, sig), { stores, env, now, mail });
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(data, { handled: true, id: "NFF-1", status: "paid" });
    assert.equal(sent.length, 1);
  });

  it("answers 200 for an unknown invoice so Square stops retrying",
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
  });
});
