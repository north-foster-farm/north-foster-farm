// Taking the money. An order is created and paid in one visit: until
// the payment succeeds it is a draft on the customer's page, not a
// record. This file turns a validated order and a payment source into
// a paid record, by either road:
//
//   Square   the SDK tokenised a card or a wallet on the page; the
//            Square order is made, the payment is taken against it,
//            and the record is written. One request.
//   Venmo    PayPal's button. The first request validates the order,
//            keeps it as a checkout and creates the PayPal order the
//            button will pay; the customer approves it in the Venmo
//            app; the second request captures the money, records it
//            on a Square order as an external tender, and writes the
//            record. A webhook can do the second half if the browser
//            never came back.
//
// Every processor call carries an idempotency key from the
// submission's key and attempt (`attemptKey`), so a retried request
// finds what the first one made. A new attempt, after a decline, is
// a new set of keys.

import { createHash } from "node:crypto";

import { retry } from "./http.mjs";
import { alert, mark } from "./health.mjs";
import { log } from "./log.mjs";
import { sendMail } from "./mail.mjs";
import { joined, welcome } from "./news.mjs";
import * as paypalApi from "./paypal.mjs";
import { announcePaid } from "./payments.mjs";
import { pickupSchedule } from "./pickups.mjs";
import {
  amendOrder, belongsTo, checkoutsFor, deleteCheckout, getCheckout,
  getCustomer, getOrder, moneyPatch, paymentsOf, saveCheckout, saveOrder,
  touchCustomer,
} from "./records.mjs";
import * as squareApi from "./square.mjs";
import { adjust } from "./stock.mjs";

// Square wants an idempotency key of 45 characters at most, and ours
// carry a suffix per step, so the submission key and the attempt are
// folded into 32 hex characters first.
export const attemptKey = (key, attempt) =>
  createHash("sha256").update(`${key}:${attempt}`).digest("hex").slice(0, 32);

// The payment methods the page can send, and how each is recorded.
export const METHODS = {
  card: { via: "square" },
  applepay: { via: "square" },
  googlepay: { via: "square" },
  cashapp: { via: "square" },
  venmo: { via: "venmo" },
};

const SQUARE_KEYS = ["squareOrderId", "customerId"];

const squareRecord = (created) =>
  Object.fromEntries(SQUARE_KEYS.map((k) => [k, created[k] || null]));

// A record found under this submission's id must be this
// submission's. One that is not is another customer's order: it is
// never answered with, and the farm hears at once (#253). Reserving
// the id first (reserveOrderId) means this should never fire.
// -> the record. throws OrderCollisionError.
export const ownRecord = async (stores, record, key, {
  stage, payment, mail = sendMail, env = process.env, now = new Date(),
} = {}) => {
  if (belongsTo(record, key)) return record;

  const detail = {
    id: record && record.id, stage,
    squarePaymentId: (payment && payment.squarePaymentId) || null,
    paypalCaptureId: (payment && payment.paypalCaptureId) || null,
  };

  log.error({ event: "order.id_collision", ...detail });
  await alert(stores, "order.id_collision", detail, { env, mail, now });

  throw new OrderCollisionError(detail);
};

// The record, written once the money is in. A second write of the
// same order (a retried request whose payment Square deduplicated)
// finds the first and leaves it.
export const completeOrder = async (stores, order, { square, payment }, {
  mail = sendMail,
  env = process.env,
  now = new Date(),
} = {}) => {
  const existing = await getOrder(stores, order.id);

  if (existing) {
    return ownRecord(stores, existing, order.meta && order.meta.idempotencyKey,
      { stage: "recording", payment, mail, env, now });
  }

  const at = now.toISOString();
  const saved = await saveOrder(stores, {
    ...order,
    status: "paid",
    paidAt: at,
    square,
    payments: [{ at, amount: order.totals.total, ...payment }],
    refunds: [],
  }, now);

  // The money is in and the record is written. Whatever fails from
  // here is the farm's to finish (the alert says what), never a
  // failure card for a customer who has just paid.
  try {
    const before = await getCustomer(stores, order.customer.email);
    const customer = await touchCustomer(stores, order.customer, now);

    await adjust(stores, order.lines, -1);
    await mark(stores, "order", { id: order.id }, now);

    log.info({
      event: "order.paid", id: saved.id, persistent: stores.persistent,
    });

    const announced = await announcePaid(stores, order.id, {
      mail, env, now,
    });

    // The order box joins farm news once the order is placed (T7), and
    // the welcome follows the confirmation (T6).
    if (joined(before, customer)) {
      await welcome(stores, customer, { env, mail, now });
    }

    return announced || saved;
  } catch (error) {
    const detail = { id: saved.id, error: String(error && error.message) };

    log.error({ event: "order.after_paid_failed", ...detail });
    await alert(stores, "order.after_paid_failed", detail, {
      env, mail, now,
    });

    return saved;
  }
};

