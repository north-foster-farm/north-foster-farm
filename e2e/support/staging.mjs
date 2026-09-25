// The staging deploy's back office, for setup, assertions and
// teardown: the outbox (every email the deploy would have sent) and
// the records, through `bin/nff --staging`.
//
// The outbox is read through /api/staging/outbox when STAGING_TOKEN is
// in the environment. Without it, it is read straight from the jobs
// store with the CLI's own credentials (NETLIFY_SITE_ID and
// NETLIFY_AUTH_TOKEN in `.env`), the same way `bin/nff --staging`
// reaches the orders. Nothing here can reach production: the store
// names carry the branch-deploy prefix and the CLI runs with
// --staging.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { OUTBOX_PREFIX } from "../../netlify/functions/lib/mail.mjs";
import { stores } from "../../netlify/functions/lib/store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const exec = promisify(execFile);

export const BASE_URL = process.env.E2E_BASE_URL
  || "https://staging--north-foster-farm.netlify.app";

// KEY=value lines, quotes stripped. Values are never printed.
const readEnv = (file) => {
  const out = {};

  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);

    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }

  return out;
};

// The process's own variables win, then .env.staging, then .env.
const env = {
  ...readEnv(join(root, ".env")),
  ...readEnv(join(root, ".env.staging")),
  ...process.env,
  SITE_CONTEXT: "branch-deploy",
};

// Whether the records and the outbox can be reached from here.
export const backOffice = () => ({
  cli: existsSync(join(root, ".env.staging"))
    && !!(env.NETLIFY_SITE_ID && env.NETLIFY_AUTH_TOKEN),
  outbox: !!env.STAGING_TOKEN
    || !!(env.NETLIFY_SITE_ID && env.NETLIFY_AUTH_TOKEN),
});

export const BACK_OFFICE_MISSING = "Needs .env and .env.staging in the " +
  "checkout root (the bin/nff --staging credentials), or STAGING_TOKEN " +
  "for the outbox.";

let jobsStore = null;

const jobs = () => {
  jobsStore = jobsStore || stores(env).jobs;

  return jobsStore;
};

// Outbox ids start with the send time, colons and dots made dashes.
const idAt = (date) => date.toISOString().replace(/[:.]/g, "-");

const toList = (to) => (Array.isArray(to) ? to : [to]).map(
  (a) => String(a).toLowerCase()
);

// Every message since `since` (a Date), oldest first, with its body.
export const outbox = async ({ since = new Date(0) } = {}) => {
  const floor = idAt(since);

  if (env.STAGING_TOKEN) {
    const headers = { Authorization: `Bearer ${env.STAGING_TOKEN}` };
    const res = await fetch(`${BASE_URL}/api/staging/outbox`, { headers });
    const { messages } = await res.json();
    const recent = messages.filter((m) => m.id >= floor).reverse();

    return Promise.all(recent.map(async (m) => {
      const one = `${BASE_URL}/api/staging/outbox/${encodeURIComponent(m.id)}`;
      const html = await (await fetch(one, { headers })).text();
      const text = await (await fetch(`${one}?format=text`, { headers }))
        .text();

      return { ...m, key: null, html, text };
    }));
  }

  const keys = (await jobs().list(OUTBOX_PREFIX))
    .map((k) => k.key)
    .filter((key) => key.slice(OUTBOX_PREFIX.length) >= floor);
  const found = await Promise.all(keys.map(async (key) => ({
    key, ...(await jobs().get(key)),
  })));

  return found.filter((m) => m.id);
};

// Waits for a message matching { to, subject } (a string to contain or
// a RegExp), sent since `since`. -> the message, or throws.
export const waitForMail = async ({
  to, subject, since, timeout = 45_000,
}) => {
  const wanted = to ? String(to).toLowerCase() : null;
  const matches = (m) => (!wanted || toList(m.to).includes(wanted))
    && (!subject || (subject instanceof RegExp
      ? subject.test(m.subject) : m.subject.includes(subject)));
  const end = Date.now() + timeout;

  while (Date.now() < end) {
    const hit = (await outbox({ since })).find(matches);

    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`No email to ${to} matching ${subject} within ${
    timeout / 1000}s`);
};

// Messages to an address since `since`, for asserting that nothing
// was sent.
export const mailTo = async (to, since) => {
  const wanted = String(to).toLowerCase();

  return (await outbox({ since })).filter(
    (m) => toList(m.to).includes(wanted)
  );
};

