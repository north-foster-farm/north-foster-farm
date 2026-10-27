// Farm news by email: opt-in only, ever. Consent is `marketing` and
// `marketingAt` on the customer record, set by the confirmation link
// the public sign-up field mails, the checkout box, the settings box,
// or the import of the old list's paper sheets. Only the public field,
// which anyone can type any address into, asks to confirm; the boxes
// and the old list join at once (James, #303, 2026-10-25). Anyone
// with an email address may opt in; a record is made for an address
// that has never ordered.
//
// The list itself lives in Resend (an audience), so broadcasts go out
// with Resend's unsubscribe link. syncAudience keeps the two in step:
// our record decides who is in, Resend decides who has left.

import { createHash, randomBytes } from "node:crypto";

import { normalizeEmail, validEmail } from "./auth.mjs";
import { now as clock, real } from "./clock.mjs";
import { log } from "./log.mjs";
import { sendMail } from "./mail.mjs";
import { resendAllowed, resendRefusal } from "./resend-guard.mjs";
import { creditKey } from "./credit.mjs";
import {
  SCHEMA_DEFAULTS, allCustomers, cartKey, consentLog, deleteCustomer,
  getCustomer, ordersFor, saveCustomer,
} from "./records.mjs";
import { customerEmailWithheld } from "./payments.mjs";
import { mailLinks, siteUrl } from "./site.mjs";
import { newsConfirm, newsWelcome } from "./templates.mjs";
import accounts from "../../../data/accounts.json" with { type: "json" };

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export const CONFIRM_TTL = accounts.newsInviteDays * DAY;
export const REQUESTS_PER_WINDOW = 3;
export const REQUEST_WINDOW = 15 * MINUTE;
export const SYNC_KEY = "news/sync";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const text = (value, max = 60) =>
  (typeof value === "string" ? value.trim().slice(0, max) : "");
const fullName = (first, last) => [first, last].filter(Boolean).join(" ");
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// --- Consent -------------------------------------------------------

// Dated consent on the record, creating one when the address has
// none. A record that already says yes is returned untouched. The
// rest of the options go in the consent log's event (records.mjs):
// `detail`, `capturedBy`, `evidence`, and `givenAt` when consent
// was given before it was entered (a market sheet).
export const optIn = async (stores, email, {
  firstName = "", lastName = "", source = "site",
  detail = "", capturedBy = null, evidence = null, givenAt = null,
} = {}, now = clock()) => {
  const address = normalizeEmail(email);
  const at = now.toISOString();
  const existing = await getCustomer(stores, address);
  const consent = { detail, capturedBy, evidence, at: givenAt || at };

  if (existing && existing.marketing === true) return existing;
  if (existing) {
    return saveCustomer(stores, {
      ...existing,
      firstName: existing.firstName || firstName,
      lastName: existing.lastName || lastName,
      name: existing.name || fullName(firstName, lastName),
      marketing: true,
      marketingAt: at,
      marketingSource: source,
    }, { consent });
  }

  return saveCustomer(stores, {
    email: address,
    name: fullName(firstName, lastName),
    firstName,
    lastName,
    phone: "",
    avatar: null,
    discountGroup: null,
    address: null,
    marketing: true,
    marketingAt: at,
    marketingSource: source,
    createdAt: at,
    lastOrderAt: null,
  }, { consent });
};

// Consent withdrawn, dated. Nothing happens to a record that never
// said yes.
export const optOut = async (stores, email, {
  source = "site", detail = "",
} = {}, now = clock()) => {
  const existing = await getCustomer(stores, normalizeEmail(email));

  if (!existing || existing.marketing !== true) return existing || null;

  return saveCustomer(stores, {
    ...existing,
    marketing: false,
    marketingAt: now.toISOString(),
    marketingSource: source,
  }, { consent: { detail } });
};

