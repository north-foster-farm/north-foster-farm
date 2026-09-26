// Farm news by email: opt-in only, ever. Consent is `marketing` and
// `marketingAt` on the customer record, set by the checkout box, the
// settings box, or the confirmation link this file sends. Anyone with
// an email address may opt in; a record is made for an address that
// has never ordered.
//
// The list itself lives in Resend (an audience), so broadcasts go out
// with Resend's unsubscribe link. syncAudience keeps the two in step:
// our record decides who is in, Resend decides who has left.

import { createHash, randomBytes } from "node:crypto";

import { normalizeEmail, validEmail } from "./auth.mjs";
import { log } from "./log.mjs";
import { sendMail } from "./mail.mjs";
import { allCustomers, getCustomer, saveCustomer } from "./records.mjs";
import { mailLinks, siteUrl } from "./site.mjs";
import { newsConfirm } from "./templates.mjs";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export const CONFIRM_TTL = 7 * DAY;
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

// --- The confirmation link -----------------------------------------

// Mails the one-click confirmation. The address is only ever added
// when that link is followed. Rate-limited per address like sign-in.
// -> { ok: true, url, email } or { ok: false, reason }.
export const requestSubscribe = async (stores, {
  email, firstName, lastName,
}, {
  now = new Date(),
  env = process.env,
  mail = sendMail,
  send = true,
  limit = true,
  invited = false,
  ttl = CONFIRM_TTL,
} = {}) => {
  const address = normalizeEmail(email);

  if (!validEmail(address)) return { ok: false, reason: "invalid" };

  if (limit) {
    const rateKey = `rate/news/${address}`;
    const rate = (await stores.auth.get(rateKey)) || { times: [] };
    const recent = rate.times.filter((t) => now.getTime() - t < REQUEST_WINDOW);

    if (recent.length >= REQUESTS_PER_WINDOW) {
      return { ok: false, reason: "rate" };
    }
    await stores.auth.set(rateKey, { times: [...recent, now.getTime()] });
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
        days: Math.round(ttl / DAY), invited, links: mailLinks(env),
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

// The re-opt-in of an existing list: the same confirmation email to
// each address, once. Addresses already consenting are skipped, bad
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
      }, { now, env, mail, limit: false, invited: true });
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

// --- The audience in Resend ----------------------------------------
//
// Resend names its contact fields first_name and last_name.
/* eslint-disable camelcase */

export const audienceConfigured = (env = process.env) =>
  !!(env.RESEND_AUDIENCE_ID && (env.RESEND_AUDIENCE_KEY || env.RESEND_API_KEY));

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
// consenting after the last sync overrides an unsubscribe in Resend
// (they signed up again here); otherwise the unsubscribe wins and the
// record is opted out. A contact in Resend with no record, or with a
// record that never expressed a preference, is taken as consent
// given there (James adds people by hand). -> the report.
export const syncAudience = async (stores, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  pace = 550,
  dryRun = false,
} = {}) => {
  if (!audienceConfigured(env)) return { ok: false, reason: "unconfigured" };

  const id = env.RESEND_AUDIENCE_ID;
  const mark = (await stores.jobs.get(SYNC_KEY)) || { at: null };
  const since = mark.at ? Date.parse(mark.at) : 0;
  const contacts = await listContacts(env, fetchImpl);
  const byEmail = new Map(contacts.map((c) => [normalizeEmail(c.email), c]));
  const report = {
    ok: true, at: now.toISOString(), dryRun,
    created: [], resubscribed: [], unsubscribed: [], optedOut: [],
    imported: [],
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
      if (changedAt > since) {
        await call("PATCH", contactPath(email), { unsubscribed: false });
        report.resubscribed.push(email);
      } else {
        if (!dryRun) await optOut(stores, email, { source: "resend" }, now);
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
