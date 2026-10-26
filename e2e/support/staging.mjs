// The staging deploy's back office, for setup, assertions and
// teardown: the outbox (every email the deploy would have sent), the
// records, the contact messages and the maintenance switch.
//
// All of it goes through POST /api/staging/e2e with E2E_STAGING_TOKEN,
// a token of the suite's own that opens nothing else (netlify/functions
// lib/e2e.mjs). The deploy reaches its own stores. No Netlify personal
// access token and no Blobs credentials are in this suite's hands
// (#266). Nothing here can reach production: the endpoint answers only
// on a non-production deploy.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MACHINE_COOKIE } from "../../netlify/functions/lib/gate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

// The process's own variables win, then `.env.e2e-staging`, a file of
// the suite's few values (E2E_STAGING_TOKEN and what a spec signs with).
// `.env.staging`, the CLI's file with the Netlify token in it, is never
// read here.
const env = {
  ...readEnv(join(root, ".env.e2e-staging")),
  ...process.env,
};

// One value of that environment, for the specs that sign or log in as
// the deploy's own secrets would (the maintenance rehearsal).
export const stagingEnv = (name) => env[name] || "";

// Forget the visitor's cookies, the way a signed-out browser does,
// but keep the staging gate's machine cookie: clearing it too sends
// the next request to the gate's sign-in page, not to the site.
export const clearSession = async (context) => {
  await context.clearCookies();

  const host = new URL(BASE_URL).hostname;

  if (env.E2E_STAGING_TOKEN && host.includes("--")) {
    await context.addCookies([{
      name: MACHINE_COOKIE, value: env.E2E_STAGING_TOKEN, domain: host,
      path: "/", httpOnly: true, secure: true, sameSite: "Lax",
    }]);
  }
};

// Whether the back office can be reached from here.
export const backOffice = () => ({ ready: !!env.E2E_STAGING_TOKEN });

// Off production, X-Staging-Token skips the /api/orders rate limit
// (docs/staging.md, "The order limit"), so the suite leaves the limit
// to a person testing by hand from the same machine. Empty without the
// token, and never sent where the limit itself is tested.
export const orderLimitHeaders = () => (
  env.E2E_STAGING_TOKEN ? { "X-Staging-Token": env.E2E_STAGING_TOKEN } : {}
);

export const BACK_OFFICE_MISSING = "Needs E2E_STAGING_TOKEN, in the " +
  "environment or in .env.e2e-staging in the checkout root.";

// Netlify Blobs answers a 502 now and then; one of those should not
// strand a paid test order, so a call is retried on it.
const TRANSIENT = new Set([502, 503, 504]);

// One op on the deploy -> its answer. Throws with the deploy's message
// unless `allowFail`, which answers null.
export const op = async (name, args = {}, {
  allowFail = false, tries = 3,
} = {}) => {
  for (let attempt = 1; ; attempt += 1) {
    let res;

    try {
      res = await fetch(`${BASE_URL}/api/staging/e2e`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.E2E_STAGING_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ op: name, ...args }),
      });
    } catch (error) {
      if (attempt < tries) {
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
        continue;
      }
      if (allowFail) return null;
      throw new Error(`e2e ${name}: ${error.message}`, { cause: error });
    }

    if (res.ok) return res.json();
    if (attempt < tries && TRANSIENT.has(res.status)) {
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
      continue;
    }
    if (allowFail) return null;

    const detail = await res.text();

    throw new Error(`e2e ${name}: ${res.status} ${detail}`);
  }
};

// Outbox ids start with the send time, colons and dots made dashes.
const idAt = (date) => date.toISOString().replace(/[:.]/g, "-");

const toList = (to) => (Array.isArray(to) ? to : [to]).map(
  (a) => String(a).toLowerCase()
);

