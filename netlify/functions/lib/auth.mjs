// Magic-link sign-in and sessions. A customer types their email, we
// mail a single-use link, and following it sets a session cookie.
// There is no password anywhere. The CLI mints links and sessions the
// same way to sign in as a customer.
//
// Store layout (the `auth` store):
//   token/<sha256(token)>   { email, expires, next, changeFrom? }
//                           one use, 15 min
//   session/<sha256(id)>    { email, createdAt, expires, via }
//   rate/<email>            { times: [...] }             link requests
//   rate/join/<email>       { times: [...] }    join-link requests, kept
//                           apart so they never stop a sign-in (#495)
//
// Links and sessions are written and deleted through lib/auth-records,
// which keeps each one's index key under its address (#508).

import { createHash, randomBytes } from "node:crypto";

import { deleteAuth, putAuth } from "./auth-records.mjs";
import { now as clock, real } from "./clock.mjs";
import { sendMail } from "./mail.mjs";
import {
  getCustomer, reminderPrefs, saveCustomer,
} from "./records.mjs";
import { mailLinks, siteUrl } from "./site.mjs";
import {
  emailChangeLink, groupJoinLink, magicLink,
} from "./templates.mjs";
import accounts from "../../../data/accounts.json" with { type: "json" };
import terms from "../../../data/delivery.json" with { type: "json" };
import {
  activePerks, publicPerk,
} from "../../../assets/scripts/order/lib/perks.mjs";
import { today } from "../../../assets/scripts/order/lib/zoned.mjs";

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
// A customer's choice for videos playing on their own.
export const AUTOPLAY = ["on", "off"];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const normalizeEmail = (email) =>
  String(email || "").trim().toLowerCase();

export const validEmail = (email) => EMAIL.test(normalizeEmail(email));

const hash = (value) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

// Sessions, like links, are stored under a hash of the id, so reading
// Blobs does not give a live session id. The id lives only in the
// customer's cookie.
export const sessionKey = (id) => `session/${hash(id)}`;

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

