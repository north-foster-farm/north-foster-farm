// Magic-link sign-in and sessions. A customer types their email, we
// mail a single-use link, and following it sets a session cookie.
// There is no password anywhere. The CLI mints links and sessions the
// same way to sign in as a customer.
//
// Store layout (the `auth` store):
//   token/<sha256(token)>   { email, expires, next }   one use, 15 min
//   session/<id>            { email, createdAt, expires, via }
//   rate/<email>            { times: [...] }             link requests

import { createHash, randomBytes } from "node:crypto";

import { sendMail } from "./mail.mjs";
import {
  getCustomer, getOrder, reminderPrefs, saveCustomer,
} from "./records.mjs";
import { mailLinks, orderPathFor, siteUrl } from "./site.mjs";
import { magicLink } from "./templates.mjs";

const MINUTE = 60_000;

export const LINK_TTL = 15 * MINUTE;
// A link the farm puts in an email the customer may not open for
// days, such as "Pick a new time" after a denied pickup window.
export const LONG_LINK_TTL = 7 * 24 * 60 * MINUTE;
export const SESSION_TTL = 30 * 24 * 60 * MINUTE;
export const LINKS_PER_WINDOW = 3;
export const LINK_WINDOW = 15 * MINUTE;
export const COOKIE = "nff_session";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const normalizeEmail = (email) =>
  String(email || "").trim().toLowerCase();

export const validEmail = (email) => EMAIL.test(normalizeEmail(email));

const hash = (value) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

// Only a same-site path may follow a sign-in, never another site.
export const safeNext = (next) => {
  const s = String(next || "");

  return s.startsWith("/") && !s.startsWith("//") && !s.includes("\\")
    ? s
    : "/account/";
};

// Ensures a customer record exists for an email that signed in.
export const ensureCustomer = async (stores, email, now) => {
  const existing = await getCustomer(stores, email);

  if (existing) return existing;

  return saveCustomer(stores, {
    email,
    name: "",
    phone: "",
    avatar: null,
    discountGroup: null,
    address: null,
    createdAt: now.toISOString(),
    lastOrderAt: null,
  });
};

// -> { ok: true, url } after mailing, or { ok: false, reason }. The
// URL is returned for the CLI; the API never shows it to the browser.
// The rate limit is for the public request form; a link the farm
// mints itself (`limit: false`) counts against nobody and may live
// longer (`ttl`).
export const requestLink = async (stores, { email, next }, {
  now = new Date(),
  env = process.env,
  mail = sendMail,
  send = true,
  limit = true,
  ttl = LINK_TTL,
} = {}) => {
  const address = normalizeEmail(email);

  if (!validEmail(address)) return { ok: false, reason: "invalid" };

  if (limit) {
    const rateKey = `rate/${address}`;
    const rate = (await stores.auth.get(rateKey)) || { times: [] };
    const recent = rate.times.filter((t) => now.getTime() - t < LINK_WINDOW);

    if (recent.length >= LINKS_PER_WINDOW) {
      return { ok: false, reason: "rate" };
    }
    await stores.auth.set(rateKey, { times: [...recent, now.getTime()] });
  }

  const token = secret();

  await stores.auth.set(`token/${hash(token)}`, {
    email: address,
    next: safeNext(next),
    expires: now.getTime() + ttl,
    createdAt: now.toISOString(),
  });

  const url = `${siteUrl(env)}/api/auth/verify?token=${token}`;

  if (send) {
    await mail({
      to: address,
      idempotencyKey: `link-${hash(token).slice(0, 16)}`,
      ...magicLink(address, url, {
        minutes: ttl / MINUTE, links: mailLinks(env),
      }),
    }, { env });
  }

  return { ok: true, url, email: address };
};

