// The business clock, and the request it is read for (#294).
//
// `now()` is what the site means by "now": order cutoffs and locks,
// the date lists, order timestamps, the dates in emails and the jobs.
// On staging a tester may move it, for their own browser only, with
// the toolbar's clock: an offset in the `nff_clock` cookie, so the
// clock keeps running from the time they set. Everywhere else, and
// always in production, `now()` is the real time.
//
// Every function runs its request inside `within` (lib/log.mjs,
// withLog), which reads two facts off the request once: the clock
// offset, and the gate session that asked, so an email written to the
// outbox can be stamped with the session it belongs to (lib/mail.mjs,
// staging.mjs). Work the request leaves running after its answer
// (waitUntil) keeps the same facts.
//
// What must not move with a tester's clock reads the real time, with
// `new Date()` or `real(now)`: the gate, rate limits, the send breaker,
// logs, retention and the sweeps of shared data, backups, and every
// call to Square and PayPal, whose sandboxes keep real clocks.

import { AsyncLocalStorage } from "node:async_hooks";

import { COOKIE, cookieValue, sha256 } from "./gate.mjs";
import { deployContext } from "./store.mjs";

export const CLOCK_COOKIE = "nff_clock";

// The only contexts whose clock may move: staging, and a local run of
// the functions. Never production, never a preview.
export const CLOCKED = ["branch-deploy", "dev"];

const DAY = 24 * 60 * 60_000;

// Far enough for any test (a year's prices, a holiday), near enough
// that a typo is refused rather than obeyed.
export const MAX_OFFSET = 3 * 366 * DAY;

const scope = new AsyncLocalStorage();

export const clockAllowed = (env = process.env) =>
  CLOCKED.includes(deployContext(env));

// The offset a request asks for, in ms, or 0 where none is allowed.
export const offsetFrom = (headers, env = process.env) => {
  if (!clockAllowed(env) || !headers) return 0;

  const raw = cookieValue(headers, CLOCK_COOKIE);

  if (!raw || !/^-?\d{1,12}$/.test(raw)) return 0;

  const offset = Number(raw);

  return Math.abs(offset) <= MAX_OFFSET ? offset : 0;
};

const headersOf = (req) => (req && req.headers
  && typeof req.headers.get === "function" ? req.headers : null);

// Runs `work` with this request's facts. A scheduled run has no
// request, and gets the real clock and no session.
export const within = (req, work, env = process.env) => {
  const headers = headersOf(req);

  return scope.run({
    offset: offsetFrom(headers, env),
    gate: headers && deployContext(env) !== "production"
      ? cookieValue(headers, COOKIE) : null,
  }, work);
};

// For tests and the CLI: runs `work` with the facts given.
export const runAs = (facts, work) => scope.run({
  offset: 0, gate: null, ...facts,
}, work);

export const offset = () => (scope.getStore() || {}).offset || 0;

export const now = () => new Date(Date.now() + offset());

// A time on the business clock -> the same moment on the real one.
export const real = (date) => new Date(date.getTime() - offset());

// The tag of the gate session behind this request, or null. One way:
// it is not the gate store's key for the session, so an outbox record
// names no session that could be looked up.
export const tagOf = async (id) => (id ? sha256(`outbox:${id}`) : null);

export const sessionTag = () => tagOf((scope.getStore() || {}).gate);

// The cookie that sets an offset, or ends one (`null`). A browser
// session cookie: it goes when the browser closes.
export const clockCookie = (value) => value === null
  ? `${CLOCK_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`
  : `${CLOCK_COOKIE}=${Math.round(value)}; Path=/; Secure; SameSite=Lax`;
