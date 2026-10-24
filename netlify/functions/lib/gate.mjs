// The access gate for every non-production deploy: staging, branch
// deploys and deploy previews. A visitor signs in by a magic link sent
// to an address on the allowlist; the session lasts a year. The edge
// function (netlify/edge-functions/gate.mjs) checks it on every
// request, and the gate function (netlify/functions/gate.mjs) signs
// people in. Both, and the CLI, use this module, so it holds no Node
// imports: it runs in Deno at the edge as well.
//
// The gate is never active in production: gateActive() is true for
// the two contexts named here and nothing else, and test/gate.test.mjs
// fails if that ever changes.
//
// Store layout (the `gate` store, one per context):
//   allow/<email | @domain>   { addedAt }        who may sign in
//   token/<sha256(token)>     { email, next, expires }   one use
//   session/<sha256(id)>      { email, createdAt, expires }
//   rate/address/<sha256(ip)>/<email>   { times: [...] }   link requests
//   rate/ip/<sha256(ip)>      { times: [...] }

import gate from "../../../data/gate.json" with { type: "json" };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// The only contexts the gate runs in. An unset context is not one of
// them: it is production's, as for the stores (lib/store.mjs).
export const GATED = ["branch-deploy", "deploy-preview"];

export const gateActive = (context) => GATED.includes(context);

export const COOKIE = "nff_gate";
// The end-to-end suite's browser carries its token in this cookie,
// since a header would reach every host the page calls.
export const MACHINE_COOKIE = "nff_gate_machine";
export const SESSION_TTL = gate.sessionDays * DAY;
export const LINK_TTL = gate.linkMinutes * MINUTE;
export const MAIL_CEILING = {
  hour: gate.mailCeiling.perHour, day: gate.mailCeiling.perDay,
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DOMAIN = /^@[^\s@/]+\.[^\s@/]{2,}$/;

export const normalize = (value) => String(value || "").trim().toLowerCase();

export const validEmail = (value) => EMAIL.test(normalize(value));

// An allowlist entry as typed -> "pat@example.com" or "@example.com"
// (every address at that domain, not its subdomains), else null.
export const parseEntry = (value) => {
  const entry = normalize(value);

  return !entry.includes("*") && (EMAIL.test(entry) || DOMAIN.test(entry))
    ? entry : null;
};

const hex = (bytes) => [...new Uint8Array(bytes)]
  .map((b) => b.toString(16).padStart(2, "0")).join("");

export const sha256 = async (value) => hex(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
);

export const secret = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));

  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// Equal strings, compared without stopping at the first difference.
export const same = async (a, b) => {
  const [x, y] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let diff = 0;

  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);

  return diff === 0 && !!a && !!b;
};

// Only a same-site path may follow a sign-in.
export const safeNext = (next) => {
  const s = String(next || "");

  return s.startsWith("/") && !s.startsWith("//") && !s.includes("\\")
    && !s.startsWith("/api/gate/") ? s : "/";
};

// --- The allowlist -------------------------------------------------

export const isAllowed = async (store, email) => {
  const address = normalize(email);

  if (!validEmail(address)) return false;

  return !!(await store.get(`allow/${address}`))
    || !!(await store.get(`allow/@${address.split("@")[1]}`));
};

export const listAllow = async (store) => {
  const out = [];

  for (const { key } of await store.list("allow/")) {
    const found = await store.get(key);

    if (found) out.push({ entry: key.slice("allow/".length), ...found });
  }

  return out;
};

export const addAllow = async (store, value, now = new Date()) => {
  const entry = parseEntry(value);

  if (!entry) {
    throw new Error("Give an email address or a whole domain, @example.com.");
  }
  await store.set(`allow/${entry}`, { addedAt: now.toISOString() });

  return entry;
};

// Removing an entry ends the sessions it let in. -> { entry, ended }
export const removeAllow = async (store, value) => {
  const entry = parseEntry(value);

  if (!entry) {
    throw new Error("Give an email address or a whole domain, @example.com.");
  }
  await store.delete(`allow/${entry}`);

  const ended = await endSessions(store, entry.startsWith("@")
    ? (email) => email.endsWith(entry)
    : (email) => email === entry);

  return { entry, ended };
};

