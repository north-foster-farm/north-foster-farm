// The mail seam. One function sends one message; the driver comes
// from the environment:
//
//   MAIL_DRIVER=resend   Resend's API. Needs RESEND_API_KEY and
//                        MAIL_FROM ("North Foster Farm <orders@...>").
//   MAIL_DRIVER=log      Writes the message to the function log and
//                        sends nothing. The default, so a preview or
//                        a checkout without credentials never emails
//                        a real customer.
//   MAIL_DRIVER=file     Writes each message as an .html and a .txt
//                        file under MAIL_OUT (default .ignored/outbox)
//                        and sends nothing. For reading, in a browser,
//                        what a local run of the CLI, the functions
//                        or the jobs would have sent.
//   MAIL_DRIVER=outbox   Writes each message to the jobs store under
//                        outbox/<id> and sends nothing. The staging
//                        toolbar reads them back (/api/staging/outbox).
//                        The last OUTBOX_KEEP are kept.
//
// ADMIN_EMAILS is a comma-separated list for farm-side notices.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stores as defaultStores } from "./store.mjs";

export const OUTBOX_PREFIX = "outbox/";
export const OUTBOX_KEEP = 200;

// Two messages in the same millisecond still list in the order sent.
let seq = 0;

export class MailError extends Error {
  constructor(message, { retryable = false, status = 0, detail = null } = {}) {
    super(message);
    this.name = "MailError";
    this.retryable = retryable;
    this.status = status;
    this.detail = detail;
  }
}

export const mailConfigured = (env = process.env) =>
  env.MAIL_DRIVER === "resend" && !!env.RESEND_API_KEY && !!env.MAIL_FROM;

export const adminEmails = (env = process.env) =>
  String(env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const viaResend = async (message, env, fetchImpl) => {
  let res;

  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: Array.isArray(message.to) ? message.to : [message.to],
        "reply_to": message.replyTo || env.MAIL_REPLY_TO || undefined,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: message.idempotencyKey
          ? { "X-Entity-Ref-ID": message.idempotencyKey }
          : undefined,
      }),
    });
  } catch (error) {
    throw new MailError("Network error calling Resend", {
      retryable: true, detail: String(error),
    });
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new MailError(`Resend ${res.status}`, {
      retryable: res.status === 429 || res.status >= 500,
      status: res.status,
      detail: data,
    });
  }

  return { id: data.id || null, driver: "resend" };
};

const viaLog = async (message) => {
  console.info(JSON.stringify({
    event: "mail.logged",
    to: message.to,
    subject: message.subject,
    text: message.text,
  }));

  return { id: null, driver: "log" };
};

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "").slice(0, 50);

// One .html and one .txt per message, named by time and subject, so
// a directory listing reads as an inbox.
export const viaFile = async (message, env, now = new Date()) => {
  const dir = env.MAIL_OUT || ".ignored/outbox";
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = `${stamp}-${slug(message.subject)}`;
  const to = Array.isArray(message.to) ? message.to.join(", ") : message.to;

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${base}.html`), message.html || "");
  writeFileSync(join(dir, `${base}.txt`),
    `To: ${to}\n${message.replyTo ? `Reply-To: ${message.replyTo}\n` : ""}` +
    `Subject: ${message.subject}\n\n${message.text}\n`);
  console.info(JSON.stringify({
    event: "mail.filed", to: message.to, subject: message.subject,
    file: join(dir, `${base}.html`),
  }));

  return { id: base, driver: "file" };
};

// One document per message, keyed by time so a listing is an inbox;
// the oldest go once there are more than OUTBOX_KEEP.
export const viaOutbox = async (message, env, stores, now = new Date()) => {
  const { jobs } = stores || defaultStores(env);
  seq += 1;

  const id = `${now.toISOString().replace(/[:.]/g, "-")}-${
    String(seq).padStart(4, "0")}`;

  await jobs.set(`${OUTBOX_PREFIX}${id}`, {
    id,
    at: now.toISOString(),
    to: message.to,
    replyTo: message.replyTo || null,
    subject: message.subject,
    text: message.text || "",
    html: message.html || "",
  });

  const keys = (await jobs.list(OUTBOX_PREFIX)).map((k) => k.key);

  for (const key of keys.slice(0, Math.max(0, keys.length - OUTBOX_KEEP))) {
    await jobs.delete(key);
  }
  console.info(JSON.stringify({
    event: "mail.outboxed", to: message.to, subject: message.subject, id,
  }));

  return { id, driver: "outbox" };
};

// The message is { to, subject, text, html, idempotencyKey?, replyTo? }.
// `replyTo` overrides MAIL_REPLY_TO for one message, so the farm
// answers a customer's note by replying to it.
export const sendMail = async (message, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  stores,
} = {}) => {
  if (!message.to || !message.subject) {
    throw new MailError("A message needs a recipient and a subject");
  }

  // The drivers that send nothing come first: they are safe under
  // test and are how staging and local runs read their mail.
  if (env.MAIL_DRIVER === "outbox") return viaOutbox(message, env, stores);
  if (env.MAIL_DRIVER === "file") return viaFile(message, env);

  // Under `node --test` (which sets NODE_TEST_CONTEXT) a real fetch is
  // a test reaching Resend: on 2026-09-22 the suite, run by the Netlify
  // build with the production variables, mailed the fixtures' notices
  // to the farm on every deploy. A test's own fake fetch still goes
  // through, so the Resend path stays testable.
  const live = fetchImpl === globalThis.fetch;

  if (process.env.NODE_TEST_CONTEXT && live) return viaLog(message);

  return mailConfigured(env)
    ? viaResend(message, env, fetchImpl)
    : viaLog(message);
};
