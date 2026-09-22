// What happens when an invoice is paid, wherever the news comes from:
// the Square webhook, the scheduled poll, or the CLI. One function
// moves the order to paid and sends the confirmation, once.

import { alert, mark, noteMail } from "./health.mjs";
import { adminEmails, sendMail } from "./mail.mjs";
import { log } from "./log.mjs";
import {
  amendOrder, getOrder, needsAgreement, orderByInvoice, setStatus,
} from "./records.mjs";
import { mailLinks, orderUrlFor } from "./site.mjs";
import { dashboardUrl, getInvoice } from "./square.mjs";
import {
  completeYourOrder, farmOrderPaid, orderConfirmed, paymentReceived,
} from "./templates.mjs";

// How many times the pay-link email may be sent again for one order,
// by the customer looking the order up or pressing "Resend".
export const RESEND_LIMIT = 5;

// Sends one templated email about an order and notes it on the order.
// The recipient is the customer unless `to` says otherwise. Never
// throws: a mail failure is logged and the order is left for the next
// run to retry.
export const sendForOrder = async (stores, order, key, message, {
  mail = sendMail,
  env = process.env,
  now = new Date(),
  to = order.customer.email,
} = {}) => {
  try {
    const sent = await mail({
      to,
      idempotencyKey: `${order.id}-${key}`,
      ...message,
    }, { env });

    // Re-read before merging: two sends about one order in a row
    // would otherwise write the second note over the first.
    const current = await getOrder(stores, order.id) || order;
    const noted = await amendOrder(stores, order.id, {
      emails: {
        ...(current.emails || {}),
        [key]: { at: now.toISOString(), ...sent },
      },
    }, `mail.${key}`, now);

    await noteMail(stores, true, now);

    return noted;
  } catch (error) {
    const message = String(error && error.message);

    log.error({
      event: "mail.failed", template: key, id: order.id,
      error: message, detail: error && error.detail,
    });
    await noteMail(stores, false, now, { error: message });
    await alert(stores, "mail.failed", {
      id: order.id, template: key, error: message,
    }, { env, mail, now });

    return order;
  }
};

// The farm's own notice about an order, to ADMIN_EMAILS. Silent when
// nobody is listed, and recorded on the order like any other send, so
// a retry of the webhook or the poll never sends it twice.
export const notifyFarm = async (stores, order, key, message, {
  mail = sendMail,
  env = process.env,
  now = new Date(),
} = {}) => {
  const to = adminEmails(env);

  if (!to.length) return order;
  if (order.emails && order.emails[key]) return order;

  return sendForOrder(stores, order, key, message, { mail, env, now, to });
};

// "Your order is confirmed", once, when the order is paid and its
// window agreed. `again` is for the farm confirming a window the
// customer re-picked after an earlier confirmation, which the
// `emails` table would otherwise keep to the first.
export const confirmOrder = async (stores, order, {
  mail = sendMail,
  env = process.env,
  now = new Date(),
  again = false,
} = {}) => {
  const done = !!(order.emails && order.emails.orderConfirmed);

  if (done && !again) return order;

  const key = done ? `orderConfirmed-${now.getTime()}` : "orderConfirmed";

  return sendForOrder(stores, order, key, orderConfirmed(order, {
    orderUrl: orderUrlFor(env, order.id), links: mailLinks(env),
  }), { mail, env, now });
};

// -> the order, now paid; or null if unknown. A second call is a
// no-op, so the webhook and the poll can both report the same payment.
// An on-farm pickup the farm has not agreed to yet is not confirmed
// by paying: that customer hears "Payment received" now and
// "confirmed" when the farm agrees.
export const markPaid = async (stores, id, {
  mail = sendMail,
  env = process.env,
  now = new Date(),
  source = "square",
  via = "square",
} = {}) => {
  const paid = await setStatus(stores, id, "paid", now, { source, via });

  if (!paid) return null;

  let order = paid;

  // How the money came: square, venmo, cash, check. Kept once, from
  // the call that moved the order to paid.
  if (!order.payment) {
    order = await amendOrder(stores, id, {
      payment: { via, at: now.toISOString() },
    }, "payment.recorded", now);
    await mark(stores, "paid", { id, via, source }, now);
  }

  if (!needsAgreement(order)) {
    order = await confirmOrder(stores, order, { mail, env, now });
  } else if (!(order.emails && order.emails.paymentReceived)) {
    order = await sendForOrder(stores, order, "paymentReceived",
      paymentReceived(order, {
        orderUrl: orderUrlFor(env, order.id), links: mailLinks(env),
      }),
      { mail, env, now });
  }

  return notifyFarm(stores, order, "farmOrderPaid", farmOrderPaid(order, {
    squareUrl: dashboardUrl(order.square, env), links: mailLinks(env),
  }), { mail, env, now });
};

