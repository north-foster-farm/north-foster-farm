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
//
// ADMIN_EMAILS is a comma-separated list for farm-side notices.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
        "reply_to": env.MAIL_REPLY_TO || undefined,
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
    `To: ${to}\nSubject: ${message.subject}\n\n${message.text}\n`);
  console.info(JSON.stringify({
    event: "mail.filed", to: message.to, subject: message.subject,
    file: join(dir, `${base}.html`),
  }));

  return { id: base, driver: "file" };
};

// The message is { to, subject, text, html, idempotencyKey? }.
export const sendMail = async (message, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  if (!message.to || !message.subject) {
    throw new MailError("A message needs a recipient and a subject");
  }

  // Under `node --test` (which sets NODE_TEST_CONTEXT) a real fetch is
  // a test reaching Resend: on 2026-09-22 the suite, run by the Netlify
  // build with the production variables, mailed the fixtures' notices
  // to the farm on every deploy. A test's own fake fetch still goes
  // through, so the Resend path stays testable.
  const live = fetchImpl === globalThis.fetch;

  if (process.env.NODE_TEST_CONTEXT && live) return viaLog(message);
  if (env.MAIL_DRIVER === "file") return viaFile(message, env);

  return mailConfigured(env)
    ? viaResend(message, env, fetchImpl)
    : viaLog(message);
};