// A card or a wallet, tokenised by the SDK. -> the paid record.
// throws SquareError { declined, code } or { retryable }.
export const payWithSquare = async (stores, order, {
  key, attempt = 1, method, sourceId, verificationToken,
}, {
  square = squareApi,
  sleep,
  ...options
} = {}) => {
  const k = attemptKey(key, attempt);
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl;
  const { deadline } = options;
  const until = deadline || 0;

  // A later attempt has fresh keys, so Square would not know that an
  // earlier one took the money. It is asked first.
  if (attempt > 1) {
    const found = await retry(() => square.findPaid(order, {
      env, fetchImpl, deadline, now: options.now,
    }), { sleep, until });

    if (found) return recordFound(stores, order, found, method, options);
  }

  const created = await retry(
    () => square.createOrder(order, k, { env, fetchImpl, deadline }),
    { sleep, until }
  );
  let paid;

  try {
    paid = await retry(() => square.createPayment({
      order,
      squareOrderId: created.squareOrderId,
      customerId: created.customerId,
      key: k,
      source: { sourceId, verificationToken },
    }, { env, fetchImpl, deadline }), { sleep, until });
  } catch (error) {
    // A declined card leaves an open order behind in Square; close it
    // so the dashboard does not show an order nobody paid for.
    if (error && error.declined) {
      try {
        await square.cancelOrder(created.squareOrderId, {
          env, fetchImpl, deadline,
        });
      } catch (cancelError) {
        log.warn({
          event: "square.cancel_failed", id: order.id,
          squareOrderId: created.squareOrderId,
          error: String(cancelError && cancelError.message),
        });
      }
    }
    throw error;
  }

  return completeOrder(stores, order, {
    square: squareRecord(created),
    payment: {
      via: "square",
      method: METHODS[method] ? method : "card",
      squarePaymentId: paid.squarePaymentId,
      receiptUrl: paid.receiptUrl,
      brand: paid.brand,
      last4: paid.last4,
      wallet: paid.wallet,
    },
  }, options);
};

// Square holds a payment for this order id that no record answers for:
// an earlier attempt took the money and its answer was lost. The order
// is recorded from it and not charged again. A payment that is not
// what this order now asks (another amount, because the cart changed
// between tries; or money that came through Venmo) is left for the
// farm, and still not charged again. -> the paid record.
// throws CheckoutError { code: "payment.unreconciled" }.
const recordFound = async (stores, order, found, method, options) => {
  const env = options.env || process.env;
  const now = options.now || new Date();
  const mail = options.mail || sendMail;
  const detail = {
    id: order.id, squarePaymentId: found.squarePaymentId,
    squareOrderId: found.squareOrderId, paid: found.amount,
    total: order.totals.total,
  };

  if (found.external || found.amount !== order.totals.total) {
    log.error({ event: "payment.unreconciled", ...detail });
    await alert(stores, "payment.unreconciled", {
      ...detail,
      why: found.external
        ? "Square holds a payment for this order that came through Venmo"
        : "Square holds a payment for this order id for another amount " +
          "than the order now totals",
    }, { env, mail, now });

    throw new CheckoutError("We found a payment for this order already, " +
      "and we will sort it out with you by email. Please do not pay " +
      "again.", { code: "payment.unreconciled" });
  }

  log.warn({ event: "payment.reconciled", ...detail });

  return completeOrder(stores, order, {
    square: squareRecord(found),
    payment: {
      via: "square",
      method: METHODS[method] ? method : "card",
      squarePaymentId: found.squarePaymentId,
      receiptUrl: found.receiptUrl,
      brand: found.brand,
      last4: found.last4,
      wallet: found.wallet,
    },
  }, options);
};

