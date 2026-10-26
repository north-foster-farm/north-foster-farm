// Quiet accounts and the interaction clock (#189; D-189, James on
// #244, 2026-10-16). An account is never deleted for being quiet:
// after a year without interaction the customer comes off farm news
// and gets one notice saying so, with how to delete their details if
// they'd like to. Deleting is lib/forget.mjs.
//
// One clock, kept here and read nowhere else: lastInteraction(). It is
// the latest of the customer's `interaction`, their last order and
// the record's creation. `interaction` is { at, kind }, and a sign-in
// also keeps its session's tag and the interaction it replaced.
//
// What counts (KINDS): following a sign-in link; an action on the
// account while signed in; an order; the old list's confirmation link
// (not the public sign-up form, where anyone can type any address);
// a market sale linked by the household's badge (the dashboard's,
// when it exists). An email click would count
// too, but none is recorded: the site never sees a click on its own
// (the coordinator, 2026-10-22, on #189), so `email-click` waits for a
// redirect of ours; leavingLink() says which links it must ignore.
//
// What doesn't: leaving. The one-click unsubscribe records nothing.
// Turning farm news or a reminder off in the account records nothing,
// and takes back the sign-in that session began with, so signing in
// only to opt out or to delete leaves the clock where it was.

import { createHash } from "node:crypto";

import { normalizeEmail, publicCustomer } from "./auth.mjs";
import { now as clock } from "./clock.mjs";
import { log } from "./log.mjs";
import { sendMail } from "./mail.mjs";
import { optOut } from "./news.mjs";
import { allCustomers, getCustomer, saveCustomer } from "./records.mjs";
import { accountUrlFor, mailLinks } from "./site.mjs";
import { quietNotice } from "./templates.mjs";

export const INACTIVE_AFTER_YEARS = 1;

export const KINDS = [
  "sign-in", "account", "order", "sign-up", "badge", "email-click",
];

const hash = (value) => createHash("sha256").update(value).digest("hex");

// A session named without its id: enough to match the sign-in it
// began with, useless for signing in.
export const sessionTag = (id) => hash(`interaction ${id}`).slice(0, 16);

const latest = (...isos) => isos.filter(Boolean)
  .reduce((a, b) => (a === null || b > a ? b : a), null);

// -> the ISO time of the customer's last interaction, or null.
export const lastInteraction = (customer) => (customer
  ? latest(customer.interaction && customer.interaction.at,
    customer.lastOrderAt, customer.createdAt)
  : null);

const yearsBefore = (now, years) => {
  const d = new Date(now);

  d.setUTCFullYear(d.getUTCFullYear() - years);

  return d;
};

// Records an interaction for an address that has a record; one that
// has none is not made for it. The clock never runs back. Never
// throws for a store that fails: what the customer did has happened,
// and a missed mark costs at most an early notice. -> the record, or
// null.
export const noteInteraction = async (stores, email, kind, {
  now = clock(), session = null,
} = {}) => {
  if (!KINDS.includes(kind)) throw new Error(`Unknown interaction ${kind}`);

  try {
    const customer = await getCustomer(stores, normalizeEmail(email));

    if (!customer) return null;

    const at = now.toISOString();
    const was = customer.interaction || null;

    if (was && was.at > at) return customer;

    const interaction = { at, kind };

    if (kind === "sign-in") {
      if (session) interaction.session = sessionTag(session);
      // Only the last one before it, so a take-back has somewhere to go.
      interaction.before = was ? { at: was.at, kind: was.kind } : null;
    }

    return await saveCustomer(stores, { ...customer, interaction });
  } catch (error) {
    log.error({ event: "retention.note_failed", kind, error: error.message });

    return null;
  }
};

// Leaving, while signed in: if the session's sign-in is the latest
// interaction, it is taken back. -> the record, or null.
export const leaving = async (stores, email, { session = null } = {}) => {
  try {
    const customer = await getCustomer(stores, normalizeEmail(email));
    const was = customer && customer.interaction;

    if (!was || was.kind !== "sign-in" || !session
      || was.session !== sessionTag(session)) {
      return customer || null;
    }

    return await saveCustomer(stores, {
      ...customer, interaction: was.before || null,
    });
  } catch (error) {
    log.error({ event: "retention.leaving_failed", error: error.message });

    return null;
  }
};