// The pay-link email again, for a customer who lost it: by the
// "Find my order" form (with a sign-in link to the order page as
// `orderUrl`) or the order page's Resend button. Logged under
// `emails` as invoiceResent-<n> and capped at RESEND_LIMIT.
// -> { ok, order } or { ok: false, reason: "limit" }.
export const resendInvoice = async (stores, order, {
  orderUrl = null,
  mail = sendMail,
  env = process.env,
  now = new Date(),
} = {}) => {
  const count = Object.keys(order.emails || {})
    .filter((k) => k.startsWith("invoiceResent-")).length;

  if (count >= RESEND_LIMIT) return { ok: false, reason: "limit", order };

  const sent = await sendForOrder(stores, order, `invoiceResent-${count + 1}`,
    completeYourOrder(order, { orderUrl, links: mailLinks(env) }),
    { mail, env, now });

  return { ok: true, order: sent };
};

// A bank transfer sits PAYMENT_PENDING for days while it clears. The
// order is held meanwhile: no reminders, no abandoning at the cutoff,
// no confirmation until Square says PAID. Square itself tells the
// customer when a transfer starts and when one fails, so the site
// sends nothing. A failed transfer puts the invoice back to UNPAID,
// which lifts the hold, and the reminders resume.
export const hold = (stores, order, now, source) => (order.paymentPending
  ? order
  : amendOrder(stores, order.id, {
    paymentPending: { at: now.toISOString(), source },
  }, "payment.pending", now));

export const release = (stores, order, now, event = "payment.failed") => (
  order.paymentPending
    ? amendOrder(stores, order.id, { paymentPending: null }, event, now)
    : order);

// Applies Square's word on an invoice to a submitted order, whoever
// carried it. -> paid, cancelled, held, or submitted. The status is
// the whole story: an invoice.payment_made event whose invoice is
// still PAYMENT_PENDING is a transfer that has started, not money.
const applyStatus = async (stores, order, status, options, source) => {
  const now = options.now || new Date();

  if (order.status !== "submitted") return order.status;

  if (status === "PAID") {
    await markPaid(stores, order.id, { ...options, source, via: "square" });

    return "paid";
  }
  if (status === "CANCELED") {
    await setStatus(stores, order.id, "cancelled", now, { source: "square" });

    return "cancelled";
  }
  if (status === "PAYMENT_PENDING") {
    await hold(stores, order, now, source);

    return "held";
  }
  if (status === "UNPAID") await release(stores, order, now);

  return "submitted";
};

// A Square invoice event names the invoice; the by-invoice index
// names the order.
export const applyInvoiceEvent = async (stores, event, options = {}) => {
  const invoice = event && event.data && event.data.object
    && event.data.object.invoice;

  if (!invoice || !invoice.id) return { handled: false, reason: "no invoice" };

  const order = await orderByInvoice(stores, invoice.id);

  if (!order) return { handled: false, reason: "unknown invoice" };

  const status = await applyStatus(
    stores, order, invoice.status, options, "webhook"
  );

  return { handled: true, id: order.id, status };
};

// The fallback for a missed webhook: ask Square about every unpaid
// order. -> the ids that just became paid.
export const pollUnpaid = async (stores, orders, {
  invoice = getInvoice,
  ...options
} = {}) => {
  const paid = [];

  for (const order of orders) {
    if (order.status !== "submitted" || !order.square
      || !order.square.invoiceId) continue;

    let status;

    try {
      status = (await invoice(order.square.invoiceId, options)).status;
    } catch (error) {
      log.error({
        event: "poll.failed", id: order.id, error: String(error.message),
      });
      await alert(stores, "poll.failed", {
        id: order.id, invoice: order.square.invoiceId,
        error: String(error.message),
      }, options);
      continue;
    }

    const result = await applyStatus(stores, order, status, options, "poll");

    if (result === "paid") paid.push(order.id);
  }

  return paid;
};
