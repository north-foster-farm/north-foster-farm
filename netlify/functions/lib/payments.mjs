// What happens around the money: the emails a paid order sends, once,
// and the refunds, from the CLI or reported by a processor's webhook.
// The taking of the money is checkout.mjs.

import { alert, mark, noteMail } from "./health.mjs";
import { adminEmails, sendMail } from "./mail.mjs";
import { log } from "./log.mjs";
import {
  amendOrder, getOrder, moneyPatch, needsAgreement, orderByPayment,
  paidTotal, paymentRef, paymentsOf, refundedTotal, refundsOf,
} from "./records.mjs";
import { mailLinks, orderUrlFor } from "./site.mjs";
import { dashboardUrl } from "./square.mjs";
import {
  farmOrderPlaced, orderConfirmed, paymentReceived,
} from "./templates.mjs";

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
// a retry never sends it twice.
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

// The emails a freshly paid order sends, each once however many times
// this runs. Delivery and the drop site are confirmed by paying;
// an on-farm pickup the farm has not agreed to yet is not, so that
// customer hears "Payment received" now and "confirmed" when the farm
// agrees. The farm hears once either way.
export const announcePaid = async (stores, id, {
  mail = sendMail,
  env = process.env,
  now = new Date(),
} = {}) => {
  let order = await getOrder(stores, id);

  if (!order) return null;

  const first = paymentsOf(order)[0];

  await mark(stores, "paid", { id, via: first && first.via }, now);

  if (!needsAgreement(order)) {
    order = await confirmOrder(stores, order, { mail, env, now });
  } else if (!(order.emails && order.emails.paymentReceived)) {
    order = await sendForOrder(stores, order, "paymentReceived",
      paymentReceived(order, {
        orderUrl: orderUrlFor(env, order.id), links: mailLinks(env),
      }),
      { mail, env, now });
  }

  return notifyFarm(stores, order, "farmOrderPlaced", farmOrderPlaced(order, {
    squareUrl: dashboardUrl(order.square, env), links: mailLinks(env),
  }), { mail, env, now });
};

// A refund, added to the order's list: who did it, how much, which
// payment it came out of (`payment`, see paymentRef), and the
// processors' ids. `total` says whether, with it, everything paid has
// gone back. Built on the record as it is now, so a refund recorded
// meanwhile (a webhook, the CLI) is kept.
export const recordRefund = async (stores, order, refund, source, now) => {
  const current = (await getOrder(stores, order.id)) || order;
  const refunds = [...refundsOf(current), {
    at: now.toISOString(),
    source,
    amount: refund.amount,
    payment: refund.payment || paymentRef(paymentsOf(current)[0]),
    total: refundedTotal(current) + refund.amount >= paidTotal(current),
    squareRefundId: refund.squareRefundId || null,
    paypalRefundId: refund.paypalRefundId || null,
    status: refund.status || null,
  }];

  return amendOrder(stores, order.id, moneyPatch(current, { refunds }),
    "refund.recorded", now);
};

// A refund made in the Square dashboard rather than the CLI reaches
// the record through the webhook. -> { handled, id }.
export const applyRefundEvent = async (stores, event, { now = new Date() }
= {}) => {
  const refund = event && event.data && event.data.object
    && event.data.object.refund;

  if (!refund || !refund.payment_id) {
    return { handled: false, reason: "no refund" };
  }
  if (refund.status !== "COMPLETED") {
    return { handled: false, reason: `refund ${refund.status}` };
  }

  const order = await orderByPayment(stores, refund.payment_id);

  if (!order) return { handled: false, reason: "unknown payment" };

  const refunds = refundsOf(order);
  const known = refunds.findIndex((r) => r.squareRefundId === refund.id);

  if (known >= 0) {
    // A refund the CLI made is recorded PENDING; Square's word that
    // it completed is the one change worth noting.
    if (refunds[known].status !== refund.status) {
      await amendOrder(stores, order.id, moneyPatch(order, {
        refunds: refunds.map((r, i) => (i === known
          ? { ...r, status: refund.status }
          : r)),
      }), "refund.completed", now);
    }

    return { handled: true, id: order.id, repeat: true };
  }

  const from = paymentsOf(order)
    .find((x) => x.squarePaymentId === refund.payment_id);

  await recordRefund(stores, order, {
    amount: refund.amount_money ? refund.amount_money.amount : 0,
    payment: paymentRef(from),
    squareRefundId: refund.id,
    status: refund.status,
  }, "square", now);

  return { handled: true, id: order.id };
};
