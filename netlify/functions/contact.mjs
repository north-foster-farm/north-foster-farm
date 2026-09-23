// POST /api/contact: a message from the contact page, to the farm.
//
//   { name, email, message, orderId?, website? }
//   -> 200 { ok }       422 { errors }       403 cross-site
//
// The farm gets one email with the message and the writer's details,
// reply-to set to the writer so answering is a plain reply. Nothing
// is stored: the inbox is the record. A honeypot field and a
// per-address limit blunt the obvious abuse; anything caught answers
// 200 so a script learns nothing.

import { validEmail, normalizeEmail, sameSite } from "./lib/auth.mjs";
import { alert } from "./lib/health.mjs";
import { json, readJson } from "./lib/http.mjs";
import { log, withLog } from "./lib/log.mjs";
import { adminEmails, sendMail } from "./lib/mail.mjs";
import { mailLinks } from "./lib/site.mjs";
import { stores as defaultStores } from "./lib/store.mjs";
import { farmContactMessage } from "./lib/templates.mjs";

const RATE = { windowMs: 10 * 60_000, max: 5 };
const hits = new Map();

const rateLimited = (ip, now) => {
  if (!ip) return false;

  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);

  recent.push(now);
  hits.set(ip, recent);

  return recent.length > RATE.max;
};

const text = (value, max) =>
  (typeof value === "string" ? value.trim().slice(0, max) : "");

// -> { ok: true, message } or { ok: false, errors }.
export const validate = (body) => {
  const b = body && typeof body === "object" ? body : {};
  const message = {
    name: text(b.name, 120),
    email: normalizeEmail(text(b.email, 254)),
    orderId: text(b.orderId, 40).toUpperCase(),
    message: text(b.message, 4000),
  };
  const errors = {};

  if (!message.name) errors.name = "Please tell us your name.";
  if (!validEmail(message.email)) {
    errors.email = "Please enter an email address we can answer to.";
  }
  if (message.orderId && !/^[A-Z0-9-]{6,32}$/.test(message.orderId)) {
    errors.orderId = "That doesn't look like one of our order numbers.";
  }
  if (!message.message) errors.message = "Write us a note first.";

  return Object.keys(errors).length
    ? { ok: false, errors } : { ok: true, message };
};

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = new Date(),
  ip = "",
  mail = sendMail,
} = {}) => {
  if (req.method !== "POST") return json(405, { error: "POST only." });
  if (!sameSite(req)) return json(403, { error: "Cross-site request." });

  const body = await readJson(req);

  if (!body || typeof body !== "object") {
    return json(400, { errors: { body: "Expected a JSON body." } });
  }
  if (body.website || rateLimited(ip, now.getTime())) {
    return json(200, { ok: true });
  }

  const result = validate(body);

  if (!result.ok) return json(422, { errors: result.errors });

  const to = adminEmails(env);

  if (!to.length) {
    log.warn({ event: "contact.unrouted", email: result.message.email });

    return json(200, { ok: true });
  }

  try {
    await mail({
      to,
      replyTo: result.message.email,
      idempotencyKey: `contact-${now.getTime()}`,
      ...farmContactMessage(result.message, {
        at: now, links: mailLinks(env),
      }),
    }, { env });
    log.info({ event: "contact.sent", email: result.message.email });
  } catch (error) {
    log.error({ event: "mail.failed", template: "farmContactMessage",
      error: String(error && error.message) });
    await alert(stores, "mail.failed", {
      template: "farmContactMessage", error: String(error && error.message),
    }, { env, mail, now });

    return json(503, { error: "We couldn't send that just now." });
  }

  return json(200, { ok: true });
};

export default withLog(async (req, context) =>
  handle(req, { ip: context && context.ip }));

export const config = {
  path: "/api/contact",
  method: "POST",
};