// Left through Resend (its unsubscribe link, or deleted there), at `at`,
// the time Resend gives the change. The time is kept as resendLeftAt,
// so the sync can tell a sign-up here made since from one the
// unsubscribe overrules (#234). A consent here newer than the event (a
// late redelivery) stands.
export const resendLeft = async (stores, email, at, now = clock()) => {
  const existing = await getCustomer(stores, normalizeEmail(email));
  const when = Date.parse(at) || now.getTime();

  if (!existing) return null;
  if (existing.marketing === true
    && Date.parse(existing.marketingAt) > when) return existing;

  const before = existing.resendLeftAt ? Date.parse(existing.resendLeftAt) : 0;

  await saveCustomer(stores, {
    ...existing,
    resendLeftAt: new Date(Math.max(when, before)).toISOString(),
  });

  return optOut(stores, existing.email, {
    source: "resend", detail: "unsubscribed or deleted in Resend",
  }, now);
};

// --- The welcome and its unsubscribe -------------------------------

// A link that takes one address off the list in one click, with no
// sign-in (T6c). The token is random, kept hashed in the auth store
// and never expires, so the link in an old email still works.
// -> { page, post }: `page` for the email's body, a /news/ link that
// unsubscribes once the page has loaded, so a mail scanner that only
// fetches it takes no one off; `post` for the List-Unsubscribe header,
// the one-click POST of RFC 8058.
export const unsubscribeLinks = async (stores, email, {
  env = process.env, now = clock(),
} = {}) => {
  const token = secret();
  const site = siteUrl(env);

  await stores.auth.set(`unsub/${hash(token)}`, {
    email: normalizeEmail(email), createdAt: now.toISOString(),
  });

  return {
    page: `${site}/news/?unsubscribe=${token}`,
    post: `${site}/api/news/unsubscribe?token=${token}`,
  };
};

// The click, as often as it comes. -> { ok: true, email } or
// { ok: false, reason }.
export const unsubscribe = async (stores, token, { now = clock() } = {}) => {
  if (!token || typeof token !== "string" || token.length > 200) {
    return { ok: false, reason: "invalid" };
  }

  const found = await stores.auth.get(`unsub/${hash(token)}`);

  if (!found) return { ok: false, reason: "unknown" };
  await optOut(stores, found.email, {
    source: "unsubscribe", detail: "the link in a list email",
  }, now);

  return { ok: true, email: found.email };
};

// True when a change put an address on the list that wasn't on it.
export const joined = (before, after) => !!after
  && after.marketing === true && !(before && before.marketing === true);

// The welcome (T6), the whole welcome sequence (#267), to a record
// just put on the list: the news field's confirmation, account
// settings, the order box once the order is placed, or the import of
// the old list. Never
// throws; a welcome that fails leaves them on the list.
// -> true when it went.
export const welcome = async (stores, customer, opts = {}) =>
  (await attemptWelcome(stores, customer, opts)).ok;

// Whether a failed send is known to have sent nothing: refused before
// any request (the breaker, Resend's own refusal outside production, a
// message with no recipient: a MailError with no status that cannot be
// retried) or rejected by Resend with a 4xx other than 409 (the same
// key still in progress) and 429 (see the next). Anything else may have
// been accepted: a timeout or network error (Resend can take the
// request and answer after we stop waiting), a 5xx, a 409, a 429, or an
// error we do not know the shape of.
export const sentNothing = (error) => {
  if (!error || error.name !== "MailError") return false;

  const { status = 0, retryable } = error;

  if (!status) return retryable === false;

  return status >= 400 && status < 500 && status !== 409 && status !== 429;
};

