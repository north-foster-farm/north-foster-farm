// Magic-link sign-in and sessions. A customer types their email, we
// mail a single-use link, and following it sets a session cookie.
// There is no password anywhere. The CLI mints links and sessions the
// same way to sign in as a customer.
//
// Store layout (the `auth` store):
//   token/<sha256(token)>   { email, expires, next, changeFrom? }
//                           one use, 15 min
//   session/<id>            { email, createdAt, expires, via }
//   rate/<email>            { times: [...] }             link requests

import { createHash, randomBytes } from "node:crypto";

import { sendMail } from "./mail.mjs";
import {
  getCustomer, reminderPrefs, saveCustomer,
} from "./records.mjs";
import { mailLinks, siteUrl } from "./site.mjs";
import { emailChangeLink, magicLink } from "./templates.mjs";
import accounts from "../../../data/accounts.json" with { type: "json" };

const MINUTE = 60_000;

// The lifetimes the privacy policy and the emails state, from
// data/accounts.json (Q21b).
export const LINK_TTL = accounts.signInLinkMinutes * MINUTE;
// A link the farm puts in an email the customer may not open for
// days, such as "Pick a new time" after a denied pickup window.
export const LONG_LINK_TTL = accounts.orderLinkDays * 24 * 60 * MINUTE;
export const SESSION_TTL = accounts.sessionDays * 24 * 60 * MINUTE;
export const LINKS_PER_WINDOW = 3;
export const LINK_WINDOW = 15 * MINUTE;
export const COOKIE = "nff_session";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const normalizeEmail = (email) =>
  String(email || "").trim().toLowerCase();

export const validEmail = (email) => EMAIL.test(normalizeEmail(email));

const hash = (value) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

// A sliding-window hit counter in the auth store, shared by every
// per-address, per-account and per-IP limit in this file and in
// lib/email-change.mjs. -> { limited } and records the hit unless it
// was already over.
export const hit = async (stores, key, now, { windowMs, max }) => {
  const rate = (await stores.auth.get(key)) || { times: [] };
  const recent = rate.times.filter((t) => now - t < windowMs);

  if (recent.length >= max) return { limited: true };

  await stores.auth.set(key, { times: [...recent, now] });

  return { limited: false };
};

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
// longer (`ttl`). With `changeFrom`, the link confirms a signed-in
// customer's new address (#240): it goes to that address, and
// following it moves the account from `changeFrom` (lib/email-change).
export const requestLink = async (stores, { email, next }, {
  now = new Date(),
  env = process.env,
  mail = sendMail,
  send = true,
  limit = true,
  ttl = LINK_TTL,
  changeFrom = null,
} = {}) => {
  const address = normalizeEmail(email);

  if (!validEmail(address)) return { ok: false, reason: "invalid" };

  if (limit) {
    const limited = await hit(stores, `rate/${address}`, now.getTime(), {
      windowMs: LINK_WINDOW, max: LINKS_PER_WINDOW,
    });

    if (limited.limited) return { ok: false, reason: "rate" };
  }

  const token = secret();

  await stores.auth.set(`token/${hash(token)}`, {
    email: address,
    next: safeNext(next),
    expires: now.getTime() + ttl,
    createdAt: now.toISOString(),
    ...(changeFrom ? { changeFrom: normalizeEmail(changeFrom) } : {}),
  });

  const url = `${siteUrl(env)}/api/auth/verify?token=${token}`;
  const letter = changeFrom ? emailChangeLink : magicLink;

  if (send) {
    await mail({
      to: address,
      idempotencyKey: `link-${hash(token).slice(0, 16)}`,
      ...letter(address, url, {
        minutes: ttl / MINUTE, links: mailLinks(env),
      }),
    }, { env });
  }

  return { ok: true, url, email: address };
};

const lookupToken = async (stores, token) => {
  if (!token || typeof token !== "string" || token.length > 200) {
    return { reason: "invalid" };
  }

  const key = `token/${hash(token)}`;
  const found = await stores.auth.get(key);

  return found ? { key, found } : { reason: "unknown" };
};

const tokenResult = (found) => ({
  ok: true,
  email: found.email,
  next: found.next || "/account/",
  changeFrom: found.changeFrom || null,
});

// Reads a token without spending it, so a prefetch or a scanner
// following the emailed link can't move the account on its own
// (#240): the confirm step on /login/ peeks first and only a POST
// consumes. -> the same shape as verifyToken, but the token still
// works afterward.
export const peekToken = async (stores, token, { now = new Date() } = {}) => {
  const look = await lookupToken(stores, token);

  if (look.reason) return { ok: false, reason: look.reason };
  if (now.getTime() > look.found.expires) {
    return { ok: false, reason: "expired" };
  }

  return tokenResult(look.found);
};

// Consumes a token. -> { ok: true, email, next } or { ok: false, reason }.
export const verifyToken = async (stores, token, { now = new Date() } = {}) => {
  const look = await lookupToken(stores, token);

  if (look.reason) return { ok: false, reason: look.reason };

  await stores.auth.delete(look.key);

  if (now.getTime() > look.found.expires) {
    return { ok: false, reason: "expired" };
  }

  return tokenResult(look.found);
};

export const createSession = async (stores, email, {
  now = new Date(),
  via = "link",
} = {}) => {
  const id = secret();
  const address = normalizeEmail(email);

  await ensureCustomer(stores, address, now);
  await stores.auth.set(`session/${id}`, {
    email: address,
    createdAt: now.toISOString(),
    expires: now.getTime() + SESSION_TTL,
    via,
  });

  return { id, email: address };
};

export const cookieHeader = (id, { maxAge = SESSION_TTL / 1000 } = {}) =>
  `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; ` +
  `Max-Age=${maxAge}`;

export const clearCookieHeader = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// A stamp beside the session cookie that scripts can read, with no
// secret in it: a new one at each sign-in, none after signing out.
// Pages cache /api/me against it (scripts/session/), so a sign-in or
// sign-out shows at once on every page, in every tab.
export const STAMP = "nff_signed_in";

export const stampHeader = (now, { maxAge = SESSION_TTL / 1000 } = {}) =>
  `${STAMP}=${now.getTime().toString(36)}; Path=/; Secure; ` +
  `SameSite=Lax; Max-Age=${maxAge}`;

export const clearStampHeader = () =>
  `${STAMP}=; Path=/; Secure; SameSite=Lax; Max-Age=0`;

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
