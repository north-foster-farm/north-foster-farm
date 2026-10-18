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
// Three comma-separated lists, and each message goes to one:
//   FARM_NOTIFICATIONS_EMAIL       the farm's: new orders, contact
//                                  messages, the daily reports.
//   DEV_NOTIFICATIONS_EMAIL        the developer's: every alert,
//                                  with no fallback.
//   ESCALATED_NOTIFICATIONS_EMAIL  one emergency only (escalate in
//                                  lib/health.mjs); nothing else.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { guard, recordSend } from "./breaker.mjs";
import { timedFetch } from "./http.mjs";
import { resendAllowed, resendRefusal } from "./resend-guard.mjs";
import { stores as defaultStores } from "./store.mjs";

export const OUTBOX_PREFIX = "outbox/";
// A note of each keyed message, so the same key is not outboxed twice.
const OUTBOX_KEYS = "outbox-key/";
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

const addresses = (value) =>
  String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// The farm's own notices: each new order, contact-form messages, the
// daily reports.
export const farmEmails = (env = process.env) =>
  addresses(env.FARM_NOTIFICATIONS_EMAIL);

// The developer's notices (alerts, rotations, security, failed jobs).
// Unset means nobody: there is no fallback to the farm's address.
export const devEmails = (env = process.env) =>
  addresses(env.DEV_NOTIFICATIONS_EMAIL);

// The one emergency the farm's partner hears of; `escalate` in
// lib/health.mjs is the only caller.
export const escalatedEmails = (env = process.env) =>
  addresses(env.ESCALATED_NOTIFICATIONS_EMAIL);

export const NAME_MAX = 64;

// Up to 45 bytes a word keeps each encoded word within RFC 2047's 75.
const encodedWords = (name) => {
  const words = [];
  let chunk = "";

  for (const ch of name) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  words.push(chunk);

  return words.map((w) =>
    `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join(" ");
};

// "Name <email>" for a header, from a name a customer typed: control
// characters and line breaks go (no header injection), whitespace
// collapses, and the name is capped. ASCII becomes an RFC 5322 quoted
// string with " and \ escaped; anything else RFC 2047 encoded words,
// so no driver or provider has to encode it. No name, the bare address.
export const mailbox = (name, email) => {
  const clean = [...String(name || "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()]
    .slice(0, NAME_MAX)
    .join("")
    .trim();

  if (!clean) return email;

  const display = /^[\x20-\x7e]*$/.test(clean)
    ? `"${clean.replace(/[\\"]/g, "\\$&")}"`
    : encodedWords(clean);

  return `${display} <${email}>`;
};

// Resend answers in a second; one that takes longer is not waited for
// (an alert sent from the order path must not eat the request).
export const RESEND_MS = 4000;

const viaResend = async (message, env, fetchImpl) => {
  const res = await timedFetch(fetchImpl, "https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      // Resend answers the same key within 24 h with the first send's
      // response and sends nothing more.
      ...(message.idempotencyKey
        ? { "Idempotency-Key": message.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: Array.isArray(message.to) ? message.to : [message.to],
      "reply_to": message.replyTo || env.MAIL_REPLY_TO || undefined,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: message.idempotencyKey || message.headers
        ? {
          ...message.headers,
          ...(message.idempotencyKey
            ? { "X-Entity-Ref-ID": message.idempotencyKey } : {}),
        }
        : undefined,
    }),
  }, {
    cap: RESEND_MS,
    name: "Resend",
    fail: (text, options) => new MailError(text, options),
  });

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
    replyTo: message.replyTo,
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

  // The same key is the same message, as Resend treats it: the one
  // already outboxed is answered, not written again.
  const keyed = message.idempotencyKey
    ? `${OUTBOX_KEYS}${message.idempotencyKey}` : null;
  const known = keyed && await jobs.get(keyed);

  // Unless it has been cleared since (a test clears the outbox).
  if (known && await jobs.get(`${OUTBOX_PREFIX}${known.id}`)) {
    return { id: known.id, driver: "outbox" };
  }

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

  if (keyed) await jobs.set(keyed, { id, at: now.toISOString() });

  const keys = (await jobs.list(OUTBOX_PREFIX)).map((k) => k.key);

  for (const key of keys.slice(0, Math.max(0, keys.length - OUTBOX_KEEP))) {
    await jobs.delete(key);
  }
  console.info(JSON.stringify({
    event: "mail.outboxed", to: message.to, subject: message.subject, id,
  }));

  return { id, driver: "outbox" };
};

// A header is one line. A customer's name or address in a subject, a
// recipient or a Reply-To must not carry a line break into it, so any
// that arrives (a name typed with one, a template that prints it) is a
// space by the time a driver sees the message.
const oneLine = (value) => String(value)
  .replace(/[\r\n\u2028\u2029]+/g, " ").trim();

export const headerSafe = (message) => ({
  ...message,
  to: Array.isArray(message.to) ? message.to.map(oneLine)
    : message.to && oneLine(message.to),
  subject: message.subject && oneLine(message.subject),
  ...(message.replyTo ? { replyTo: oneLine(message.replyTo) } : {}),
});

// The message is { to, subject, text, html, idempotencyKey?, replyTo? }.
// `replyTo` overrides MAIL_REPLY_TO for one message, so the farm
// answers a customer's note by replying to it.
export const sendMail = async (raw, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  stores,
} = {}) => {
  const message = headerSafe(raw);

  if (!message.to || !message.subject) {
    throw new MailError("A message needs a recipient and a subject");
  }

  // The drivers that send nothing come first: they are safe under
  // test and are how staging and local runs read their mail.
  if (env.MAIL_DRIVER === "outbox") return viaOutbox(message, env, stores);
  if (env.MAIL_DRIVER === "file") return viaFile(message, env);

  // Resend is production's alone, even if staging is handed a key.
  if (env.MAIL_DRIVER === "resend" && !resendAllowed(env)) {
    throw new MailError(resendRefusal(env));
  }

  if (!mailConfigured(env)) return viaLog(message);

  // The send breaker (lib/breaker.mjs) says whether Resend may be
  // called at all, and keeps what it refuses for `bin/nff breaker
  // flush`.
  const kept = stores || defaultStores(env);
  const gate = await guard(kept, message, { env, fetchImpl });

  if (!gate.allowed) {
    throw new MailError(`Resend breaker: ${gate.reason}`, {
      retryable: false, detail: { breaker: gate.reason },
    });
  }

  const sent = await viaResend(message, env, fetchImpl);

  await recordSend(kept, sent.id);

  return sent;
};
