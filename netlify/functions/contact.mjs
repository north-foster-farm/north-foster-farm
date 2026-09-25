// POST /api/contact: a message from the contact page, to the farm.
//
//   { name, email, message, orderId?, website? }
//   -> 200 { ok }   422 { errors }   429 { message } too many from one
//      address, with Retry-After   403 cross-site   500 { error }
//
// The message is kept under messages/<id> in the customers store (as
// the account page's help form keeps support/...), then mailed to
// ADMIN_EMAILS with reply-to set to the writer, so answering is a
// plain reply. An order number is checked against the writer's email
// for the farm's benefit only; the writer is never told, so the form
// cannot be used to learn whose an order is. A filled honeypot
// answers 200 so a bot learns nothing; more than five messages from
// one address in ten minutes answer 429, so a person is told.

import { randomBytes } from "node:crypto";

import { normalizeEmail, sameSite, validEmail } from "./lib/auth.mjs";
import { alert, noteMail } from "./lib/health.mjs";
import { json, readJson } from "./lib/http.mjs";
import { log, withLog } from "./lib/log.mjs";
import { adminEmails, sendMail } from "./lib/mail.mjs";
import { getOrder } from "./lib/records.mjs";
import { mailLinks } from "./lib/site.mjs";
import { stores as defaultStores } from "./lib/store.mjs";
import { farmContactMessage } from "./lib/templates.mjs";

export const MESSAGE_PREFIX = "messages/";

// Per-instance, best effort, like the sign-in handler's.
const RATE = { windowMs: 10 * 60_000, max: 5 };
const hits = new Map();

// -> 0, or the seconds until this address may send again.
const rateLimited = (ip, now) => {
  if (!ip) return 0;

  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);

  recent.push(now);
  hits.set(ip, recent);

  return recent.length > RATE.max
    ? Math.max(1, Math.ceil((recent[0] + RATE.windowMs - now) / 1000))
    : 0;
};

const text = (value, max) =>
  (typeof value === "string" ? value.trim().slice(0, max) : "");

// The same words the page uses when it checks the fields itself.
// -> { ok: true, message } or { ok: false, errors }.
export const validate = (body) => {
  const b = body && typeof body === "object" ? body : {};
  const message = {
    name: text(b.name, 120),
    email: normalizeEmail(text(b.email, 254)),
    orderId: text(b.orderId, 40).replace(/^#/, "").toUpperCase(),
    message: text(b.message, 4000),
  };
  const errors = {};

  if (!message.name) errors.name = "Tell us your name.";
  if (!message.email) {
    errors.email = "Enter your email address, so we can answer.";
  } else if (!validEmail(message.email)) {
    errors.email = "Enter a valid email address, like you@example.com.";
  }
  if (!message.message) errors.message = "Write us a message first.";

  return Object.keys(errors).length
    ? { ok: false, errors } : { ok: true, message };
};

// Whether the order number is one this email placed; null when none
// was given.
const ownsOrder = async (stores, { orderId, email }) => {
  if (!orderId) return null;

  const order = await getOrder(stores, orderId).catch(() => null);

  return !!order && normalizeEmail(order.customer.email) === email;
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
  if (body.website) return json(200, { ok: true });

  // Said plainly: a quiet 200 here thanked a real writer for a message
  // that was then dropped.
  const wait = rateLimited(ip, now.getTime());

  if (wait) {
    return json(429, {
      message: "There have been too many messages from here. Wait a few " +
        "minutes and send it again; what you wrote is still here.",
    }, { "Retry-After": String(wait) });
  }

  const result = validate(body);

  if (!result.ok) return json(422, { errors: result.errors });

  const message = result.message;
  const order = await ownsOrder(stores, message);
  const id = randomBytes(6).toString("base64url");
  const record = {
    id, at: now.toISOString(), ...message, order, status: "open",
  };
  const key = `${MESSAGE_PREFIX}${id}`;

  await stores.customers.set(key, record);

  const to = adminEmails(env);

  if (!to.length) {
    log.warn({ event: "contact.unrouted", id });

    return json(200, { ok: true });
  }

  try {
    await mail({
      to,
      replyTo: message.email,
      idempotencyKey: `contact-${id}`,
      ...farmContactMessage(message, { order, links: mailLinks(env) }),
    }, { env, stores });
    await noteMail(stores, true, now);
    log.info({ event: "contact.sent", id });
  } catch (error) {
    const detail = String(error && error.message);

    log.error({
      event: "mail.failed", template: "farmContactMessage", id,
      error: detail,
    });
    await stores.customers.set(key, { ...record, mailed: false });
    await noteMail(stores, false, now, { error: detail });
    await alert(stores, "mail.failed", {
      template: "farmContactMessage", message: id, error: detail,
    }, { env, mail, now });

    return json(500, { error: "We couldn't send that just now." });
  }

  return json(200, { ok: true });
};

export default withLog(async (req, context) =>
  handle(req, { ip: context && context.ip }));

export const config = {
  path: "/api/contact",
  method: "POST",
};
