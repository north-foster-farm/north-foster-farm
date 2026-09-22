import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allPayments, applyPayment, orderIdIn, parseNotification, sign,
  unreportedPayments, verifySignature,
} from "../netlify/functions/lib/venmo.mjs";
import { getOrder, saveOrder } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/venmo-inbound.mjs";

const now = new Date("2026-09-22T15:00:00Z");

// The shape of a real notification (2026-09-22), trimmed to the parts
// the parser reads, with Venmo's inline styles in the way.
const html = (note, txn = "4691637974882101462") =>
  "<html><body><table><tr><td>" +
  "<div class=\"amount-container\" >" +
  "<div class=\"amount-container__centered\" >" +
  "<div class=\"amount-container__text-high\" >$</div>" +
  "<div class=\"amount-container__amount-text\" >45</div><span >.</span>" +
  "<div class=\"amount-container__text-high\" >00</div></div></div> " +
  `<p class="transaction-note secondary-text" style="margin:0;color:#6b6e76">${
    note}</p>` +
  "<h3 style=\"margin:0\">Transaction ID</h3>" +
  `<p class="transaction-value" style="margin:0">${txn}</p>` +
  "<h3 >Sent to</h3><p class=\"transaction-value\" >@northfosterfarm</p>" +
  "</td></tr></table></body></html>";

const notice = (over = {}) => ({
  from: "Venmo <venmo@venmo.com>",
  subject: "Pat Example paid you $45.00",
  html: html("Chicken NFF-2610-K3WM"),
  ...over,
});

