// What happens around the money: the emails a paid order sends, once,
// and the refunds, from the CLI or reported by a processor's webhook.
// The taking of the money is checkout.mjs.

import { alert, mark, noteMail } from "./health.mjs";
import { now as clock } from "./clock.mjs";
import { farmEmails, sendMail } from "./mail.mjs";
import { log } from "./log.mjs";
import {
  FAILED_REFUND, amendOrder, getOrder, moneyPatch, orderByPayment,
  ordersFor, paidTotal, paymentRef, paymentsOf, refundedTotal, refundsOf,
} from "./records.mjs";
import { mailLinks, orderUrlFor } from "./site.mjs";
import { clientConfig as paypalConfig } from "./paypal.mjs";
import { clientConfig as squareConfig, dashboardUrl } from "./square.mjs";
import { deployContext } from "./store.mjs";
import { farmOrderPlaced, orderConfirmed } from "./templates.mjs";

// A deploy preview, or `dev`, with no processor set up: payments are
// switched off there (docs/secrets.md, "Previews"). The API and the
// order page say so plainly, instead of failing on the first missing
// key and alerting the farm. Never production or staging: a missing
// key there is a real fault and stays one.
export const PAYMENTS_OFF = "Payments are switched off in previews, so " +
  "no order can be placed here. The live site takes orders.";

export const paymentsOff = (env = process.env) =>
  ["deploy-preview", "dev"].includes(deployContext(env))
  && env.SQUARE_ENV !== "fake" && env.PAYPAL_ENV !== "fake"
  && !squareConfig(env) && !paypalConfig(env) && !env.SQUARE_ACCESS_TOKEN;

// `bin/nff --no-email`: while on, no email goes to a customer, from
// any command. The send is noted on the order as suppressed (history
// `mail.suppressed.<key>`, `emails[key].suppressed`), so the jobs
// never send it later. The farm's own notices are unaffected.
let withheld = false;

export const withholdCustomerEmail = (on = true) => {
  withheld = on;
};

export const customerEmailWithheld = () => withheld;