// --- Sessions ------------------------------------------------------

export const sessionKey = async (id) => `session/${await sha256(id)}`;

export const createSession = async (store, email, now = new Date()) => {
  const id = secret();

  await store.set(await sessionKey(id), {
    email: normalize(email),
    createdAt: now.toISOString(),
    expires: now.getTime() + SESSION_TTL,
  });

  return id;
};

export const cookieValue = (headers, name) => {
  const raw = headers.get("cookie") || "";
  const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));

  return match ? match[1] : null;
};

// -> { email } for a live session of an address still on the
// allowlist, else null. A session of an address taken off the list is
// dead even if its record outlived the removal.
export const sessionFor = async (store, id, now = new Date()) => {
  if (!id || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) return null;

  const key = await sessionKey(id);
  const found = await store.get(key);

  if (!found) return null;
  if (now.getTime() > found.expires) {
    await store.delete(key);

    return null;
  }

  return (await isAllowed(store, found.email)) ? { email: found.email } : null;
};

// Ends every session for which `match(email)` is true (all when none
// is given). -> the number ended.
export const endSessions = async (store, match = () => true) => {
  let ended = 0;

  for (const { key } of await store.list("session/")) {
    const found = await store.get(key);

    if (found && match(found.email)) {
      await store.delete(key);
      ended += 1;
    }
  }

  return ended;
};

export const cookieHeader = (id, { maxAge = SESSION_TTL / 1000 } = {}) =>
  `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; ` +
  `Max-Age=${maxAge}`;

export const clearCookieHeader = () => cookieHeader("", { maxAge: 0 });

// --- Sign-in links -------------------------------------------------

const limited = async (store, key, { max, windowMinutes }, now) => {
  const rate = (await store.get(key)) || { times: [] };
  const recent = rate.times
    .filter((t) => now.getTime() - t < windowMinutes * MINUTE);

  await store.set(key, { times: [...recent, now.getTime()] });

  return recent.length >= max;
};

// Asks for a link. The caller answers "check your email" whatever this
// returns, so an address off the list cannot be told from one on it:
// both are counted against the limits, and neither answer carries a
// difference. -> { issue: true, email, token } when a link is to be
// mailed, else { issue: false }.
export const requestLink = async (store, { email, next, ip }, {
  now = new Date(),
} = {}) => {
  const address = normalize(email);
  const ipKey = ip ? await sha256(ip) : "";
  // Keyed on the address and the requester together, so a stranger who
  // asks for a listed person's address over and over spends only the
  // stranger's own allowance.
  const byAddress = validEmail(address) && await limited(
    store, `rate/address/${ipKey}/${address}`, gate.perAddress, now,
  );
  const byIp = ip
    ? await limited(store, `rate/ip/${ipKey}`, gate.perIp, now)
    : false;

  if (byAddress || byIp || !(await isAllowed(store, address))) {
    return { issue: false };
  }

  const token = secret();

  await store.set(`token/${await sha256(token)}`, {
    email: address,
    next: safeNext(next),
    expires: now.getTime() + LINK_TTL,
  });

  return { issue: true, email: address, token };
};

// Spends a token. -> { ok: true, email, next } or { ok: false, reason }.
export const verifyToken = async (store, token, { now = new Date() } = {}) => {
  if (!token || typeof token !== "string" || token.length > 200) {
    return { ok: false, reason: "invalid" };
  }

  const key = `token/${await sha256(token)}`;
  const found = await store.get(key);

  if (!found) return { ok: false, reason: "unknown" };
  await store.delete(key);

  if (now.getTime() > found.expires) return { ok: false, reason: "expired" };
  if (!(await isAllowed(store, found.email))) {
    return { ok: false, reason: "removed" };
  }

  return { ok: true, email: found.email, next: found.next };
};