// Only a same-site path may follow a sign-in, never another site. A
// control character is out too: browsers drop a tab or newline from a
// URL, so "/\t/evil.example" would resolve to "//evil.example".
export const safeNext = (next) => {
  const s = String(next || "");

  // eslint-disable-next-line no-control-regex
  const control = /[\x00-\x1f]/.test(s);

  return s.startsWith("/") && !s.startsWith("//") && !s.includes("\\")
    && !control
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
  now = clock(),
  env = process.env,
  mail = sendMail,
  send = true,
  limit = true,
  ttl = LINK_TTL,
  changeFrom = null,
  join = null,
} = {}) => {
  const address = normalizeEmail(email);

  if (!validEmail(address)) return { ok: false, reason: "invalid" };

  if (limit) {
    // Real time: a tester's clock must not reopen the limit. A group's
    // sign-up page counts in its own bucket: anyone with the QR code
    // can ask for links to an address, and that must never use up the
    // owner's sign-in links (#495).
    const at = real(now).getTime();
    const bucket = join ? `rate/join/${address}` : `rate/${address}`;
    const limited = await hit(stores, bucket, at, {
      windowMs: LINK_WINDOW, max: LINKS_PER_WINDOW,
    });

    if (limited.limited) return { ok: false, reason: "rate" };
  }

  const token = secret();

  await putAuth(stores, `token/${hash(token)}`, {
    email: address,
    next: safeNext(next),
    expires: now.getTime() + ttl,
    createdAt: now.toISOString(),
    ...(changeFrom ? { changeFrom: normalizeEmail(changeFrom) } : {}),
    // A group's sign-up page (#495): following the link joins the
    // group, by lib/join.mjs. Its `group` is the key, never the token.
    ...(join ? { join: join.record } : {}),
  });

  const url = `${siteUrl(env)}/api/auth/verify?token=${token}`;
  const letter = changeFrom ? emailChangeLink
    : (join ? groupJoinLink : magicLink);

  if (send) {
    await mail({
      to: address,
      idempotencyKey: `link-${hash(token).slice(0, 16)}`,
      // A sign-in link: the staging toolbar shows it to that
      // address's own session only (#294).
      credential: true,
      ...letter(address, url, {
        minutes: ttl / MINUTE, links: mailLinks(env),
        ...(join
          ? { group: join.name, news: join.record.news === true } : {}),
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

// An expired link says so; one that was to change the email address
// says that instead, since a change starts from Settings, not the
// sign-in form (#240).
const expired = (found) => ({
  ok: false, reason: found.changeFrom ? "change-expired" : "expired",
});

const tokenResult = (found) => ({
  ok: true,
  email: found.email,
  next: found.next || "/account/",
  changeFrom: found.changeFrom || null,
  ...(found.join ? { join: found.join } : {}),
});

// Reads a token without spending it, so a prefetch or a scanner
// following the emailed link can't move the account on its own
// (#240): the confirm step on /login/ peeks first and only a POST
// consumes. -> the same shape as verifyToken, but the token still
// works afterward.
export const peekToken = async (stores, token, { now = clock() } = {}) => {
  const look = await lookupToken(stores, token);

  if (look.reason) return { ok: false, reason: look.reason };
  if (now.getTime() > look.found.expires) {
    return expired(look.found);
  }

  return tokenResult(look.found);
};

// Consumes a token. -> { ok: true, email, next } or { ok: false, reason }.
export const verifyToken = async (stores, token, { now = clock() } = {}) => {
  const look = await lookupToken(stores, token);

  if (look.reason) return { ok: false, reason: look.reason };

  await deleteAuth(stores, look.key, look.found);

  if (now.getTime() > look.found.expires) {
    return expired(look.found);
  }

  return tokenResult(look.found);
};

// Whose address a sign-in token carries, without spending it. Under
// maintenance an admin's link still works.
export const tokenEmail = async (stores, token) => {
  if (!token || typeof token !== "string" || token.length > 200) return null;

  const found = await stores.auth.get(`token/${hash(token)}`);

  return found ? found.email : null;
};

export const createSession = async (stores, email, {
  now = clock(),
  via = "link",
} = {}) => {
  const id = secret();
  const address = normalizeEmail(email);

  await ensureCustomer(stores, address, now);
  await putAuth(stores, sessionKey(id), {
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

// Whether the request carries a stamp: a page that thinks it is signed
// in. With no live session behind it (it ended on the server: the
// account deleted, the CLI, the sweep), the answer clears it, so the
// page knows it is signed out (#149).
export const hasStamp = (req) => new RegExp(`(?:^|;\\s*)${STAMP}=[^;]`)
  .test(req.headers.get("cookie") || "");

export const cookieFrom = (req) => {
  const raw = req.headers.get("cookie") || "";
  const match = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));

  return match ? match[1] : null;
};

// -> { id, email, customer } for a live session on the request, else null.
export const sessionFrom = async (stores, req, { now = clock() } = {}) => {
  const id = cookieFrom(req);

  if (!id || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) return null;

  const key = sessionKey(id);
  const session = await stores.auth.get(key);

  if (!session) return null;
  if (now.getTime() > session.expires) {
    await deleteAuth(stores, key, session);

    return null;
  }

  const customer = await ensureCustomer(stores, session.email, now);

  return { id, email: session.email, customer, via: session.via };
};

export const endSession = async (stores, id) => {
  if (id) await deleteAuth(stores, sessionKey(id));
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

// Stricter, for a group host's actions (#495): this origin only, never
// a sibling on the same site (a deploy preview, a branch subdomain).
// Sec-Fetch-Site must say same-origin; a browser without it must send
// an Origin naming this host. A request with neither is refused.
export const sameOrigin = (req) => {
  const fetchSite = req.headers.get("sec-fetch-site");

  if (fetchSite) return fetchSite === "same-origin";

  const origin = req.headers.get("origin");

  if (!origin) return false;

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

export const publicCustomer = (customer, now = clock()) => ({
  email: customer.email,
  name: customer.name || "",
  firstName: nameParts(customer)[0],
  lastName: nameParts(customer)[1],
  phone: customer.phone || "",
  avatar: customer.avatar || null,
  discountGroup: customer.discountGroup || null,
  // The perks in force today (#514), so the order page prices with
  // them and the account page names them. The server reads them again
  // from the record; nothing here is trusted back.
  perks: activePerks(customer, today(now, terms.timeZone)).map(publicPerk),
  // A buying group's key (#471), so the order page asks /api/group for
  // the group's pickup and prices with no code.
  memberGroup: customer.memberGroup && typeof customer.memberGroup === "object"
    ? customer.memberGroup.id || null
    : null,
  address: customer.address || null,
  reminders: reminderPrefs(customer),
  marketing: customer.marketing === true,
  reviewDismissed: !!customer.reviewDismissedAt,
  // "on" or "off" once the customer chose; until then null, and each
  // browser follows its own rules (#161).
  autoplay: AUTOPLAY.includes(customer.autoplay) ? customer.autoplay : null,
});
