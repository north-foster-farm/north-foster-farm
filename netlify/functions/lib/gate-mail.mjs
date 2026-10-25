// The one email a non-production deploy really sends: the access
// gate's sign-in link (decided 2026-10-18; everything else stays on
// the outbox, and Resend is otherwise production's alone, see
// resend-guard.mjs). It is kept as small as it can be:
//
//   - one plain-text template, no HTML, no other mail path;
//   - a Resend sending key of its own, GATE_RESEND_KEY, held on
//     staging alone and never production's;
//   - it refuses any recipient not on the allowlist, and any context
//     the gate does not guard, so it cannot run in production;
//   - it asks the send breaker first (lib/breaker.mjs) with a ceiling
//     of its own (data/gate.json) that is far below production's.
//
// A sign-in link is mailed for an address that asked and is on the
// list; nobody else is ever written to.

import { guard } from "./breaker.mjs";
import { company } from "./company.mjs";
import { MAIL_CEILING, LINK_TTL, gateActive, isAllowed } from "./gate.mjs";
import { timedFetch } from "./http.mjs";
import { log } from "./log.mjs";
import { deployContext } from "./store.mjs";

const RESEND_MS = 4000;

const SITE = `[STAGING] ${company.name}`;

export const SUBJECT = `Your secure sign-in link to ${SITE}`;

export const linkText = (url, minutes = LINK_TTL / 60_000) => [
  `Sign in to ${SITE}`,
  "",
  `Click the link below to sign in to ${SITE}. The link ` +
    `expires in ${minutes} minutes.`,
  "",
  url,
  "",
  "If you didn't request this email, you can safely ignore it.",
  "",
].join("\n");

export const gateMailConfigured = (env = process.env) =>
  !!env.GATE_RESEND_KEY && !!env.GATE_MAIL_FROM;

// -> { sent: true, id } or { sent: false, reason }. Never throws: a
// failure to mail changes nothing the visitor is told.
export const sendLink = async ({ to, url, key }, {
  env = process.env, stores, fetchImpl = globalThis.fetch,
  now = new Date(),
}) => {
  const context = deployContext(env);

  if (!gateActive(context)) return { sent: false, reason: "context" };
  if (!gateMailConfigured(env)) return { sent: false, reason: "unconfigured" };
  if (!(await isAllowed(stores.gate, to))) {
    return { sent: false, reason: "not-allowed" };
  }

  const message = { to, subject: SUBJECT, text: linkText(url) };
  const allowed = await guard(stores, message, {
    env, now, fetchImpl, ceiling: MAIL_CEILING, keep: false, open: false,
  });

  if (!allowed.allowed) return { sent: false, reason: allowed.reason };

  try {
    const res = await timedFetch(fetchImpl, "https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GATE_RESEND_KEY}`,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify({
        from: env.GATE_MAIL_FROM,
        to: [to],
        subject: message.subject,
        text: message.text,
      }),
    }, {
      cap: RESEND_MS,
      name: "Resend",
      fail: (text) => new Error(text),
    });

    if (!res.ok) {
      log.error({ event: "gate.mail_failed", status: res.status });

      return { sent: false, reason: "failed" };
    }

    const data = await res.json().catch(() => ({}));

    return { sent: true, id: data.id || null };
  } catch (error) {
    log.error({ event: "gate.mail_failed", error: String(error) });

    return { sent: false, reason: "failed" };
  }
};