// Sends one templated email about an order and notes it on the order.
// The recipient is the customer unless `to` says otherwise. Never
// throws: a mail failure is logged and the order is left for the next
// run to retry. An email sent again for a new day passes its own
// `idempotencyKey`, so Resend never takes it for the first.
export const sendForOrder = async (stores, order, key, message, {
  mail = sendMail,
  env = process.env,
  now = clock(),
  to = order.customer.email,
  idempotencyKey = `${order.id}-${key}`,
} = {}) => {
  if (withheld && to === order.customer.email) {
    const current = await getOrder(stores, order.id) || order;

    // A send already noted keeps its time and Resend id.
    if ((current.emails || {})[key]) return current;

    return amendOrder(stores, order.id, (f) => ({
      emails: {
        ...(f.emails || {}),
        [key]: { at: now.toISOString(), suppressed: true },
      },
    }), `mail.suppressed.${key}`, now);
  }

  try {
    const sent = await mail({
      to,
      idempotencyKey,
      ...message,
    }, { env });

    // Merged into the record as it is when the write lands: two sends
    // about one order in a row would otherwise write the second note
    // over the first.
    const noted = await amendOrder(stores, order.id, (current) => ({
      emails: {
        ...(current.emails || {}),
        [key]: { at: now.toISOString(), ...sent },
      },
    }), `mail.${key}`, now);

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

// The farm's own notice about an order, to FARM_NOTIFICATIONS_EMAIL.
// Silent when
// nobody is listed, and recorded on the order like any other send, so
// a retry never sends it twice.
export const notifyFarm = async (stores, order, key, message, {
  mail = sendMail,
  env = process.env,
  now = clock(),
} = {}) => {
  const to = farmEmails(env);

  if (!to.length) return order;
  if (order.emails && order.emails[key]) return order;

  return sendForOrder(stores, order, key, message, { mail, env, now, to });
};

// "Your order is confirmed", once, when the order is paid. `again`
// sends it once more, which the `emails` table would otherwise keep
// to the first.
export const confirmOrder = async (stores, order, {
  mail = sendMail,
  env = process.env,
  now = clock(),
  again = false,
} = {}) => {
  const done = !!(order.emails && order.emails.orderConfirmed);

  if (done && !again) return order;

  const key = done ? `orderConfirmed-${now.getTime()}` : "orderConfirmed";

  // The account is said once (#114): in the first confirmation of the
  // first order paid on this email. A checkout never paid for, or a
  // sign-in without an order, does not count as one.
  const paidBefore = !done && (await ordersFor(stores, order.customer.email))
    .some((o) => o.id !== order.id && (o.status === "paid"
      || o.status === "fulfilled" || paymentsOf(o).length > 0));

  return sendForOrder(stores, order, key, orderConfirmed(order, {
    orderUrl: orderUrlFor(env, order.id), links: mailLinks(env),
    firstOrder: !done && !paidBefore,
  }), { mail, env, now });
};

// The emails a freshly paid order sends, each once however many times
// this runs. Paying books every way to get an order, a pickup time
// included (W11d), so the customer hears "confirmed" now; the farm
// hears once.
export const announcePaid = async (stores, id, {
  mail = sendMail,
  env = process.env,
  now = clock(),
} = {}) => {
  let order = await getOrder(stores, id);

  if (!order) return null;

  const first = paymentsOf(order)[0];

  await mark(stores, "paid", { id, via: first && first.via }, now);

  order = await confirmOrder(stores, order, { mail, env, now });

  return notifyFarm(stores, order, "farmOrderPlaced", farmOrderPlaced(order, {
    squareUrl: dashboardUrl(order.square, env), links: mailLinks(env),
  }), { mail, env, now });
};

// A refund, added to the order's list: who did it, how much, which
// payment it came out of (`payment`, see paymentRef), and the
// processors' ids. `total` says whether, with it, everything paid has
// gone back. Built on the record as it is now, so a refund recorded
// meanwhile (a webhook, the CLI) is kept.
export const recordRefund = async (
  stores, order, refund, source, now, { env, mail } = {},
) => {
  // The list is built on the record as the write finds it, so two
  // refunds recorded together both stay. A refund the processor
  // already gave an id that the record holds (an edit retried by its
  // key, or a webhook for a refund the CLI is recording) is recorded
  // once.
  const same = (r, field) => !!refund[field] && r[field] === refund[field];
  const saved = await amendOrder(stores, order.id, (current) => {
    if (refundsOf(current).some((r) => same(r, "squareRefundId")
      || same(r, "paypalRefundId"))) {
      return null;
    }

    return moneyPatch(current, {
      refunds: [...refundsOf(current), {
        at: now.toISOString(),
        source,
        amount: refund.amount,
        payment: refund.payment || paymentRef(paymentsOf(current)[0]),
        total: refundedTotal(current) + refund.amount >= paidTotal(current),
        squareRefundId: refund.squareRefundId || null,
        paypalRefundId: refund.paypalRefundId || null,
        status: refund.status || null,
        ...(refund.edit ? { edit: refund.edit } : {}),
        // Handed back by the farm itself (#181): no processor to ask.
        ...(refund.byHand ? { byHand: true } : {}),
        // Credit put back on the member's ledger (#471).
        ...(refund.via === "credit" ? { via: "credit" } : {}),
      }],
    });
  }, "refund.recorded", now).catch(async (error) => {
    // The processor has the money back and the record does not say so.
    // The farm hears of it before the caller does, so nobody refunds
    // the same money again; the processor's webhook records it in the
    // end.
    await alert(stores, "refund.unrecorded", {
      id: order.id, amount: refund.amount,
      squareRefundId: refund.squareRefundId || null,
      paypalRefundId: refund.paypalRefundId || null,
      error: String(error && error.message),
    }, {
      now, env, mail,
      // One mute per refund: a second one lost is news of its own.
      mute: `refund.unrecorded-${refund.squareRefundId
        || refund.paypalRefundId || order.id}`,
    });

    throw error;
  });

  return saved || order;
};

// A refund made in the Square dashboard rather than the CLI reaches
// the record through the webhook, and so does Square's word on how a
// refund ended. One that FAILED or was REJECTED returned nothing: the
// CLI's record of it is marked so (it no longer counts as refunded),
// and the farm is alerted, since the customer is still owed (#215).
// -> { handled, id }.
export const applyRefundEvent = async (stores, event, {
  now = clock(),
  env = process.env,
  mail = sendMail,
} = {}) => {
  const refund = event && event.data && event.data.object
    && event.data.object.refund;

  if (!refund || !refund.payment_id) {
    return { handled: false, reason: "no refund" };
  }

  const failed = FAILED_REFUND.includes(refund.status);

  if (refund.status !== "COMPLETED" && !failed) {
    return { handled: false, reason: `refund ${refund.status}` };
  }

  const order = await orderByPayment(stores, refund.payment_id);
  const refunds = refundsOf(order);
  const known = refunds.findIndex((r) => r.squareRefundId === refund.id);

  // A Venmo refund's Square refund only keeps Square's books; PayPal
  // says whether the customer got the money (lib/settle.mjs).
  if (known >= 0 && refunds[known].paypalRefundId) {
    return { handled: true, id: order.id, repeat: true };
  }

  const changed = known < 0 || refunds[known].status !== refund.status;

  if (failed && changed) {
    await alert(stores, "refund.failed", {
      id: order ? order.id : null,
      squareRefundId: refund.id,
      squarePaymentId: refund.payment_id,
      amount: refund.amount_money ? refund.amount_money.amount : 0,
      status: refund.status,
      reason: refund.reason || null,
    }, { env, mail, now });
  }

  if (!order) return { handled: false, reason: "unknown payment" };

  if (known >= 0) {
    // A refund the CLI made is recorded PENDING; Square's word on how
    // it ended is the one change worth noting.
    if (changed) {
      await amendOrder(stores, order.id, (fresh) => moneyPatch(fresh, {
        refunds: refundsOf(fresh).map((r) => (r.squareRefundId === refund.id
          ? { ...r, status: refund.status }
          : r)),
      }), failed ? "refund.failed" : "refund.completed", now);
    }

    return { handled: true, id: order.id, repeat: true };
  }

  // A refund made elsewhere that failed moved no money: the alert is
  // all there is to it.
  if (failed) return { handled: true, id: order.id, failed: true };

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
