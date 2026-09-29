// POST /api/resend/webhook: Resend tells us a contact changed (#234).
// Each delivery is signed by Svix with RESEND_WEBHOOK_SECRET and
// checked against the raw body before anything is read from it.
//
//   contact.updated   with unsubscribed true: they left through
//                     Resend's link, so the record is opted out at
//                     once, not at the next daily sync.
//   contact.deleted   off the audience, so off the list here too;
//                     left alone, the sync would add them back.
//
// One Resend account serves every environment, so each receives every
// contact event; one outside this deploy's RESEND_AUDIENCE_ID is
// ignored. Resend retries on anything but a 2xx, so an ignored event
// answers 200.

import { createHmac, timingSafeEqual } from "node:crypto";

import { mark } from "./lib/health.mjs";
import { json } from "./lib/http.mjs";
import { log, withLog } from "./lib/log.mjs";
import { resendLeft } from "./lib/news.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

// Svix's own tolerance for a delivery's timestamp, either way.
export const TOLERANCE = 5 * 60 * 1000;

// The Svix signature: HMAC-SHA256 of "<id>.<timestamp>.<body>" under
// the secret's base64 key, one or more "v1,<base64>" in the header.
// -> true when one matches and the timestamp is fresh.
export const verifyWebhook = (headers, body, {
  env = process.env, now = new Date(),
} = {}) => {
  const secret = env.RESEND_WEBHOOK_SECRET || "";
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");

  if (!secret || !id || !timestamp || !signatures) return false;

  const seconds = Number(timestamp);

  if (!Number.isFinite(seconds)
    || Math.abs(now.getTime() - seconds * 1000) > TOLERANCE) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`).digest();

  return signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    const given = Buffer.from(signature || "", "base64");

    return version === "v1" && given.length === expected.length
      && timingSafeEqual(given, expected);
  });
};

const inAudience = (contact, env) => {
  const id = env.RESEND_AUDIENCE_ID;

  const segments = Array.isArray(contact.segment_ids)
    ? contact.segment_ids : [];

  return !!id && (contact.audience_id === id || segments.includes(id));
};

export const applyEvent = async (stores, event, {
  env = process.env, now = new Date(),
} = {}) => {
  const contact = event.data || {};

  if (!inAudience(contact, env)) {
    return { handled: false, reason: "other audience" };
  }

  const left = event.type === "contact.deleted"
    || (event.type === "contact.updated" && contact.unsubscribed === true);

  if (!left) return { handled: false, reason: "ignored" };

  const at = contact.updated_at || event.created_at || now.toISOString();
  const record = await resendLeft(stores, contact.email, at, now);

  if (!record) return { handled: false, reason: "unknown contact" };

  return { handled: true, optedOut: record.marketing !== true };
};

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = new Date(),
  verify = verifyWebhook,
} = {}) => {
  const body = await req.text();

  if (!verify(req.headers, body, { env, now })) {
    return json(401, { error: "Bad signature." });
  }

  let event;

  try {
    event = JSON.parse(body);
  } catch {
    return json(400, { error: "Expected JSON." });
  }

  if (!event || typeof event.type !== "string") {
    return json(400, { error: "Expected a Resend event." });
  }

  await mark(stores, "webhook", { type: event.type }, now);

  const result = await applyEvent(stores, event, { env, now });

  log.info({ event: "resend.webhook", type: event.type, ...result });

  return json(200, result);
};

export default withLog(async (req) => handle(req));

export const config = {
  path: "/api/resend/webhook",
  method: "POST",
};
