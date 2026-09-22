// POST /api/square/webhook: Square tells us an invoice changed. The
// signature is checked against SQUARE_WEBHOOK_SIGNATURE_KEY and the
// notification URL Square was given, then the event is applied. A
// missed or duplicate event is harmless: the scheduled poll asks
// Square about every unpaid order, and marking an order paid twice
// is a no-op.
//
// Square retries on anything but a 2xx, so an unknown invoice (an
// order placed before records existed, or a test) answers 200.

import { createHmac, timingSafeEqual } from "node:crypto";

import { mark } from "./lib/health.mjs";
import { json } from "./lib/http.mjs";
import { log, withLog } from "./lib/log.mjs";
import { applyInvoiceEvent } from "./lib/payments.mjs";
import { siteUrl } from "./lib/site.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

export const webhookUrl = (env = process.env) =>
  env.SQUARE_WEBHOOK_URL || `${siteUrl(env)}/api/square/webhook`;

// Square signs base64(HMAC-SHA256(key, notificationUrl + rawBody)).
export const signature = (key, url, body) =>
  createHmac("sha256", key).update(url + body).digest("base64");

export const verified = (env, url, body, header) => {
  const key = env.SQUARE_WEBHOOK_SIGNATURE_KEY;

  if (!key || !header) return false;

  const expected = Buffer.from(signature(key, url, body));
  const given = Buffer.from(String(header));

  return expected.length === given.length && timingSafeEqual(expected, given);
};

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = new Date(),
  mail,
} = {}) => {
  const body = await req.text();
  const header = req.headers.get("x-square-hmacsha256-signature");

  if (!verified(env, webhookUrl(env), body, header)) {
    return json(401, { error: "Bad signature." });
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

  // Any signed event is proof the webhook is alive.
  await mark(stores, "webhook", { type: event.type }, now);

  if (!event.type.startsWith("invoice.")) {
    return json(200, { handled: false, reason: "ignored" });
  }

  const result = await applyInvoiceEvent(stores, event, { env, now, mail });

  log.info({
    event: "square.webhook", type: event.type, ...result,
  });

  return json(200, result);
};

export default withLog(async (req) => handle(req));

export const config = {
  path: "/api/square/webhook",
  method: "POST",
};
