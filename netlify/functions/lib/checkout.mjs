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
import * as paypalApi from "./paypal.mjs";
import { announcePaid } from "./payments.mjs";
import {
  amendOrder, deleteCheckout, getCheckout, getOrder, saveCheckout,
  saveOrder, touchCustomer,
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

// The record, written once the money is in. A second write of the
// same order (a retried request whose payment Square deduplicated)
// finds the first and leaves it.
export const completeOrder = async (stores, order, { square, payment }, {
  mail = sendMail,
  env = process.env,
  now = new Date(),
} = {}) => {
  const existing = await getOrder(stores, order.id);

  if (existing && existing.status === "paid") return existing;

  const at = now.toISOString();
  const saved = await saveOrder(stores, {
    ...order,
    status: "paid",
    paidAt: at,
    square,
    payment: { at, ...payment },
  }, now);

  await touchCustomer(stores, order.customer, now);
  await adjust(stores, order.lines, -1);
  await mark(stores, "order", { id: order.id }, now);

  log.info({
    event: "order.paid", order: saved, persistent: stores.persistent,
  });

  return announcePaid(stores, order.id, { mail, env, now }) || saved;
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
  const created = await retry(
    () => square.createOrder(order, k, { env, fetchImpl }), { sleep }
  );
  let paid;

  try {
    paid = await retry(() => square.createPayment({
      order,
      squareOrderId: created.squareOrderId,
      customerId: created.customerId,
      key: k,
      source: { sourceId, verificationToken },
    }, { env, fetchImpl }), { sleep });
  } catch (error) {
    // A declined card leaves an open order behind in Square; close it
    // so the dashboard does not show an order nobody paid for.
    if (error && error.declined) {
      try {
        await square.cancelOrder(created.squareOrderId, { env, fetchImpl });
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

// The first half of a Venmo payment: the PayPal order the button will
// pay, and the validated order kept until the money arrives.
// -> { paypalOrderId }
export const startVenmo = async (stores, order, { key, attempt = 1 }, {
  paypal = paypalApi,
  sleep,
  ...options
} = {}) => {
  const k = attemptKey(key, attempt);
  const env = options.env || process.env;
  const now = options.now || new Date();
  const fetchImpl = options.fetchImpl;
  const { paypalOrderId } = await retry(
    () => paypal.createOrder(order, k, { env, fetchImpl, now }), { sleep }
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
  const checkout = await getCheckout(stores, key);
  const env = options.env || process.env;
  const now = options.now || new Date();
  const fetchImpl = options.fetchImpl;

  if (!checkout || checkout.paypalOrderId !== paypalOrderId) {
    throw new CheckoutError("That payment doesn't match this order. " +
      "Start again.", { code: "checkout.unknown" });
  }
  if (checkout.order.totals.total !== order.totals.total) {
    throw new CheckoutError("The order changed after the Venmo payment " +
      "started. Start the payment again.", { code: "checkout.changed" });
  }

  const k = attemptKey(key, checkout.attempt || attempt);
  const capture = await retry(
    () => paypal.captureOrder(paypalOrderId, k, { env, fetchImpl, now }),
    { sleep }
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

  const squareCopy = await recordOnSquare(stores, order, k, capture, {
    square, env, fetchImpl, mail, now, sleep,
  });
  const saved = await completeOrder(stores, order, {
    square: squareCopy.square,
    payment: {
      via: "venmo",
      method: "venmo",
      squarePaymentId: squareCopy.squarePaymentId,
      receiptUrl: null,
      paypalOrderId,
      paypalCaptureId: capture.paypalCaptureId,
      payer: capture.payer,
    },
  }, { mail, env, now });

  await deleteCheckout(stores, key);

  return saved;
};

// The Square order and the external tender for money that came
// through Venmo. -> { square, squarePaymentId }, both null when
// Square could not be reached; then the farm is alerted and
// `squareSync` in the jobs tries again.
export const recordOnSquare = async (stores, order, k, capture, {
  square = squareApi, env = process.env, fetchImpl, mail = sendMail,
  now = new Date(), sleep,
} = {}) => {
  try {
    const created = await retry(
      () => square.createOrder(order, k, { env, fetchImpl }), { sleep }
    );
    const paid = await retry(() => square.createPayment({
      order,
      squareOrderId: created.squareOrderId,
      customerId: created.customerId,
      key: k,
      source: {
        external: { source: "Venmo", sourceId: capture.paypalCaptureId },
      },
    }, { env, fetchImpl }), { sleep });

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

// For the jobs: a Venmo order whose Square copy failed gets another
// try. -> the record, updated or not.
export const syncSquare = async (stores, order, {
  square = squareApi, env = process.env, fetchImpl, mail = sendMail,
  now = new Date(), sleep,
} = {}) => {
  const p = order.payment || {};

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
    payment: { ...p, squarePaymentId: copy.squarePaymentId },
  }, "square.recorded", now);
};

export class CheckoutError extends Error {
  constructor(message, { code = "checkout" } = {}) {
    super(message);
    this.name = "CheckoutError";
    this.code = code;
  }
}
