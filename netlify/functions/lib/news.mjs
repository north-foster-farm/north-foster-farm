// Farm news by email: opt-in only, ever. Consent is `marketing` and
// `marketingAt` on the customer record, set by the sign-up field, the
// checkout box, the settings box, or the confirmation link this file
// mails to the old list. A sign-up on the site joins at once; only
// the old list is asked to confirm (James, W1, 2026-09-26). Anyone
// with an email address may opt in; a record is made for an address
// that has never ordered.
//
// The list itself lives in Resend (a segment of its contacts), so
// broadcasts go out with Resend's unsubscribe link. syncAudience keeps
// the two in step: our record decides who is in, Resend decides who
// has left.

import { createHash, randomBytes } from "node:crypto";

import { normalizeEmail, validEmail } from "./auth.mjs";
import { log } from "./log.mjs";
import { sendMail } from "./mail.mjs";
import { allCustomers, getCustomer, saveCustomer } from "./records.mjs";
import { mailLinks, siteUrl } from "./site.mjs";
import { deployContext } from "./store.mjs";
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
// none. A record that already says yes is returned untouched.
export const optIn = async (stores, email, {
  firstName = "", lastName = "", source = "site",
} = {}, now = new Date()) => {
  const address = normalizeEmail(email);
  const at = now.toISOString();
  const existing = await getCustomer(stores, address);

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
    });
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
  });
};

// Consent withdrawn, dated. Nothing happens to a record that never
// said yes.
export const optOut = async (stores, email, { source = "site" } = {},
  now = new Date()) => {
  const existing = await getCustomer(stores, normalizeEmail(email));

  if (!existing || existing.marketing !== true) return existing || null;

  return saveCustomer(stores, {
    ...existing,
    marketing: false,
    marketingAt: now.toISOString(),
    marketingSource: source,
  });
};