// The welcome, and what became of it. Never throws. -> { ok: true }, or
// { ok: false, nothing } where `nothing` says the failure is known to
// have sent nothing, so the welcome is still owed and may go again.
// The key is the same for the same consent (the address and its
// `marketingAt`), so Resend answers a repeat within a day with the
// first send's response.
const attemptWelcome = async (stores, customer, {
  env = process.env, mail = sendMail, now = clock(),
} = {}) => {
  let message;

  try {
    const links = await unsubscribeLinks(stores, customer.email, { env, now });

    message = {
      to: customer.email,
      idempotencyKey: `welcome-${
        hash(`${customer.email} ${customer.marketingAt}`).slice(0, 16)}`,
      // Its unsubscribe link acts for the address (#294).
      credential: true,
      headers: {
        "List-Unsubscribe": `<${links.post}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      ...newsWelcome(customer, links.page, { links: mailLinks(env) }),
    };
  } catch (error) {
    // Nothing was asked of the mail driver yet.
    log.error({ event: "news.welcome.failed", error: error.message });

    return { ok: false, nothing: true };
  }

  try {
    await mail(message, { env });

    return { ok: true };
  } catch (error) {
    log.error({ event: "news.welcome.failed", error: error.message });

    return { ok: false, nothing: sentNothing(error) };
  }
};

// Per address, like sign-in. -> true when this request may go on.
const withinRate = async (stores, address, now) => {
  const rateKey = `rate/news/${address}`;
  const rate = (await stores.auth.get(rateKey)) || { times: [] };
  // Real time: a tester's clock must not reopen the limit (#294).
  const at = real(now).getTime();
  const recent = rate.times.filter((t) => at - t < REQUEST_WINDOW);

  if (recent.length >= REQUESTS_PER_WINDOW) return false;
  await stores.auth.set(rateKey, { times: [...recent, at] });

  return true;
};

// --- Signing up on the site ----------------------------------------

// The footer and news-page field: anyone can type any address into
// it, so it mails the confirmation link below, and the address joins
// only when that link is followed (James, #303). An address already
// on the list is sent nothing and gets the same answer. `page` is the
// path it was sent from, for the consent log.
// -> { ok: true, email } or { ok: false, reason }.
export const subscribe = async (stores, { email, firstName, lastName }, {
  page = "",
  now = clock(),
  limit = true,
  env = process.env,
  mail = sendMail,
} = {}) => {
  const address = normalizeEmail(email);

  if (!validEmail(address)) return { ok: false, reason: "invalid" };
  if (limit && !(await withinRate(stores, address, now))) {
    return { ok: false, reason: "rate" };
  }

  const existing = await getCustomer(stores, address);

  if (existing && existing.marketing === true) {
    return { ok: true, email: address };
  }

  const r = await requestSubscribe(stores, {
    email: address, firstName, lastName,
  }, { now, env, mail, limit: false, page });

  return { ok: r.ok, email: address };
};

// --- The confirmation link -----------------------------------------

// Mails the sign-up field's one-click confirmation. The address is
// only added when that link is followed.
// -> { ok: true, url, email } or { ok: false, reason }.
export const requestSubscribe = async (stores, {
  email, firstName, lastName,
}, {
  now = clock(),
  env = process.env,
  mail = sendMail,
  send = true,
  limit = true,
  ttl = CONFIRM_TTL,
  page = "",
} = {}) => {
  const address = normalizeEmail(email);

  if (!validEmail(address)) return { ok: false, reason: "invalid" };
  if (limit && !(await withinRate(stores, address, now))) {
    return { ok: false, reason: "rate" };
  }

  const token = secret();
  const first = text(firstName);
  const last = text(lastName);

  await stores.auth.set(`news/${hash(token)}`, {
    email: address,
    firstName: first,
    lastName: last,
    // Marks the sign-up field's links. A link without it was mailed
    // by the old list's re-invite, before #303, and confirms as one.
    via: "form",
    page: text(page, 100),
    expires: now.getTime() + ttl,
    createdAt: now.toISOString(),
  });

  const url = `${siteUrl(env)}/api/news/confirm?token=${token}`;

  if (send) {
    await mail({
      to: address,
      idempotencyKey: `news-${hash(token).slice(0, 16)}`,
      // Its link acts for the address: the staging toolbar shows it
      // to that address's own session only (#294).
      credential: true,
      ...newsConfirm(address, url, {
        days: Math.round(ttl / DAY), links: mailLinks(env),
      }),
    }, { env });
  }

  return { ok: true, url, email: address };
};

// The click. Single use; expired links are refused. A click that puts
// the address on the list starts the welcome, as every way on does
// (#267). The consent is the sign-up field's, confirmed.
// -> { ok: true, email } or { ok: false, reason }.
export const confirmSubscribe = async (stores, token, {
  now = clock(),
  env = process.env,
  mail = sendMail,
} = {}) => {
  if (!token || typeof token !== "string" || token.length > 200) {
    return { ok: false, reason: "invalid" };
  }

  const key = `news/${hash(token)}`;
  const found = await stores.auth.get(key);

  if (!found) return { ok: false, reason: "unknown" };

  await stores.auth.delete(key);

  if (now.getTime() > found.expires) return { ok: false, reason: "expired" };

  const sent = String(found.createdAt || "").slice(0, 10);
  const form = found.page ? `the sign-up form on ${found.page}`
    : "the sign-up form";
  const before = await getCustomer(stores, found.email);
  const customer = await optIn(stores, found.email, found.via === "form"
    ? {
      firstName: found.firstName, lastName: found.lastName,
      source: "signup",
      detail: `${form}, confirmed by the link sent ${sent}`,
    }
    : {
      firstName: found.firstName, lastName: found.lastName,
      source: "confirm",
      detail: `the confirmation link sent ${sent || "to the old list"}`,
    }, now);

  if (joined(before, customer)) {
    await welcome(stores, customer, { env, mail, now });
  }

  return { ok: true, email: customer.email };
};

// --- The old list --------------------------------------------------

// YYYY-MM-DD, a real day. -> noon UTC that day, which is the same day
// in the farm's zone, as an ISO time; or null.
const sheetDay = (value) => {
  const day = String(value || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;

  const at = new Date(`${day}T12:00:00.000Z`);

  return !Number.isNaN(at.getTime()) && at.toISOString().startsWith(day)
    ? at.toISOString() : null;
};

// The old list, imported as subscribed (James, #303): it signed up on
// the farm's paper sheets, which are the record of consent, so there
// is no confirmation round. Each consent is dated by its sheet (the
// row's `date`, else `date` here) and names its market (`market`), so
// the welcome can say "you signed up on our sign-up sheet at ...".
// `capturedBy` and `evidence` (a scan's file name) go in the log.
//
// Left alone: an address already consenting (skipped); one whose
// record has said no here, through Resend or by an unsubscribe link,
// which a sheet older than that choice can't overrule, or whose owner
// had their details deleted (declined); a bad address or a missing,
// unreal or future date (invalid). Each address joined gets the
// welcome, with its one-click unsubscribe; with `bin/nff --no-email`
// it is withheld and the address listed so. With `skip` (James,
// 2026-10-26) each is joined as ever but sent no welcome yet: the
// record is marked as owing one (`welcome`, see sendOwedWelcomes) and
// listed as held. Nothing reaches Resend from here: the next sync adds
// the contacts.
// -> { imported, skipped, declined, invalid, withheld, held }.
export const importSubscribers = async (stores, rows, {
  date = "",
  market = "",
  capturedBy = null,
  evidence = null,
  now = clock(),
  env = process.env,
  mail = sendMail,
  dryRun = false,
  skip = false,
} = {}) => {
  const report = {
    imported: [], skipped: [], declined: [], invalid: [], withheld: [],
    held: [],
  };

  for (const row of rows) {
    const address = normalizeEmail(row.email);
    const givenAt = sheetDay(row.date || date);

    if (!validEmail(address) || !givenAt
      || Date.parse(givenAt) > now.getTime()) {
      report.invalid.push(row.email);
      continue;
    }

    const existing = await getCustomer(stores, address);

    if (existing && existing.marketing === true) {
      report.skipped.push(address);
      continue;
    }
    if ((existing && existing.marketingAt)
      || await stores.customers.get(forgottenKey(address))) {
      report.declined.push(address);
      continue;
    }

    report.imported.push(address);
    if (skip) report.held.push(address);
    if (dryRun) continue;

    const customer = await optIn(stores, address, {
      firstName: text(row.firstName), lastName: text(row.lastName),
      source: "import",
      detail: text(row.market || market, 100),
      capturedBy: capturedBy || null,
      evidence: evidence || null,
      givenAt,
    }, now);

    if (skip) {
      // The same consent write, so the log gets no second event.
      await saveCustomer(stores, {
        ...customer,
        welcome: {
          state: "owed", for: customer.marketingAt, at: now.toISOString(),
        },
      });
      continue;
    }
    if (customerEmailWithheld()) {
      report.withheld.push(address);
      continue;
    }
    await welcome(stores, customer, { env, mail, now });
  }

  return report;
};

// The welcomes an import with `skip` held back (James, 2026-10-26),
// sent later: every record that still owes one, or the one `email`.
// A held record carries `welcome: { state, for, at }`:
//
//   owed      imported, welcome not sent yet
//   sending   a send began and did not finish: a crash, or a send
//             whose outcome is not known
//   sent      done; nothing sends again
//
// `for` is the `marketingAt` the welcome is owed for. A record that has
// since opted out owes nothing (`optedOut`); one that opted out and in
// again, by any way on, was welcomed then, so its old debt is void
// (`superseded`). Both lose the mark.
//
// Each record is claimed (`sending`), sent with the welcome's own
// idempotency key, and marked `sent`, so a rerun after a crash never
// sends a record twice: a record left `sending` is listed as `unsure`
// and not sent, unless `email` names it, which sends it again under the
// same key (Resend answers a repeat of a key within a day with the
// first send). A send that fails is listed as `failed`. It goes back to
// `owed` only when it is known to have sent nothing (sentNothing: a
// refusal before any request, or a 4xx that is not a 409 or 429). A
// timeout, a 5xx, a 409 or a 429 may have been accepted, so the record
// stays `sending` and the next bulk run lists it `unsure`: a later run
// could otherwise send it a second time once the key's day is over. A
// record already `sent`, by this run or another, is never written
// over. Every step reads the record afresh and changes only its
// `welcome`, so an unsubscribe made meanwhile stands. `dryRun` lists
// who is `due` and changes nothing; `--no-email` (customerEmailWithheld)
// sends nothing and lists them `withheld`.
// -> { sent, due, failed, unsure, optedOut, superseded, withheld, none }.
export const sendOwedWelcomes = async (stores, {
  email = null,
  dryRun = false,
  now = clock(),
  env = process.env,
  mail = sendMail,
} = {}) => {
  const report = {
    sent: [], due: [], failed: [], unsure: [], optedOut: [],
    superseded: [], withheld: [], none: [],
  };
  const named = email ? normalizeEmail(email) : null;
  const holding = (c) => c && c.welcome && c.welcome.state !== "sent";
  const candidates = named
    ? [await getCustomer(stores, named)]
    : await allCustomers(stores);
  const owing = candidates.filter(holding)
    .sort((a, b) => a.email.localeCompare(b.email));

  if (named && !owing.length) report.none.push(named);

  const mark = (record, state) => saveCustomer(stores, {
    ...record, welcome: { ...record.welcome, state, at: now.toISOString() },
  });
  const clear = (record) => {
    const rest = { ...record };

    delete rest.welcome;

    return saveCustomer(stores, rest);
  };

  for (const held of owing) {
    // The list is a snapshot, and a send takes time.
    const customer = await getCustomer(stores, held.email);

    if (!holding(customer)) continue;
    if (customer.marketing !== true) {
      report.optedOut.push(customer.email);
      if (!dryRun) await clear(customer);
      continue;
    }
    if (customer.marketingAt !== customer.welcome.for) {
      report.superseded.push(customer.email);
      if (!dryRun) await clear(customer);
      continue;
    }
    if (customer.welcome.state === "sending" && !named) {
      report.unsure.push(customer.email);
      continue;
    }
    if (dryRun) {
      report.due.push(customer.email);
      continue;
    }
    if (customerEmailWithheld()) {
      report.withheld.push(customer.email);
      continue;
    }

    const claimed = await mark(customer, "sending");
    const result = await attemptWelcome(stores, claimed, { env, mail, now });
    // Read afresh: the record may have changed, or been forgotten, and
    // another run may have sent and marked it already.
    const fresh = await getCustomer(stores, customer.email);
    const state = fresh && fresh.welcome && fresh.welcome.state;

    if (result.ok) {
      if (state) await mark(fresh, "sent");
    } else if (result.nothing && state === "sending") {
      // Known to have sent nothing, and still ours: owed again. Any
      // other failure may have been accepted, so the record stays
      // `sending` (the next bulk run lists it `unsure`), and one
      // already `sent` is never written over.
      await mark(fresh, "owed");
    }
    (result.ok ? report.sent : report.failed).push(customer.email);
  }

  return report;
};

// What an import writes on a record it makes (optIn, then the held
// welcome). Any other field set, beyond the schema's defaults, is the
// person's own history: a sign-in, a group, details, an order.
const IMPORT_FIELDS = [
  "email", "name", "firstName", "lastName", "marketing", "marketingAt",
  "marketingSource", "createdAt", "consent", "welcome",
];
const blank = (value) => value === null || value === undefined
  || value === "" || (Array.isArray(value) && !value.length);
const importMade = (c) => c.createdAt === c.marketingAt
  && consentLog(c).length === 1
  && Object.entries(c).every(([key, value]) => IMPORT_FIELDS.includes(key)
    || (key in SCHEMA_DEFAULTS
      ? value === SCHEMA_DEFAULTS[key] : blank(value)));

// A stale or duplicate address the import brought in, taken out of our
// records before a sync adds it to Resend (#496). Not an unsubscribe:
// nothing is recorded as a decline (no forgottenKey), so a real person
// can still sign up later, and Resend is never called.
//
//   deleted   the record is the import's alone, with no orders, credit
//             or cart: it goes, held welcome and all, with any
//             unsubscribe link a welcome left
//   cleared   the record has more on it: it stays, and only what the
//             import wrote goes (`cleared` names it): its consent
//             (`marketing`, `marketingAt`, `marketingSource` and its
//             event in the log), while it is still the consent in force,
//             and a held `welcome`
//   none      no record, or nothing on it from the import
//
// `dryRun` reports and writes nothing. Each removal logs one line, with
// `by`, who ran it; the log hashes the address, as it does every one.
// -> { email, outcome, cleared, dryRun }.
export const removeImported = async (stores, email, {
  by = null, dryRun = false,
} = {}) => {
  const address = normalizeEmail(email);
  const customer = await getCustomer(stores, address);
  const report = { email: address, outcome: "none", cleared: [], dryRun };

  if (!customer) return report;

  const imported = customer.marketing === true
    && customer.marketingSource === "import";

  if (imported && importMade(customer)
    && !(await ordersFor(stores, address)).length
    && !await stores.customers.get(creditKey(address))
    && !await stores.customers.get(cartKey(address))) {
    report.outcome = "deleted";
  } else {
    if (imported) report.cleared.push("marketing");
    if (customer.welcome) report.cleared.push("welcome");
    if (report.cleared.length) report.outcome = "cleared";
  }
  if (dryRun || report.outcome === "none") return report;

  if (report.outcome === "deleted") {
    for (const { key } of await stores.auth.list("unsub/")) {
      const link = await stores.auth.get(key);

      if (link && normalizeEmail(link.email) === address) {
        await stores.auth.delete(key);
      }
    }
    await deleteCustomer(stores, address);
  } else {
    const rest = { ...customer };

    delete rest.welcome;
    if (imported) {
      // Back as it was before the import, which joins only a record
      // that never said yes or no: no consent, and no event for it.
      const events = consentLog(customer);
      const last = events[events.length - 1];

      rest.marketing = false;
      rest.marketingAt = null;
      delete rest.marketingSource;
      rest.consent = last && last.type === "market-sheet"
        && last.recordedAt === customer.marketingAt
        ? events.slice(0, -1) : events;
    }
    await saveCustomer(stores, rest);
  }
  log.info({
    event: "news.removed", outcome: report.outcome, by,
    record: address, cleared: report.cleared,
  });

  return report;
};

// A CSV of addresses: a header row naming email, first and last, and
// for the old list's sheets date and market (any order, any case) or,
// without one, email first then the names.
export const parseCsv = (content) => {
  const lines = String(content).split(/\r?\n/).map((l) => l.trim())
    .filter(Boolean);
  const cells = (line) => line.split(",").map((c) => c.trim()
    .replace(/^"(.*)"$/, "$1"));
  const rows = lines.map(cells);
  const header = rows[0] && rows[0].some((c) => /email/i.test(c))
    ? rows.shift().map((c) => c.toLowerCase())
    : null;
  const col = (name, fallback) => {
    if (!header) return fallback;
    const i = header.findIndex((h) => h.includes(name));

    return i === -1 ? -1 : i;
  };
  const e = col("email", 0);
  const f = col("first", 1);
  const l = col("last", 2);
  const d = col("date", -1);
  const m = col("market", -1);

  return rows.map((r) => ({
    email: e >= 0 ? r[e] || "" : "",
    firstName: f >= 0 ? r[f] || "" : "",
    lastName: l >= 0 ? r[l] || "" : "",
    date: d >= 0 ? r[d] || "" : "",
    market: m >= 0 ? r[m] || "" : "",
  }));
};

// --- The audience in Resend ----------------------------------------
//
// Resend names its contact fields first_name and last_name.
/* eslint-disable camelcase */

// Production only: elsewhere the audience counts as unconfigured, so
// every caller skips it, and the call itself refuses as a second lock.
export const audienceConfigured = (env = process.env) =>
  resendAllowed(env) && !!(env.RESEND_AUDIENCE_ID
    && (env.RESEND_AUDIENCE_KEY || env.RESEND_API_KEY));

const resend = async (env, fetchImpl, method, path, body) => {
  if (!resendAllowed(env)) throw new Error(resendRefusal(env));

  const res = await fetchImpl(`https://api.resend.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.RESEND_AUDIENCE_KEY || env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`Resend ${res.status} on ${method} ${path}: ${
      data.message || JSON.stringify(data)}`);
  }

  return data;
};

// Every contact in the audience. -> [{ id, email, first_name,
// last_name, unsubscribed }]
export const listContacts = async (env, fetchImpl = globalThis.fetch) =>
  (await resend(env, fetchImpl, "GET",
    `/audiences/${env.RESEND_AUDIENCE_ID}/contacts`)).data || [];

// Our records decide who is in; Resend decides who has left. A record
// consenting since it last left through Resend (resendLeftAt) overrides
// the unsubscribe there: they signed up again here. Otherwise the
// unsubscribe wins and the record is opted out, however recent its
// consent: with no time for the unsubscribe, it may be the newer choice
// (#234). A contact in Resend with no record, or with a
// record that never expressed a preference, is taken as consent
// given there (James adds people by hand). -> the report.
export const syncAudience = async (stores, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = clock(),
  pace = 550,
  dryRun = false,
} = {}) => {
  if (!audienceConfigured(env)) return { ok: false, reason: "unconfigured" };

  const id = env.RESEND_AUDIENCE_ID;
  const contacts = await listContacts(env, fetchImpl);
  const byEmail = new Map(contacts.map((c) => [normalizeEmail(c.email), c]));
  const report = {
    ok: true, at: now.toISOString(), dryRun,
    created: [], resubscribed: [], unsubscribed: [], optedOut: [],
    imported: [], forgotten: [],
  };
  const call = async (method, path, body) => {
    if (dryRun) return null;
    if (pace) await sleep(pace);

    return resend(env, fetchImpl, method, path, body);
  };
  const contactPath = (email) =>
    `/audiences/${id}/contacts/${encodeURIComponent(email)}`;

  for (const c of await allCustomers(stores)) {
    const email = normalizeEmail(c.email);
    const contact = byEmail.get(email);
    const consented = c.marketing === true;
    const changedAt = c.marketingAt ? Date.parse(c.marketingAt) : 0;
    const leftAt = c.resendLeftAt ? Date.parse(c.resendLeftAt) : 0;

    byEmail.delete(email);

    if (consented && !contact) {
      await call("POST", `/audiences/${id}/contacts`, {
        email,
        first_name: c.firstName || "",
        last_name: c.lastName || "",
        unsubscribed: false,
      });
      report.created.push(email);
    } else if (consented && contact.unsubscribed) {
      if (leftAt && changedAt > leftAt) {
        await call("PATCH", contactPath(email), { unsubscribed: false });
        report.resubscribed.push(email);
      } else {
        if (!dryRun) await resendLeft(stores, email, now.toISOString(), now);
        report.optedOut.push(email);
      }
    } else if (!consented && contact && !contact.unsubscribed) {
      if (c.marketingAt) {
        await call("PATCH", contactPath(email), { unsubscribed: true });
        report.unsubscribed.push(email);
      } else {
        if (!dryRun) {
          await optIn(stores, email, {
            firstName: contact.first_name, lastName: contact.last_name,
            source: "resend", detail: "found in the Resend audience",
          }, now);
        }
        report.imported.push(email);
      }
    }
  }

  for (const [email, contact] of byEmail) {
    if (await stores.customers.get(forgottenKey(email))) {
      await call("DELETE", contactPath(email));
      if (!dryRun) await stores.customers.delete(forgottenKey(email));
      report.forgotten.push(email);
      continue;
    }
    if (contact.unsubscribed) continue;
    if (!dryRun) {
      await optIn(stores, email, {
        firstName: contact.first_name || "", lastName: contact.last_name || "",
        source: "resend", detail: "found in the Resend audience",
      }, now);
    }
    report.imported.push(email);
  }

  if (!dryRun) {
    await stores.jobs.set(SYNC_KEY, {
      at: now.toISOString(),
      created: report.created.length,
      resubscribed: report.resubscribed.length,
      unsubscribed: report.unsubscribed.length,
      optedOut: report.optedOut.length,
      imported: report.imported.length,
    });
  }
  log.info({
    event: "news.synced", dryRun,
    created: report.created.length, resubscribed: report.resubscribed.length,
    unsubscribed: report.unsubscribed.length, optedOut: report.optedOut.length,
    imported: report.imported.length,
  });

  return report;
};

// One contact moved to a new address with its name and its choice,
// for `bin/nff customers rename` (#238). Resend can't change a
// contact's email, so the new one is made and the old one deleted;
// where the new address is already a contact, that one stays as it
// is. Left behind, the old contact would come back in the next sync
// as a sign-up. -> "moved", "none" or "unconfigured"; with `apply`
// false nothing is written.
export const moveContact = async (from, to, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  apply = false,
} = {}) => {
  if (!audienceConfigured(env)) return "unconfigured";

  const id = env.RESEND_AUDIENCE_ID;
  const contacts = await listContacts(env, fetchImpl);
  const find = (email) =>
    contacts.find((c) => normalizeEmail(c.email) === email);
  const old = find(from);

  if (!old) return "none";
  if (apply) {
    if (!find(to)) {
      await resend(env, fetchImpl, "POST", `/audiences/${id}/contacts`, {
        email: to,
        first_name: old.first_name || "",
        last_name: old.last_name || "",
        unsubscribed: !!old.unsubscribed,
      });
    }
    await resend(env, fetchImpl, "DELETE",
      `/audiences/${id}/contacts/${encodeURIComponent(from)}`);
  }

  return "moved";
};

// One contact deleted, for a customer who deleted their details
// (#189). -> "removed", "none" or "unconfigured"; with `apply` false
// nothing is written.
export const removeContact = async (email, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  apply = false,
} = {}) => {
  if (!audienceConfigured(env)) return "unconfigured";

  const address = normalizeEmail(email);
  const found = (await listContacts(env, fetchImpl))
    .find((c) => normalizeEmail(c.email) === address);

  if (!found) return "none";
  if (apply) {
    await resend(env, fetchImpl, "DELETE", `/audiences/${
      env.RESEND_AUDIENCE_ID}/contacts/${encodeURIComponent(address)}`);
  }

  return "removed";
};

// A deletion that could not reach Resend leaves this marker, the
// address hashed, so the daily sync deletes the contact instead of
// taking it for a sign-up and making a new record.
export const forgottenKey = (email) =>
  `forgotten/${hash(normalizeEmail(email))}`;