// The settings a profile save can change, as the account page shows
// them. The page sends every field on each save, so what changed is
// found against the record, not read from the keys sent.
const trimmed = (v) => (typeof v === "string" ? v.trim() : v);

const changedSettings = (changes, customer) => {
  const was = publicCustomer(customer);
  const out = [];

  for (const k of ["firstName", "lastName", "phone", "avatar"]) {
    if (changes[k] !== undefined && trimmed(changes[k]) !== was[k]) {
      out.push({ k, off: false });
    }
  }
  if (changes.marketing !== undefined
    && (changes.marketing === true) !== was.marketing) {
    out.push({ k: "marketing", off: was.marketing });
  }
  if (changes.reminders && typeof changes.reminders === "object") {
    for (const [k, on] of Object.entries(was.reminders)) {
      const v = changes.reminders[k];

      if (v !== undefined && !!v !== on) out.push({ k, off: on });
    }
  }

  return out;
};

// A profile save that only turns things off, against the record as it
// was: farm news, or a reminder, from on to off. Anything else that
// changed (a name, a phone, turning something on) is taking part, and
// so is a save that changed nothing.
export const leavingChange = (changes, customer) => {
  if (!changes || typeof changes !== "object" || !customer) return false;

  const changed = changedSettings(changes, customer);

  return changed.length > 0 && changed.every((c) => c.off);
};

// For a click we may one day see: the links that are someone leaving.
export const leavingLink = (link) => {
  let url;

  try {
    url = new URL(link);
  } catch {
    return false;
  }

  return /unsubscribe/i.test(url.pathname) || url.hash === "#settings";
};

// Quiet for a year or more, and not told since it went quiet.
export const quietDue = (customer, now = clock()) => {
  const last = lastInteraction(customer);

  if (!customer || !customer.email || !last) return false;
  if (last > yearsBefore(now, INACTIVE_AFTER_YEARS).toISOString()) {
    return false;
  }

  return !(customer.quietNoticeAt && customer.quietNoticeAt >= last);
};

// At most this many notices a run, so a day when a whole cohort goes
// quiet cannot hold up the job steps after it. The rest go the next
// day, the longest quiet first.
export const QUIET_PER_RUN = 50;

// Once a day, from the jobs: each quiet account comes off farm news and
// gets the notice, once. A notice that fails is tried again the next
// day; the rest go on. With `apply` false nothing is written or sent.
// -> { due, noticed, failed, left } (addresses; `left` is a count).
export const quietAccounts = async (stores, {
  env = process.env, mail = sendMail, now = clock(), apply = true,
  limit = QUIET_PER_RUN, only = null,
} = {}) => {
  const due = (await allCustomers(stores)).filter((c) => quietDue(c, now)
    && (!only || only.includes(c.email)))
    .sort((a, b) => (lastInteraction(a) < lastInteraction(b) ? -1 : 1));
  const report = {
    due: due.map((c) => c.email), noticed: [], failed: [],
    left: Math.max(0, due.length - limit),
  };

  if (!apply) return report;

  for (const customer of due.slice(0, limit)) {
    try {
      // A retry after a failed send finds them already taken off.
      const wasSubscribed = customer.marketing === true
        || customer.marketingSource === "inactive";

      if (customer.marketing === true) {
        await optOut(stores, customer.email, {
          source: "inactive", detail: "a year without interaction",
        }, now);
      }
      await mail({
        to: customer.email,
        idempotencyKey: `quiet-${hash(
          `${customer.email} ${lastInteraction(customer)}`).slice(0, 16)}`,
        ...quietNotice(customer, {
          accountUrl: accountUrlFor(env), links: mailLinks(env),
          wasSubscribed,
        }),
      }, { env, stores });

      const fresh = await getCustomer(stores, customer.email);

      await saveCustomer(stores, {
        ...fresh, quietNoticeAt: now.toISOString(),
      });
      report.noticed.push(customer.email);
    } catch (error) {
      log.error({ event: "retention.quiet_failed", error: error.message });
      report.failed.push(customer.email);
    }
  }

  return report;
};