// Left through Resend (its unsubscribe link, or deleted there), at `at`,
// the time Resend gives the change. The time is kept as resendLeftAt,
// so the sync can tell a sign-up here made since from one the
// unsubscribe overrules (#234). A consent here newer than the event (a
// late redelivery) stands.
export const resendLeft = async (stores, email, at, now = new Date()) => {
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

  return optOut(stores, existing.email, { source: "resend" }, now);
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
  env = process.env, now = new Date(),
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
export const unsubscribe = async (stores, token, { now = new Date() } = {}) => {
  if (!token || typeof token !== "string" || token.length > 200) {
    return { ok: false, reason: "invalid" };
  }

  const found = await stores.auth.get(`unsub/${hash(token)}`);

  if (!found) return { ok: false, reason: "unknown" };
  await optOut(stores, found.email, { source: "unsubscribe" }, now);

  return { ok: true, email: found.email };
};

// True when a change put an address on the list that wasn't on it.
export const joined = (before, after) => !!after
  && after.marketing === true && !(before && before.marketing === true);

// The welcome (T6), to a record just put on the list from the site: the
// news field, account settings, or the order box once the order is
// placed. Never throws; a welcome that fails leaves them on the list.
// -> true when it went.
export const welcome = async (stores, customer, {
  env = process.env, mail = sendMail, now = new Date(),
} = {}) => {
  try {
    const links = await unsubscribeLinks(stores, customer.email, { env, now });

    await mail({
      to: customer.email,
      idempotencyKey: `welcome-${
        hash(`${customer.email} ${customer.marketingAt}`).slice(0, 16)}`,
      headers: {
        "List-Unsubscribe": `<${links.post}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      ...newsWelcome(customer, links.page, { links: mailLinks(env) }),
    }, { env });

    return true;
  } catch (error) {
    log.error({ event: "news.welcome.failed", error: error.message });

    return false;
  }
};

// Per address, like sign-in. -> true when this request may go on.
const withinRate = async (stores, address, now) => {
  const rateKey = `rate/news/${address}`;
  const rate = (await stores.auth.get(rateKey)) || { times: [] };
  const recent = rate.times.filter((t) => now.getTime() - t < REQUEST_WINDOW);

  if (recent.length >= REQUESTS_PER_WINDOW) return false;
  await stores.auth.set(rateKey, { times: [...recent, now.getTime()] });

  return true;
};

// --- Signing up on the site ----------------------------------------

// The footer and news-page field: on the list at once (W1), then the
// welcome (T6). -> { ok: true, email } or { ok: false, reason }.
export const subscribe = async (stores, { email, firstName, lastName }, {
  now = new Date(),
  limit = true,
  env = process.env,
  mail = sendMail,
} = {}) => {
  const address = normalizeEmail(email);

  if (!validEmail(address)) return { ok: false, reason: "invalid" };
  if (limit && !(await withinRate(stores, address, now))) {
    return { ok: false, reason: "rate" };
  }

  const before = await getCustomer(stores, address);
  const after = await optIn(stores, address, {
    firstName: text(firstName), lastName: text(lastName), source: "signup",
  }, now);

  if (joined(before, after)) await welcome(stores, after, { env, mail, now });

  return { ok: true, email: address };
};

// --- The confirmation link -----------------------------------------

// Mails the old list's one-click confirmation. The address is only
// added when that link is followed.
// -> { ok: true, url, email } or { ok: false, reason }.
export const requestSubscribe = async (stores, {
  email, firstName, lastName,
}, {
  now = new Date(),
  env = process.env,
  mail = sendMail,
  send = true,
  limit = true,
  ttl = CONFIRM_TTL,
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
    expires: now.getTime() + ttl,
    createdAt: now.toISOString(),
  });

  const url = `${siteUrl(env)}/api/news/confirm?token=${token}`;

  if (send) {
    await mail({
      to: address,
      idempotencyKey: `news-${hash(token).slice(0, 16)}`,
      ...newsConfirm(address, url, {
        days: Math.round(ttl / DAY), links: mailLinks(env),
      }),
    }, { env });
  }

  return { ok: true, url, email: address };
};

// The click. Single use; expired links are refused.
// -> { ok: true, email } or { ok: false, reason }.
export const confirmSubscribe = async (stores, token, {
  now = new Date(),
} = {}) => {
  if (!token || typeof token !== "string" || token.length > 200) {
    return { ok: false, reason: "invalid" };
  }

  const key = `news/${hash(token)}`;
  const found = await stores.auth.get(key);

  if (!found) return { ok: false, reason: "unknown" };

  await stores.auth.delete(key);

  if (now.getTime() > found.expires) return { ok: false, reason: "expired" };

  const customer = await optIn(stores, found.email, {
    firstName: found.firstName, lastName: found.lastName, source: "confirm",
  }, now);

  return { ok: true, email: customer.email };
};

// The re-opt-in of an existing list: the confirmation email to each
// address, once. Addresses already consenting are skipped, bad
// ones reported. -> { invited, skipped, invalid }.
export const inviteSubscribers = async (stores, rows, {
  now = new Date(),
  env = process.env,
  mail = sendMail,
  dryRun = false,
} = {}) => {
  const report = { invited: [], skipped: [], invalid: [] };

  for (const row of rows) {
    const address = normalizeEmail(row.email);

    if (!validEmail(address)) {
      report.invalid.push(row.email);
      continue;
    }

    const existing = await getCustomer(stores, address);

    if (existing && existing.marketing === true) {
      report.skipped.push(address);
      continue;
    }
    if (!dryRun) {
      await requestSubscribe(stores, {
        email: address, firstName: row.firstName, lastName: row.lastName,
      }, { now, env, mail, limit: false });
    }
    report.invited.push(address);
  }

  return report;
};

// A CSV of addresses: a header row naming email, first and last (any
// order, any case) or, without one, email first then the names.
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

  return rows.map((r) => ({
    email: e >= 0 ? r[e] || "" : "",
    firstName: f >= 0 ? r[f] || "" : "",
    lastName: l >= 0 ? r[l] || "" : "",
  }));
};

// --- The segment in Resend -----------------------------------------
//
// Resend's contacts belong to the account, not to a list: the farm-news
// list is a segment of them (#148). One account serves every
// environment, so a contact may already exist, in another deploy's
// segment or none. Its `unsubscribed` flag is the account's too.
// Resend names its contact fields first_name and last_name.
/* eslint-disable camelcase */

// RESEND_SEGMENT_ID, or the audience id it replaced: Resend kept each
// audience's id for the segment made from it.
export const segmentId = (env = process.env) =>
  env.RESEND_SEGMENT_ID || env.RESEND_AUDIENCE_ID || "";

export const audienceConfigured = (env = process.env) =>
  !!(segmentId(env) && (env.RESEND_AUDIENCE_KEY || env.RESEND_API_KEY));

export const PAGE_SIZE = 100;

const resend = async (env, fetchImpl, method, path, body) => {
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
    throw Object.assign(new Error(`Resend ${res.status} on ${method} ${
      path}: ${data.message || JSON.stringify(data)}`), { status: res.status });
  }

  return data;
};

// Resend allows two calls a second: `read` and `send` wait `pace` ms
// between calls. On a dry run `send` makes no call; reads still do.
const client = (env, fetchImpl, { pace = 550, dryRun = false } = {}) => {
  let first = true;
  const paced = async () => {
    if (pace && !first) await sleep(pace);
    first = false;
  };

  return {
    read: async (path) => {
      await paced();

      return resend(env, fetchImpl, "GET", path);
    },
    send: async (method, path, body) => {
      if (dryRun) return null;
      await paced();

      return resend(env, fetchImpl, method, path, body);
    },
  };
};

const contactPath = (email) => `/contacts/${encodeURIComponent(email)}`;

// Every contact in the segment, a page of PAGE_SIZE at a time.
// `read` makes each call, so the sync can pace them.
// -> [{ id, email, first_name, last_name, unsubscribed }]
export const listContacts = async (env, fetchImpl = globalThis.fetch, {
  read = (path) => resend(env, fetchImpl, "GET", path),
} = {}) => {
  const contacts = [];
  let after = "";

  for (;;) {
    const page = await read(`/segments/${segmentId(env)}/contacts?limit=${
      PAGE_SIZE}${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    const data = page.data || [];

    contacts.push(...data);
    if (!page.has_more || !data.length) return contacts;
    after = data[data.length - 1].id;
  }
};

// The account's contact at an address, in any segment or none; null
// when there is none.
const findContact = async (read, email) => {
  try {
    return await read(contactPath(email));
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
};

// The address into the segment: a new contact, or one the account
// already has, which keeps its own `unsubscribed`. `read` and `send`
// make the calls. -> the existing contact, or null when one was made.
const addContact = async (env, email, fields, { read, send }) => {
  const id = segmentId(env);
  const existing = await findContact(read, email);

  if (existing) {
    await send("POST", `${contactPath(email)}/segments/${id}`);
  } else {
    await send("POST", "/contacts", { email, ...fields, segments: [{ id }] });
  }

  return existing;
};

// Our records decide who is in; Resend decides who has left. A record
// consenting since it last left through Resend (resendLeftAt) overrides
// the unsubscribe there: they signed up again here. So does one whose
// contact was outside the segment until now: the unsubscribe was made
// before this list knew them, and the sign-up here is the newer word.
// Otherwise the unsubscribe wins and the record is opted out, however
// recent its consent: with no time for the unsubscribe, it may be the
// newer choice (#234). A contact in Resend with no record, or with a
// record that never expressed a preference, is taken as consent
// given there (James adds people by hand).
//
// The `unsubscribed` flag is the account's, shared by every deploy, so
// only production changes it. Elsewhere the change is reported under
// `held`, as on a dry run: a staging sync must never undo an
// unsubscribe from a production email, or opt production's reader out.
// Opting out its own record, which touches nothing in Resend, it still
// does. -> the report.
export const syncAudience = async (stores, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  pace = 550,
  dryRun = false,
} = {}) => {
  if (!audienceConfigured(env)) return { ok: false, reason: "unconfigured" };

  const { read, send } = client(env, fetchImpl, { pace, dryRun });
  const flags = deployContext(env) === "production";
  const contacts = await listContacts(env, fetchImpl, { read });
  const byEmail = new Map(contacts.map((c) => [normalizeEmail(c.email), c]));
  const report = {
    ok: true, at: now.toISOString(), dryRun, flags,
    created: [], resubscribed: [], unsubscribed: [], optedOut: [],
    imported: [], held: [],
  };
  // The flag written, or held where this deploy may not write it.
  const flag = async (email, unsubscribed, list) => {
    if (!flags) {
      report.held.push({ email, unsubscribed });
      return;
    }
    await send("PATCH", contactPath(email), { unsubscribed });
    list.push(email);
  };

  for (const c of await allCustomers(stores)) {
    const email = normalizeEmail(c.email);
    let contact = byEmail.get(email);
    const inSegment = !!contact;
    const consented = c.marketing === true;
    const changedAt = c.marketingAt ? Date.parse(c.marketingAt) : 0;
    const leftAt = c.resendLeftAt ? Date.parse(c.resendLeftAt) : 0;

    byEmail.delete(email);

    // Into the segment. A contact the account already had keeps its
    // flag, and an unsubscribe on it is weighed below.
    if (consented && !contact) {
      contact = await addContact(env, email, {
        first_name: c.firstName || "",
        last_name: c.lastName || "",
        unsubscribed: false,
      }, { read, send });
      report.created.push(email);
    }

    if (consented && contact && contact.unsubscribed) {
      if (!inSegment || (leftAt && changedAt > leftAt)) {
        await flag(email, false, report.resubscribed);
      } else {
        if (!dryRun) await resendLeft(stores, email, now.toISOString(), now);
        report.optedOut.push(email);
      }
    } else if (!consented && contact && !contact.unsubscribed) {
      if (c.marketingAt) {
        await flag(email, true, report.unsubscribed);
      } else {
        if (!dryRun) {
          await optIn(stores, email, {
            firstName: contact.first_name, lastName: contact.last_name,
            source: "resend",
          }, now);
        }
        report.imported.push(email);
      }
    }
  }

  for (const [email, contact] of byEmail) {
    if (contact.unsubscribed) continue;
    if (!dryRun) {
      await optIn(stores, email, {
        firstName: contact.first_name || "", lastName: contact.last_name || "",
        source: "resend",
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
      held: report.held.length,
    });
  }
  log.info({
    event: "news.synced", dryRun,
    created: report.created.length, resubscribed: report.resubscribed.length,
    unsubscribed: report.unsubscribed.length, optedOut: report.optedOut.length,
    imported: report.imported.length, held: report.held.length,
  });

  return report;
};

// One contact moved to a new address with its name and its choice,
// for `bin/nff customers rename` (#238). Resend can't change a
// contact's email, so the new one joins the segment and the old one
// leaves it; where the new address is already a contact, that one
// keeps its own choice. The old contact is not deleted: other deploys'
// segments may hold it. Left in this one, it would come back in the
// next sync as a sign-up. The calls are paced like the sync's, so a
// rate limit can't stop it halfway. -> "moved", "none" or
// "unconfigured"; with `apply` false nothing is written.
export const moveContact = async (from, to, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  apply = false,
  pace = 550,
} = {}) => {
  if (!audienceConfigured(env)) return "unconfigured";

  const { read, send } = client(env, fetchImpl, { pace, dryRun: !apply });
  const contacts = await listContacts(env, fetchImpl, { read });
  const find = (email) =>
    contacts.find((c) => normalizeEmail(c.email) === email);
  const old = find(from);

  if (!old) return "none";
  if (apply) {
    if (!find(to)) {
      await addContact(env, to, {
        first_name: old.first_name || "",
        last_name: old.last_name || "",
        unsubscribed: !!old.unsubscribed,
      }, { read, send });
    }
    await send("DELETE", `${contactPath(from)}/segments/${segmentId(env)}`);
  }

  return "moved";
};
