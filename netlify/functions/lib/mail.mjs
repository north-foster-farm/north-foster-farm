// The mail seam. One function sends one message; the driver comes
// from the environment:
//
//   MAIL_DRIVER=resend   Resend's API. Needs RESEND_API_KEY and
//                        MAIL_FROM ("North Foster Farm <orders@...>").
//   MAIL_DRIVER=log      Writes the message to the function log and
//                        sends nothing. The default, so a preview or
//                        a checkout without credentials never emails
//                        a real customer.
//
// ADMIN_EMAILS is a comma-separated list for farm-side notices.

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

// The message is { to, subject, text, html, idempotencyKey? }.
export const sendMail = async (message, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  if (!message.to || !message.subject) {
    throw new MailError("A message needs a recipient and a subject");
  }

  return mailConfigured(env)
    ? viaResend(message, env, fetchImpl)
    : viaLog(message);
};
