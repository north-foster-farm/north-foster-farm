// POST /api/paypal/webhook: PayPal tells us about a Venmo payment.
// Each delivery is verified with PayPal (PAYPAL_WEBHOOK_ID names the
// subscription) before anything is read from it.
//
//   PAYMENT.CAPTURE.COMPLETED   money arrived. The page's own capture
//                               request records the order, and this
//                               arrives while it is still at work, so
//                               finishing here would race it and write
//                               the order twice. It is only noted: a
//                               checkout the page never finished is
//                               the jobs' (rescueCheckout).
//   PAYMENT.CAPTURE.REFUNDED    a refund made in PayPal rather than
//                               the CLI, noted on the order.
//
// PayPal retries on anything but a 2xx, so an event about a payment
// this site knows nothing of answers 200.

import { mark } from "./lib/health.mjs";
import { json } from "./lib/http.mjs";
import { log, withLog } from "./lib/log.mjs";
import { verifyWebhook } from "./lib/paypal.mjs";
import { recordRefund } from "./lib/payments.mjs";
import { checkoutByPayPal, orderByPayment } from "./lib/records.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

const cents = (amount) => (amount && amount.value
  ? Math.round(Number(amount.value) * 100)
  : 0);

export const applyEvent = async (stores, event, options = {}) => {
  const now = options.now || new Date();
  const resource = event.resource || {};

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const paypalOrderId = resource.supplementary_data
      && resource.supplementary_data.related_ids
      && resource.supplementary_data.related_ids.order_id;

    if (!paypalOrderId) return { handled: false, reason: "no order id" };

    const checkout = await checkoutByPayPal(stores, paypalOrderId);

    if (checkout) {
      return { handled: false, id: checkout.order.id, reason: "pending" };
    }

    const order = await orderByPayment(stores, resource.id);

    return order
      ? { handled: true, id: order.id, repeat: true }
      : { handled: false, reason: "unknown checkout" };
  }

  if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
    const captureId = resource.id;
    const order = captureId ? await orderByPayment(stores, captureId) : null;

    if (!order) return { handled: false, reason: "unknown capture" };

    const refundId = (resource.refund && resource.refund.id) || null;

    if (order.refund && refundId && order.refund.paypalRefundId === refundId) {
      return { handled: true, id: order.id, repeat: true };
    }

    await recordRefund(stores, order, {
      amount: cents(resource.amount) || order.totals.total,
      paypalRefundId: refundId,
      status: "COMPLETED",
    }, "paypal", now);

    return { handled: true, id: order.id };
  }

  return { handled: false, reason: "ignored" };
};

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = new Date(),
  verify = verifyWebhook,
  fetchImpl,
  ...options
} = {}) => {
  const body = await req.text();

  if (!await verify(req.headers, body, { env, fetchImpl, now })) {
    return json(401, { error: "Bad signature." });
  }

  let event;

  try {
    event = JSON.parse(body);
  } catch {
    return json(400, { error: "Expected JSON." });
  }

  if (!event || typeof event.event_type !== "string") {
    return json(400, { error: "Expected a PayPal event." });
  }

  await mark(stores, "webhook", { type: event.event_type }, now);

  const result = await applyEvent(stores, event, {
    ...options, env, fetchImpl, now,
  });

  log.info({ event: "paypal.webhook", type: event.event_type, ...result });

  return json(200, result);
};

export default withLog(async (req) => handle(req));

export const config = {
  path: "/api/paypal/webhook",
  method: "POST",
};