// Every message since `since` (a Date), oldest first, with its body.
export const outbox = async ({ since = new Date(0) } = {}) => {
  const floor = idAt(since);
  const { messages } = await op("outboxList");

  return messages.filter((m) => m.id >= floor).reverse();
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
// contains `subject`, sent since `since` (a Date). -> how many.
export const clearMail = async ({ to, subject, since } = {}) =>
  (await op("outboxClear", {
    to, subject, floor: since ? idAt(since) : undefined,
  })).removed;

// The first link in an email whose text or href matches `pattern`.
export const linkIn = (message, pattern) => {
  const hrefs = [...message.html.matchAll(/href="([^"]+)"/g)]
    .map((m) => m[1].replace(/&amp;/g, "&"));

  return hrefs.find((href) => pattern.test(href)) || null;
};

// A few things the specs did through the CLI, answered in its words:
// `nff(["orders", "list", "--email=a@b.c"])`, `["orders", "show", id]`
// (JSON), `["orders", "refund", id, "--amount-cents=500"]`, `["orders",
// "cancel", id, "--no-refund"]`, `["login", email]` (the link) and
// `["maintenance", "on"|"off"|"status"|"links"]`, and the rest of the
// forms in `FORMS` below. A form not listed throws, so a spec cannot
// quietly reach for more.
const flag = (args, name) => (args.find((a) => a.startsWith(`--${name}=`))
  || "").slice(name.length + 3);

const FORMS = {
  "orders list": async (args) => {
    const { orders } = await op("ordersList", { email: flag(args, "email") });

    return orders.length
      ? orders.map((o) => `${o.id}  ${o.status}`).join("\n")
      : "No orders.";
  },
  "orders show": async ([, , id]) =>
    JSON.stringify((await op("orderShow", { id })).order),
  "orders cancel": async ([, , id, ...rest]) => {
    await op("orderCancel", {
      id, reasonText: flag(rest, "reason-text"),
      refund: !rest.includes("--no-refund"),
    });

    return `Canceled ${id}.`;
  },
  "orders refund": async ([, , id, ...rest]) => {
    const cents = flag(rest, "amount-cents");

    await op("orderRefund", {
      id, reason: flag(rest, "reason"),
      ...(cents && { amount: Number(cents) }),
    });

    return `Refunded ${id}.`;
  },
  "orders delete": async ([, , id]) => {
    await op("orderDelete", { id });

    return `Deleted ${id}.`;
  },
  "customers show": async ([, , email]) =>
    JSON.stringify(await op("customerShow", { email })),
  "customers delete": async ([, , email]) => {
    await op("customerDelete", { email });

    return `Deleted ${email}.`;
  },
  login: async ([, email]) => (await op("login", { email })).url,
  "maintenance status": async () => `Maintenance is ${
    (await op("maintenanceStatus")).on ? "ON" : "off"}.`,
  "maintenance on": async () => {
    await op("maintenanceSet", { on: true });

    return "Maintenance is now ON.";
  },
  "maintenance off": async () => {
    await op("maintenanceSet", { on: false });

    return "Maintenance is now off.";
  },
  "maintenance links": async () => {
    const { links } = await op("maintenanceLinks");

    if (!links) throw new Error("MAINTENANCE_SECRET is not set.");

    return `ON:  ${links.on}\nOFF: ${links.off}`;
  },
};

// -> stdout. Throws on failure unless `allowFail`, which answers "".
export const nff = async (args, { allowFail = false } = {}) => {
  const form = FORMS[args.slice(0, 2).join(" ")] || FORMS[args[0]];

  if (!form) throw new Error(`e2e nff: no such form: ${args.join(" ")}`);

  try {
    return await form(args);
  } catch (error) {
    if (allowFail) return "";
    throw new Error(`e2e ${args.join(" ")}: ${error.message}`, {
      cause: error,
    });
  }
};

export const orderRecord = async (id) =>
  JSON.parse(await nff(["orders", "show", id]));

// -> the customer record (`customers show` answers { customer, orders }),
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
    await nff(["orders", "cancel", id, "--reason-text=QA e2e"]);
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
// from one address.
export const contactMessages = async (email) =>
  (await op("messagesList", { email })).messages;

export const deleteContactMessages = async (email) => {
  await op("messagesDelete", { email });
};