// The first half of a Venmo payment: the PayPal order the button will
// pay, and the validated order kept until the money arrives. A later
// attempt first asks PayPal about the attempts before it: one the
// customer paid, whose answer was lost, is recorded instead of paid
// for again.
// -> { paypalOrderId }, or { paid } with the record of that payment.
export const startVenmo = async (stores, order, { key, attempt = 1 }, {
  paypal = paypalApi,
  sleep,
  ...options
} = {}) => {
  const k = attemptKey(key, attempt);
  const env = options.env || process.env;
  const now = options.now || new Date();
  const fetchImpl = options.fetchImpl;
  const { deadline } = options;

  if (attempt > 1) {
    for (const prior of await checkoutsFor(stores, key)) {
      if (prior.edit || !prior.paypalOrderId) continue;

      let seen;

      try {
        seen = await retry(() => paypal.getOrder(prior.paypalOrderId, {
          env, fetchImpl, now, deadline,
        }), { sleep, until: deadline || 0 });
      } catch (error) {
        // PayPal forgets an order nobody approved: nothing was paid.
        if (error && error.status === 404) continue;
        throw error;
      }

      if (seen.status === "COMPLETED") {
        log.warn({
          event: "payment.reconciled", id: prior.order.id,
          paypalOrderId: prior.paypalOrderId,
        });

        return {
          paid: await finishVenmo(stores, prior.order, {
            key, attempt: prior.attempt, paypalOrderId: prior.paypalOrderId,
          }, { paypal, sleep, ...options }),
        };
      }
    }
  }

  const { paypalOrderId } = await retry(
    () => paypal.createOrder(order, k, { env, fetchImpl, now, deadline }),
    { sleep, until: deadline || 0 }
  );

  await saveCheckout(stores, {
    key, attempt, at: now.toISOString(), order, paypalOrderId,
  });

  return { paypalOrderId };
};

// The second half: capture the approved payment, record it on a
// Square order as an external tender, write the record. `order` is
// the order as validated now; it must be the one the checkout kept.
// A Square failure after the capture never loses the order: the
// record is written without its Square copy and the farm is told,
// and the jobs try the Square copy again.
// -> the paid record.
// throws PayPalError { declined, code } or { retryable }; a
// CheckoutError when the checkout and the order disagree.
export const finishVenmo = async (stores, order, {
  key, attempt = 1, paypalOrderId,
}, {
  paypal = paypalApi,
  square = squareApi,
  mail = sendMail,
  sleep,
  ...options
} = {}) => {
  const env = options.env || process.env;
  const now = options.now || new Date();
  const fetchImpl = options.fetchImpl;
  // Finished already, by this request's lost first try or by the
  // jobs: the checkout is gone, and the record is the answer.
  const existing = await getOrder(stores, order.id);

  if (paymentsOf(existing).some((x) => x.paypalOrderId === paypalOrderId)) {
    return ownRecord(stores, existing, key, {
      stage: "venmo", mail, env, now,
    });
  }

  // The latest attempt's, or the earlier one that made this payment.
  const checkout = await getCheckout(stores, key, paypalOrderId);

  if (!checkout || checkout.paypalOrderId !== paypalOrderId) {
    throw new CheckoutError("That payment doesn't match this order. " +
      "Start again.", { code: "checkout.unknown" });
  }
  if (checkout.order.totals.total !== order.totals.total) {
    throw new CheckoutError("The order changed after the Venmo payment " +
      "started. Start the payment again.", { code: "checkout.changed" });
  }
  // The id is the one PayPal was given when the payment started, which
  // the first request reserved.
  order = { ...order, id: checkout.order.id };

  const k = attemptKey(key, checkout.attempt || attempt);
  const { deadline } = options;
  const capture = await retry(
    () => paypal.captureOrder(paypalOrderId, k, {
      env, fetchImpl, now, deadline,
    }),
    { sleep, until: deadline || 0 }
  );

  if (capture.amount !== null && capture.amount !== order.totals.total) {
    // Money moved, and not the right amount. Keep the order (the
    // farm sorts it out) but say so loudly.
    log.error({
      event: "venmo.amount_mismatch", id: order.id, paypalOrderId,
      captured: capture.amount, total: order.totals.total,
    });
    await alert(stores, "venmo.amount_mismatch", {
      id: order.id, paypalOrderId, captured: capture.amount,
      total: order.totals.total,
    }, { env, mail, now });
  }

  // What PayPal says moved is what the record and Square's copy carry,
  // so a mismatch is visible in every refund that follows.
  const amount = capture.amount === null ? order.totals.total : capture.amount;
  const squareCopy = await recordOnSquare(stores, order, k, capture, {
    square, env, fetchImpl, mail, now, sleep, amount, deadline,
  });
  const saved = await completeOrder(stores, order, {
    square: squareCopy.square,
    payment: {
      via: "venmo",
      method: "venmo",
      amount,
      squarePaymentId: squareCopy.squarePaymentId,
      receiptUrl: null,
      paypalOrderId,
      paypalCaptureId: capture.paypalCaptureId,
      payer: capture.payer,
    },
  }, { mail, env, now });

  await deleteCheckout(stores, key, paypalOrderId);

  return saved;
};