const order = (id = "NFF-2610-K3WM", total = 4500) => ({
  id,
  status: "submitted",
  submittedAt: "2026-09-22T12:00:00Z",
  customer: { name: "Pat Example", email: "pat@example.com", phone: "" },
  lines: [{ sku: "A", label: "Whole Chicken", qty: 1, lineTotal: 45 }],
  totals: { subtotal: total, discountAmount: 0, deliveryFee: 0, total },
  fulfilment: {
    method: "onfarm", date: "2026-10-08", state: "agreed",
    onfarm: { window: "morning" },
  },
  square: { invoiceId: `INV-${id}`, invoiceUrl: "https://pay/x" },
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

describe("reading a Venmo notification", () => {
  it("takes the payer and amount from the subject, the note and id from " +
    "the body", () => {
    const p = parseNotification(notice());

    assert.deepEqual(p, {
      ok: true, payer: "Pat Example", cents: 4500,
      note: "Chicken NFF-2610-K3WM", transactionId: "4691637974882101462",
    });
    assert.equal(parseNotification(notice({
      subject: "Dana Whitcomb paid you $1,094.50",
    })).cents, 109450);
    assert.equal(parseNotification(notice({
      html: html("Eggs &amp; chicken &#39;NFF-2610-K3WM&#39;"),
    })).note, "Eggs & chicken 'NFF-2610-K3WM'");
  });

  it("refuses anything that is not Venmo saying someone paid", () => {
    assert.equal(parseNotification(notice({
      from: "someone@example.com",
    })).reason, "not venmo");
    assert.equal(parseNotification(notice({
      subject: "Venmo primary email address changed",
    })).reason, "not a payment");
    assert.equal(parseNotification(notice({
      subject: "You paid Pat Example $45.00",
    })).reason, "not a payment");
    assert.equal(parseNotification(notice({
      html: "<p>nothing here</p>",
    })).reason, "no transaction id");
  });

  it("finds the order id however it was typed", () => {
    assert.equal(orderIdIn("Chicken NFF-2610-K3WM thanks"), "NFF-2610-K3WM");
    assert.equal(orderIdIn("nff2610k3wm"), "NFF-2610-K3WM");
    assert.equal(orderIdIn("order nff-2610 k3wm"), "NFF-2610-K3WM");
    assert.equal(orderIdIn("Test7"), null);
    assert.equal(orderIdIn(""), null);
  });
});

describe("the Svix signature", () => {
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const body = "{\"type\":\"email.received\"}";
  const ts = String(Math.floor(now.getTime() / 1000));
  const headers = (sig, timestamp = ts) => new Headers({
    "svix-id": "msg_1", "svix-timestamp": timestamp, "svix-signature": sig,
  });

  it("accepts a good signature, in a list, within five minutes", () => {
    const good = sign(secret, "msg_1", ts, body);

    assert.equal(verifySignature(secret, headers(good), body, now), true);
    assert.equal(verifySignature(secret, headers(`v1,nope ${good}`), body,
      now), true);
  });

  it("rejects a wrong secret, a changed body, a stale timestamp, and no " +
    "secret at all", () => {
    const good = sign(secret, "msg_1", ts, body);

    assert.equal(verifySignature("whsec_AAAA", headers(good), body, now),
      false);
    assert.equal(verifySignature(secret, headers(good), `${body} `, now),
      false);
    const old = String(Math.floor(now.getTime() / 1000) - 600);

    assert.equal(verifySignature(secret,
      headers(sign(secret, "msg_1", old, body), old), body, now), false);
    assert.equal(verifySignature("", headers(good), body, now), false);
    assert.equal(verifySignature(secret, new Headers(), body, now), false);
  });
});

describe("applying a payment", () => {
  const paid = () => parseNotification(notice());

  it("marks the named order paid by Venmo once, and closes the invoice",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailbox();
      const cancelled = [];
      const cancel = async (id) => { cancelled.push(id); };
      const opts = { env: { ADMIN_EMAILS: "farm@x.com" }, mail, now, cancel };

      await saveOrder(stores, order(), now);
      const r = await applyPayment(stores, paid(), opts);
      const o = await getOrder(stores, "NFF-2610-K3WM");

      assert.deepEqual(r, {
        handled: true, id: "4691637974882101462", orderId: "NFF-2610-K3WM",
        matched: true,
      });
      assert.equal(o.status, "paid");
      assert.deepEqual(o.payment, { via: "venmo", at: now.toISOString() });
      assert.deepEqual(cancelled, ["INV-NFF-2610-K3WM"]);
      assert.equal(sent.length, 2, "the customer's email and the farm's");
      assert.match(sent[0].subject, /confirmed/);

      const again = await applyPayment(stores, paid(), opts);

      assert.equal(again.reason, "duplicate");
      assert.equal(sent.length, 2);
      assert.deepEqual(await unreportedPayments(stores), []);
      assert.equal((await allPayments(stores))[0].matched, true,
        "the applied payment is still on record for the CLI");
    });

  it("keeps a payment with no order, a wrong amount, or an order not " +
    "waiting for money, for the report", async () => {
    const stores = testStores();
    const { mail } = mailbox();
    const opts = { env: {}, mail, now };

    await saveOrder(stores, order("NFF-2610-K3WM", 6200), now);
    await saveOrder(stores, { ...order("NFF-2610-PAID"), status: "paid" }, now);

    const none = await applyPayment(stores, parseNotification(notice({
      html: html("Test7", "4691637974882100001"),
    })), opts);
    const wrong = await applyPayment(stores, paid(), opts);
    const done = await applyPayment(stores, parseNotification(notice({
      html: html("NFF-2610-PAID", "4691637974882100003"),
    })), opts);

    assert.equal(none.matched, false);
    assert.equal(none.orderId, null);
    assert.equal(wrong.matched, false);
    assert.equal(done.matched, false);
    assert.equal((await getOrder(stores, "NFF-2610-K3WM")).status,
      "submitted");

    const waiting = await unreportedPayments(stores);

    assert.deepEqual(waiting.map((v) => [v.transactionId, v.orderId,
      v.orderTotal]).sort(), [
      ["4691637974882100001", null, null],
      ["4691637974882100003", "NFF-2610-PAID", 4500],
      ["4691637974882101462", "NFF-2610-K3WM", 6200],
    ]);
  });
});

describe("POST /api/venmo/inbound", () => {
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const env = {
    RESEND_WEBHOOK_SECRET: secret, RESEND_READ_KEY: "re_read",
    ADMIN_EMAILS: "farm@x.com",
  };
  const event = (type = "email.received") => JSON.stringify({
    type,
    "created_at": now.toISOString(),
    data: { "email_id": "em_1", from: "venmo@venmo.com", subject: "x" },
  });
  const post = (body, signed = true) => {
    const ts = String(Math.floor(now.getTime() / 1000));

    return new Request("https://x/api/venmo/inbound", {
      method: "POST",
      headers: signed ? {
        "svix-id": "msg_1", "svix-timestamp": ts,
        "svix-signature": sign(secret, "msg_1", ts, body),
      } : {},
      body,
    });
  };
  const resend = (message) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push([url, init.headers.Authorization]);

      return { ok: true, json: async () => message };
    };

    return { calls, fetchImpl };
  };

  it("fetches the message and pays the order", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const { calls, fetchImpl } = resend({
      from: "venmo@venmo.com",
      headers: { from: "Venmo <venmo@venmo.com>" },
      subject: "Pat Example paid you $45.00",
      html: html("NFF-2610-K3WM"),
    });

    await saveOrder(stores, order(), now);
    const res = await handle(post(event()), {
      stores, env, now, mail, fetchImpl, cancel: async () => {},
    });
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.matched, true);
    assert.deepEqual(calls, [[
      "https://api.resend.com/emails/receiving/em_1", "Bearer re_read",
    ]]);
    assert.equal((await getOrder(stores, "NFF-2610-K3WM")).status, "paid");
    assert.equal(sent.length, 2);
  });

  it("rejects an unsigned request, ignores other events and other mail",
    async () => {
      const stores = testStores();
      const unsigned = await handle(post(event(), false), { stores, env, now });

      assert.equal(unsigned.status, 401);

      const other = await handle(post(event("email.sent")), {
        stores, env, now,
      });

      assert.deepEqual(await other.json(),
        { handled: false, reason: "ignored" });

      const { fetchImpl } = resend({
        from: "venmo@venmo.com", subject: "Venmo primary email address changed",
        html: "<p>verification</p>",
      });
      const notice_ = await handle(post(event()), {
        stores, env, now, fetchImpl,
      });

      assert.equal((await notice_.json()).reason, "not a payment");
    });

  it("answers 502 when Resend cannot be read, so it retries", async () => {
    const stores = testStores();
    const fetchImpl = async () => ({ ok: false, status: 500 });
    const res = await handle(post(event()), { stores, env, now, fetchImpl });

    assert.equal(res.status, 502);
  });
});