// "Find my order": an order number and the email it was placed with.
// A match mails a sign-in link straight to that order's page. No
// match mails nothing, and the caller answers the same either way.
// The usual rate limit applies to the address.
// -> { ok: true, matched } or { ok: false, reason }.
export const requestOrderLink = async (stores, { email, orderId }, {
  now = new Date(),
  env = process.env,
  mail = sendMail,
} = {}) => {
  const address = normalizeEmail(email);

  if (!validEmail(address)) return { ok: false, reason: "invalid" };

  const id = String(orderId || "").trim().toUpperCase();
  const order = /^[A-Z0-9-]{1,32}$/.test(id)
    ? await getOrder(stores, id)
    : null;

  if (!order || normalizeEmail(order.customer.email) !== address) {
    return { ok: true, matched: false };
  }

  const link = await requestLink(stores, {
    email: address, next: orderPathFor(id),
  }, { now, env, send: false });

  if (!link.ok) return link;

  await mail({
    to: address,
    idempotencyKey: `link-${hash(link.url).slice(0, 16)}`,
    ...magicLink(address, link.url, {
      minutes: LINK_TTL / MINUTE, links: mailLinks(env),
    }),
  }, { env });

  return { ok: true, matched: true, sent: "link" };
};

// Consumes a token. -> { ok: true, email, next } or { ok: false, reason }.
export const verifyToken = async (stores, token, { now = new Date() } = {}) => {
  if (!token || typeof token !== "string" || token.length > 200) {
    return { ok: false, reason: "invalid" };
  }

  const key = `token/${hash(token)}`;
  const found = await stores.auth.get(key);

  if (!found) return { ok: false, reason: "unknown" };

  await stores.auth.delete(key);

  if (now.getTime() > found.expires) return { ok: false, reason: "expired" };

  return { ok: true, email: found.email, next: found.next || "/account/" };
};

export const createSession = async (stores, email, {
  now = new Date(),
  via = "link",
  userAgent = "",
} = {}) => {
  const id = secret();
  const address = normalizeEmail(email);

  await ensureCustomer(stores, address, now);
  await stores.auth.set(`session/${id}`, {
    email: address,
    createdAt: now.toISOString(),
    expires: now.getTime() + SESSION_TTL,
    via,
    userAgent: String(userAgent || "").slice(0, 200),
  });

  return { id, email: address };
};

export const cookieHeader = (id, { maxAge = SESSION_TTL / 1000 } = {}) =>
  `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; ` +
  `Max-Age=${maxAge}`;

export const clearCookieHeader = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export const cookieFrom = (req) => {
  const raw = req.headers.get("cookie") || "";
  const match = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));

  return match ? match[1] : null;
};

// -> { id, email, customer } for a live session on the request, else null.
export const sessionFrom = async (stores, req, { now = new Date() } = {}) => {
  const id = cookieFrom(req);

  if (!id || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) return null;

  const session = await stores.auth.get(`session/${id}`);

  if (!session) return null;
  if (now.getTime() > session.expires) {
    await stores.auth.delete(`session/${id}`);

    return null;
  }

  const customer = await ensureCustomer(stores, session.email, now);

  return { id, email: session.email, customer, via: session.via };
};

export const endSession = async (stores, id) => {
  if (id) await stores.auth.delete(`session/${id}`);
};

// A state-changing request with a session must come from this site.
// Fetch sends Sec-Fetch-Site; older browsers send Origin.
export const sameSite = (req) => {
  const fetchSite = req.headers.get("sec-fetch-site");

  if (fetchSite) {
    return ["same-origin", "same-site", "none"].includes(fetchSite);
  }

  const origin = req.headers.get("origin");

  if (!origin) return true;

  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
};

// The public shape of a customer, for /api/me and the account pages.
// Records from before the name split carry only `name`; derive the
// parts so the order form can prefill both fields.
const nameParts = (customer) => {
  if (customer.firstName || customer.lastName) {
    return [customer.firstName || "", customer.lastName || ""];
  }

  const [first, ...rest] = String(customer.name || "").trim().split(/\s+/);

  return [first || "", rest.join(" ")];
};

export const publicCustomer = (customer) => ({
  email: customer.email,
  name: customer.name || "",
  firstName: nameParts(customer)[0],
  lastName: nameParts(customer)[1],
  phone: customer.phone || "",
  avatar: customer.avatar || null,
  discountGroup: customer.discountGroup || null,
  address: customer.address || null,
  reminders: reminderPrefs(customer),
  marketing: customer.marketing === true,
});