// The Square order and the external tender for money that came
// through Venmo. -> { square, squarePaymentId }, both null when
// Square could not be reached; then the farm is alerted and
// `squareSync` in the jobs tries again.
export const recordOnSquare = async (stores, order, k, capture, {
  square = squareApi, env = process.env, fetchImpl, mail = sendMail,
  now = new Date(), sleep, amount = order.totals.total, deadline,
} = {}) => {
  const until = deadline || 0;

  try {
    const created = await retry(
      () => square.createOrder(order, k, { env, fetchImpl, deadline }),
      { sleep, until }
    );
    const paid = await retry(() => square.createPayment({
      order,
      squareOrderId: created.squareOrderId,
      customerId: created.customerId,
      key: k,
      amount,
      source: {
        external: { source: "Venmo", sourceId: capture.paypalCaptureId },
      },
    }, { env, fetchImpl, deadline }), { sleep, until });

    return {
      square: squareRecord(created), squarePaymentId: paid.squarePaymentId,
    };
  } catch (error) {
    log.error({
      event: "square.record_failed", id: order.id,
      error: String(error && error.message), detail: error && error.detail,
    });
    await alert(stores, "square.record_failed", {
      id: order.id, error: String(error && error.message),
    }, { env, mail, now });

    return { square: null, squarePaymentId: null };
  }
};

// For the jobs: a Venmo checkout the page never finished, because the
// tab closed after the customer approved. PayPal is asked about each
// one it has left alone for PAGE_GRACE, so a page still at work is
// never raced: an approved payment is captured and recorded, a
// captured one recorded, and the customer's confirmation goes out
// late. Anything else is left for the sweep. -> the record, or null.
export const PAGE_GRACE = 10 * 60_000;

