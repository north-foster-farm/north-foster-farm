// Venmo, by email. Square cannot take Venmo, so a customer who wants
// to pay that way sends the money to the farm's Venmo profile with
// the order number in the note. Venmo emails the farm's account
// address, a Fastmail alias that also delivers to Resend's receiving
// address; Resend posts an `email.received` webhook, the function in
// venmo-inbound.mjs fetches the message, and this file reads it and
// marks the order paid.
//
// What one notification looks like (from a real one, 2026-09-22):
// From venmo@venmo.com, subject "<payer> paid you $<amount>", HTML
// only. The note is the text of <p class="transaction-note ...">, the
// transaction id the <p class="transaction-value"> after
// <h3>Transaction ID</h3>. Anything else from Venmo (a verification,
// a profile change) is not a payment and is ignored.
//
// Records: `venmo/<transactionId>` in the jobs store, one per payment
// however many times the webhook is delivered. A payment that names
// no order, or one whose amount is not the order's total, waits there
// for the evening report to the farm (market sales will do this
// daily, so the list is a report, not an alert).

import { createHmac, timingSafeEqual } from "node:crypto";

import { cancelInvoice } from "./square.mjs";
import { markPaid } from "./payments.mjs";
import { getOrder } from "./records.mjs";

export const VENMO_FROM = "venmo@venmo.com";
export const SIGNATURE_TOLERANCE = 5 * 60; // Seconds.

// Resend signs with Svix: base64(HMAC-SHA256(secret, id.timestamp.body))
// where the secret is the base64 after "whsec_", and the header lists
// "v1,<sig>" entries separated by spaces.
export const verifySignature = (secret, headers, body, now = new Date()) => {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const given = headers.get("svix-signature");

  if (!secret || !id || !timestamp || !given) return false;

  const age = Math.abs(now.getTime() / 1000 - Number(timestamp));

  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = Buffer.from(createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`).digest("base64"));

  return given.split(/\s+/).some((entry) => {
    const sig = Buffer.from(entry.replace(/^v1,/, ""));

    return sig.length === expected.length && timingSafeEqual(sig, expected);
  });
};

// For tests and the CLI: sign a body the way Resend would.
export const sign = (secret, id, timestamp, body) => {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");

  return `v1,${createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`).digest("base64")}`;
};

const unescape = (s) => String(s)
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, "\"")
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&nbsp;/g, " ")
  .trim();

const address = (from) => {
  const m = String(from || "").match(/<([^>]+)>/);

  return (m ? m[1] : String(from || "")).trim().toLowerCase();
};

// -> { ok: true, payer, cents, note, transactionId } for a "paid you"
// notification from Venmo, else { ok: false, reason }.
export const parseNotification = ({ from, subject, html }) => {
  if (address(from) !== VENMO_FROM) return { ok: false, reason: "not venmo" };

  const head = String(subject || "").trim()
    .match(/^(.+?) paid you \$([\d,]+)\.(\d{2})$/);

  if (!head) return { ok: false, reason: "not a payment" };

  const body = String(html || "");
  const note = body.match(/<p class="transaction-note[^"]*"[^>]*>([^<]*)<\/p>/);
  const txn = body.match(
    /Transaction ID<\/h3>\s*<p class="transaction-value"[^>]*>\s*(\d{6,32})\s*</
  );

  if (!txn) return { ok: false, reason: "no transaction id" };

  return {
    ok: true,
    payer: head[1].trim(),
    cents: Number(head[2].replace(/,/g, "")) * 100 + Number(head[3]),
    note: note ? unescape(note[1]) : "",
    transactionId: txn[1],
  };
};

// The order id in a note, however the customer typed it: any case,
// hyphens optional. -> "NFF-2610-K3WM" or null.
export const orderIdIn = (note) => {
  const m = String(note || "")
    .match(/nff\s*-?\s*(\d{4})\s*-?\s*([a-z2-9]{4})\b/i);

  return m ? `NFF-${m[1]}-${m[2].toUpperCase()}` : null;
};

export const venmoKey = (transactionId) => `venmo/${transactionId}`;

// Applies one parsed payment. -> { handled, reason?, id?, orderId? }.
// Idempotent on the transaction id. A match on order and amount marks
// the order paid (which sends the customer's email and the farm's)
// and closes the Square invoice so it cannot be paid twice; anything
// else is kept for the report.
export const applyPayment = async (stores, payment, {
  env = process.env,
  mail,
  now = new Date(),
  cancel = cancelInvoice,
} = {}) => {
  const key = venmoKey(payment.transactionId);

  if (await stores.jobs.get(key)) {
    return { handled: false, reason: "duplicate", id: payment.transactionId };
  }

  const orderId = orderIdIn(payment.note);
  const order = orderId ? await getOrder(stores, orderId) : null;
  const record = {
    at: now.toISOString(),
    payer: payment.payer,
    cents: payment.cents,
    note: payment.note,
    transactionId: payment.transactionId,
    orderId,
    orderTotal: order ? order.totals.total : null,
    matched: false,
    reportedAt: null,
  };

  if (order && order.status === "submitted"
    && order.totals.total === payment.cents) {
    await markPaid(stores, orderId, {
      env, mail, now, source: "venmo", via: "venmo",
    });
    if (order.square && order.square.invoiceId) {
      try {
        await cancel(order.square.invoiceId, { env });
      } catch (error) {
        console.error(JSON.stringify({
          event: "invoice.cancel_failed", id: orderId,
          error: String(error.message),
        }));
      }
    }
    record.matched = true;
    record.reportedAt = now.toISOString();
  }

  await stores.jobs.set(key, record);

  return {
    handled: true, id: payment.transactionId, orderId,
    matched: record.matched,
  };
};

// Every payment the site has seen, newest first. For the CLI.
export const allPayments = async (stores) => {
  const keys = await stores.jobs.list("venmo/");
  const records = await Promise.all(
    keys.map(({ key }) => stores.jobs.get(key))
  );

  return records.filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1));
};

// The payments still to tell the farm about: no order named, or an
// amount that is not the order's total.
export const unreportedPayments = async (stores) =>
  (await allPayments(stores)).filter((r) => !r.matched && !r.reportedAt);

export const markReported = async (stores, records, now) => {
  for (const r of records) {
    await stores.jobs.set(venmoKey(r.transactionId), {
      ...r, reportedAt: now.toISOString(),
    });
  }
};
