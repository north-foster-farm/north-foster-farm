// What happens when an invoice is paid, wherever the news comes from:
// the Square webhook, the scheduled poll, or the CLI. One function
// moves the order to paid and sends the confirmation, once.

import { adminEmails, sendMail } from "./mail.mjs";
import {
  amendOrder, getOrder, orderByInvoice, setStatus,
} from "./records.mjs";
import { accountUrlFor } from "./site.mjs";
import { dashboardUrl, getInvoice } from "./square.mjs";
import { farmOrderPaid, orderConfirmed } from "./templates.mjs";

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

    return amendOrder(stores, order.id, {
      emails: {
        ...(current.emails || {}),
        [key]: { at: now.toISOString(), ...sent },
      },
    }, `mail.${key}`, now);
  } catch (error) {
    console.error(JSON.stringify({
      event: "mail.failed", template: key, id: order.id,
      error: String(error && error.message), detail: error && error.detail,
    }));

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

// -> the order, now paid; or null if unknown. A second call is a
// no-op, so the webhook and the poll can both report the same payment.
export const markPaid = async (stores, id, {
  mail = sendMail,
  env = process.env,
  now = new Date(),
  source = "square",
} = {}) => {
  const paid = await setStatus(stores, id, "paid", now, { source });

  if (!paid) return null;

  let order = paid;

  if (!(order.emails && order.emails.orderConfirmed)) {
    order = await sendForOrder(stores, order, "orderConfirmed",
      orderConfirmed(order, { accountUrl: accountUrlFor(env) }),
      { mail, env, now });
  }

  return notifyFarm(stores, order, "farmOrderPaid", farmOrderPaid(order, {
    squareUrl: dashboardUrl(order.square, env),
  }), { mail, env, now });
};

// A bank transfer sits PAYMENT_PENDING for days while it clears. The
// order is held meanwhile: no reminders, no abandoning at the cutoff,
// no confirmation until Square says PAID. Square itself tells the
// customer when a transfer starts and when one fails, so the site
// sends nothing. A failed transfer puts the invoice back to UNPAID,
// which lifts the hold, and the reminders resume.
const hold = (stores, order, now, source) => (order.paymentPending
  ? order
  : amendOrder(stores, order.id, {
    paymentPending: { at: now.toISOString(), source },
  }, "payment.pending", now));

const release = (stores, order, now) => (order.paymentPending
  ? amendOrder(stores, order.id, {
    paymentPending: null,
  }, "payment.failed", now)
  : order);

// Applies Square's word on an invoice to a submitted order, whoever
// carried it. -> paid, cancelled, held, or submitted. The status is
// the whole story: an invoice.payment_made event whose invoice is
// still PAYMENT_PENDING is a transfer that has started, not money.
const applyStatus = async (stores, order, status, options, source) => {
  const now = options.now || new Date();

  if (order.status !== "submitted") return order.status;

  if (status === "PAID") {
    await markPaid(stores, order.id, { ...options, source });

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
      console.error(JSON.stringify({
        event: "poll.failed", id: order.id, error: String(error.message),
      }));
      continue;
    }

    const result = await applyStatus(stores, order, status, options, "poll");

    if (result === "paid") paid.push(order.id);
  }

  return paid;
};