// Removes this run's messages: every one to `to`, or whose subject
// contains `subject`. Only possible with the store credentials; with
// the token alone the outbox can only be emptied whole, which would
// take other people's mail with it, so it is left.
export const clearMail = async ({ to, subject, since } = {}) => {
  if (env.STAGING_TOKEN && !(env.NETLIFY_SITE_ID && env.NETLIFY_AUTH_TOKEN)) {
    return 0;
  }

  const wanted = to ? String(to).toLowerCase() : null;
  let removed = 0;

  for (const m of await outbox({ since })) {
    const hit = (wanted && toList(m.to).includes(wanted))
      || (subject && m.subject.includes(subject));

    if (hit && m.key) {
      await jobs().delete(m.key);
      removed += 1;
    }
  }

  return removed;
};

// The first link in an email whose text or href matches `pattern`.
export const linkIn = (message, pattern) => {
  const hrefs = [...message.html.matchAll(/href="([^"]+)"/g)]
    .map((m) => m[1].replace(/&amp;/g, "&"));

  return hrefs.find((href) => pattern.test(href)) || null;
};

// Netlify Blobs answers a 502 now and then; one of those should not
// strand a paid test order, so the CLI is retried on it.
const TRANSIENT = /\b(502|503|504)\b|internal error|ECONNRESET|ETIMEDOUT/;

// `bin/nff --staging ...args` -> stdout. Throws with stderr on a
// non-zero exit unless `allowFail`.
export const nff = async (args, { allowFail = false, tries = 3 } = {}) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { stdout } = await exec(join(root, "bin", "nff"),
        ["--staging", ...args], { cwd: root, timeout: 90_000 });

      return stdout;
    } catch (error) {
      const detail = error.stderr || error.message;

      if (attempt < tries && TRANSIENT.test(detail)) {
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
        continue;
      }
      if (allowFail) return error.stdout || "";
      throw new Error(`bin/nff --staging ${args.join(" ")}: ${detail}`, {
        cause: error,
      });
    }
  }
};

export const orderRecord = async (id) =>
  JSON.parse(await nff(["orders", "show", id]));

// -> the customer record (`customers show` prints { customer, orders }),
// or null when there is none.
export const customerRecord = async (email) => {
  const out = await nff(["customers", "show", email], { allowFail: true });

  return out.trim().startsWith("{") ? JSON.parse(out).customer : null;
};

// Cancels a paid test order, refunds it in the sandbox (stock goes
// back with it) and deletes the record, so the next run starts clean.
// E2E_KEEP=1 keeps the cancelled record for inspection. Safe to call
// again on an order half closed: `--refund` sends back only what has
// not gone back yet. Reads both record shapes: `payments`/`refunds`
// lists since 2026-09-25, one `payment`/`refund` before.
export const closeOrder = async (id) => {
  const record = await orderRecord(id).catch(() => null);

  if (!record) return;

  const list = (many, one) => many || (one ? [one] : []);
  const sum = (items) => items.reduce((s, x) => s + (x.amount || 0), 0);
  const payments = list(record.payments, record.payment);
  const paid = record.payments ? sum(payments) : record.totals.total;
  const owed = payments.length
    ? paid - sum(list(record.refunds, record.refund))
    : 0;

  if (record.status === "paid") {
    await nff(["orders", "cancel", id, "--refund", "--reason=QA e2e"]);
  } else if (owed > 0) {
    await nff(["orders", "refund", id, "--reason=QA e2e"]);
  }
  if (!process.env.E2E_KEEP) await nff(["orders", "delete", id]);
  await clearMail({ subject: id });
};

// Runs every teardown step even when one fails, then reports them all.
export const teardown = async (steps) => {
  const failures = [];

  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error.message);
    }
  }
  if (failures.length) {
    throw new Error(`Teardown left staging dirty:\n${failures.join("\n")}`);
  }
};

export const deleteCustomer = (email) =>
  nff(["customers", "delete", email], { allowFail: true });

// The contact page's messages (messages/<id> in the customers store)
// from one address. The CLI has no messages command yet (#167), so
// they are read and removed with its credentials, like the outbox.
export const contactMessages = async (email) => {
  const wanted = String(email).toLowerCase();
  const customers = stores(env).customers;
  const keys = (await customers.list("messages/")).map((k) => k.key);
  const found = await Promise.all(keys.map(async (key) => ({
    key, ...(await customers.get(key)),
  })));

  return found.filter((m) => m.email === wanted);
};

export const deleteContactMessages = async (email) => {
  const customers = stores(env).customers;

  for (const m of await contactMessages(email)) await customers.delete(m.key);
};
