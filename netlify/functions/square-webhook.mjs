// POST /api/square/webhook: Square tells us something changed. The
// signature is checked against SQUARE_WEBHOOK_SIGNATURE_KEY (or, during
// a key swap, SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS) and the
// notification URL Square was given, then the event is applied.
//
// Payments are taken on the page, synchronously, so two kinds of event
// have work behind them: a refund made in the Square dashboard rather
// than the CLI (`refund.updated`), which is noted on the order, and an
// order changed there (`order.updated`, `order.fulfillment.updated`),
// which is compared with the record and flagged to the farm, never
// copied into it (lib/drift.mjs, #293). Every
// signed event is proof the webhook is alive and marks the health
// record. Square retries on anything but a 2xx, so an unknown payment
// (an order placed before records existed, or a test) answers 200. A
// refused delivery is logged and may alert (lib/webhooks.mjs).

import { createHmac, timingSafeEqual } from "node:crypto";

import { applyOrderEvent } from "./lib/drift.mjs";
import { mark } from "./lib/health.mjs";
import { json } from "./lib/http.mjs";
import { log, withLog } from "./lib/log.mjs";
import { applyRefundEvent } from "./lib/payments.mjs";
import { siteUrl } from "./lib/site.mjs";
import { stores as defaultStores } from "./lib/store.mjs";
import { rejected } from "./lib/webhooks.mjs";

const ORDER_EVENTS = ["order.updated", "order.fulfillment.updated"];

export const webhookUrl = (env = process.env) =>
  env.SQUARE_WEBHOOK_URL || `${siteUrl(env)}/api/square/webhook`;

// Square signs base64(HMAC-SHA256(key, notificationUrl + rawBody)).
export const signature = (key, url, body) =>
  createHmac("sha256", key).update(url + body).digest("base64");

// -> null when the delivery is Square's, or why it is refused
// (lib/webhooks.mjs).
export const rejection = (env, url, body, header) => {
  const keys = [
    env.SQUARE_WEBHOOK_SIGNATURE_KEY,
    env.SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS,
  ].filter(Boolean);

  if (!header) return "unsigned";
  if (!keys.length) return "unconfigured";

  const given = Buffer.from(String(header));

  // Either key passes, so a swap leaves no gap: set the new key as
  // the current one, the old as PREVIOUS, then drop PREVIOUS.
  const match = keys.some((key) => {
    const expected = Buffer.from(signature(key, url, body));

    return expected.length === given.length
      && timingSafeEqual(expected, given);
  });

  return match ? null : "mismatch";
};

export const verified = (env, url, body, header) =>
  rejection(env, url, body, header) === null;

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = new Date(),
  mail,
  fetchImpl,
  square,
} = {}) => {
  const body = await req.text();
  const header = req.headers.get("x-square-hmacsha256-signature");
  const reason = rejection(env, webhookUrl(env), body, header);

  if (reason) {
    return rejected(stores, { provider: "square", reason, body }, {
      env, now, mail, fetchImpl,
    });
  }

  let event;

  try {
    event = JSON.parse(body);
  } catch {
    return json(400, { error: "Expected JSON." });
  }

  if (!event || typeof event.type !== "string") {
    return json(400, { error: "Expected a Square event." });
  }

  await mark(stores, "webhook", { type: event.type }, now);

  if (ORDER_EVENTS.includes(event.type)) {
    const result = await applyOrderEvent(stores, event, {
      env, now, mail, fetchImpl, ...(square ? { square } : {}),
    });

    log.info({ event: "square.webhook", type: event.type, ...result });

    return json(200, result);
  }
  if (!event.type.startsWith("refund.")) {
    return json(200, { handled: false, reason: "ignored" });
  }

  const result = await applyRefundEvent(stores, event, { now });

  log.info({ event: "square.webhook", type: event.type, ...result });

  return json(200, result);
};

export default withLog("square-webhook", async (req) =>
  handle(req));

export const config = {
  path: "/api/square/webhook",
  method: "POST",
};