export const rescueCheckout = async (stores, checkout, {
  paypal = paypalApi,
  ...options
} = {}) => {
  const env = options.env || process.env;
  const now = options.now || new Date();

  if (!checkout.paypalOrderId) return null;
  // Approved no earlier than it was made, so a young checkout's
  // payment is younger still: no need to ask.
  if (now.getTime() - Date.parse(checkout.at) < PAGE_GRACE) return null;

  let current;

  try {
    current = await paypal.getOrder(checkout.paypalOrderId, {
      env, fetchImpl: options.fetchImpl, now,
    });
  } catch (error) {
    // PayPal forgets an order nobody approved within hours: nothing
    // was paid, and the sweep drops the checkout.
    if (error && error.status === 404) return null;
    throw error;
  }

  const since = Date.parse(current.updatedAt || checkout.at);

  if (!["APPROVED", "COMPLETED"].includes(current.status)) return null;
  if (now.getTime() - since < PAGE_GRACE) return null;

  // A new attempt was paid another way, and this payment was never
  // captured: it is dropped by the sweep, and never captured now. One
  // PayPal did capture is a second payment for the order, and the farm
  // is told to refund it.
  const recorded = checkout.edit
    ? null : await getOrder(stores, checkout.order.id);

  if (recorded && !paymentsOf(recorded)
    .some((p) => p.paypalOrderId === checkout.paypalOrderId)) {
    if (current.status === "COMPLETED") {
      log.error({
        event: "payment.unreconciled", id: recorded.id,
        paypalOrderId: checkout.paypalOrderId, why: "second payment",
      });
      await alert(stores, "payment.unreconciled", {
        id: recorded.id, paypalOrderId: checkout.paypalOrderId,
        why: "PayPal captured a payment for an order that was already " +
          "recorded as paid another way",
      }, { env, mail: options.mail || sendMail, now });
    }

    return null;
  }

  // A change to a paid order (lib/edit.mjs) finishes as a change; the
  // jobs hand in its finish, since edit.mjs builds on this file.
  const { finishEdit, ...rest } = options;
  const saved = checkout.edit
    ? await finishEdit(stores, {
      id: checkout.edit.id, key: checkout.key, attempt: checkout.attempt,
      paypalOrderId: checkout.paypalOrderId,
    }, { paypal, ...rest })
    : await finishVenmo(stores, checkout.order, {
      key: checkout.key, attempt: checkout.attempt,
      paypalOrderId: checkout.paypalOrderId,
    }, { paypal, ...rest });

  log.warn({ event: "venmo.rescued", id: saved.id, status: current.status });

  // The customer approved while the page was open, but the farm may
  // have dropped the pickup time since (W11d). The money is in, so the
  // order stands; the farm hears, to give the time up or keep it.
  const f = saved.fulfilment || {};
  const lapsed = f.method === "onfarm" && !pickupSchedule(env).some((w) =>
    w.date === f.date && w.id === (f.onfarm || {}).window);

  if (lapsed) {
    await alert(stores, "pickup.lapsed", {
      id: saved.id, date: f.date, window: (f.onfarm || {}).window,
    }, { env, mail: options.mail || sendMail, now });
  }

  return saved;
};

// For the jobs: a Venmo order whose Square copy failed gets another
// try. -> the record, updated or not.
export const syncSquare = async (stores, order, {
  square = squareApi, env = process.env, fetchImpl, mail = sendMail,
  now = new Date(), sleep,
} = {}) => {
  const payments = paymentsOf(order);
  const p = payments[0] || {};

  if (order.square || p.via !== "venmo" || !p.paypalCaptureId) return order;

  const key = order.meta && order.meta.idempotencyKey;

  if (!key) return order;

  const k = attemptKey(key, order.meta.attempt || 1);
  const copy = await recordOnSquare(stores, order, k, {
    paypalCaptureId: p.paypalCaptureId,
  }, { square, env, fetchImpl, mail, now, sleep });

  if (!copy.square) return order;

  return amendOrder(stores, order.id, {
    square: copy.square,
    ...moneyPatch(order, {
      payments: [
        { ...p, squarePaymentId: copy.squarePaymentId }, ...payments.slice(1),
      ],
    }),
  }, "square.recorded", now);
};

// A record that is not this submission's turned up where its own
// should be. Money may have moved; the farm has been alerted.
export class OrderCollisionError extends Error {
  constructor(detail = {}) {
    super(`Order ${detail.id} belongs to another submission.`);
    this.name = "OrderCollisionError";
    this.code = "order.id_collision";
    this.detail = detail;
  }
}

export class CheckoutError extends Error {
  constructor(message, { code = "checkout" } = {}) {
    super(message);
    this.name = "CheckoutError";
    this.code = code;
  }
}
