// What Resend sent, read back for the CLI (`bin/nff --production mail`):
// when, to whom, what subject and how it ended. GET only, with
// RESEND_LOOKUP_KEY, which nothing else reads. Customer addresses are
// masked unless the caller names one, and no body is ever returned.

const API = "https://api.resend.com/emails";
const PAGE = 100;
// Resend allows two requests a second.
const PAUSE_MS = 600;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// "pat@example.com" to "p***@example.com". A named address
// ("Pat Smith <pat@example.com>") loses its name.
export const maskEmail = (email) => {
  const at = email.indexOf("@");

  return at < 1 ? "***" : `${email[0]}***${email.slice(at)}`;
};

const addressOf = (entry) => {
  const m = String(entry).match(EMAIL);

  return m ? m[0].toLowerCase() : "";
};

// Every address in `text` masked, except `keep` (already lowercased).
export const maskText = (text, keep = "") => String(text || "")
  .replace(EMAIL, (e) => (e.toLowerCase() === keep ? e : maskEmail(e)));

const recipients = (list, keep) => [].concat(list || [])
  .map(addressOf).filter(Boolean)
  .map((e) => (e === keep ? e : maskEmail(e)));

const lookupKey = (env) => {
  if (!env.RESEND_LOOKUP_KEY) {
    throw new Error("RESEND_LOOKUP_KEY is not set in .env.production.");
  }

  return env.RESEND_LOOKUP_KEY;
};

// Resend's error message and status, never the request or its key.
const get = async (url, env, fetchImpl) => {
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${lookupKey(env)}` },
  });
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`Resend answered ${res.status}: ${
      body.message || body.name || "no reason given"}.`);
  }

  return body;
};

// Resend writes "2026-09-20 14:03:22.674981+00"; ISO like our records.
const iso = (at) => {
  const d = new Date(at);

  return Number.isNaN(d.getTime()) ? String(at || "") : d.toISOString();
};

const row = (email, keep) => ({
  id: email.id,
  at: iso(email.created_at),
  to: recipients(email.to, keep),
  subject: maskText(email.subject, keep),
  lastEvent: email.last_event || "",
});

// Sent emails, newest first, back to `since` (a date or ISO string),
// only those to `to` when given. Pages through Resend's list.
export const listSent = async ({
  since, to, env = process.env, fetchImpl = globalThis.fetch,
  pause = (ms) => new Promise((r) => { setTimeout(r, ms); }),
} = {}) => {
  const from = since ? new Date(since) : null;
  const keep = to ? to.toLowerCase() : "";

  if (from && Number.isNaN(from.getTime())) {
    throw new Error(`Not a date: ${since}.`);
  }

  const rows = [];
  let after = "";

  for (;;) {
    const page = await get(`${API}?limit=${PAGE}${
      after ? `&after=${encodeURIComponent(after)}` : ""}`, env, fetchImpl);
    const data = page.data || [];
    let older = false;

    for (const email of data) {
      if (from && new Date(email.created_at) < from) {
        older = true;
        break;
      }
      if (!keep || [].concat(email.to || []).map(addressOf).includes(keep)) {
        rows.push(row(email, keep));
      }
    }

    if (older || !page.has_more || !data.length) return rows;
    after = data[data.length - 1].id;
    await pause(PAUSE_MS);
  }
};

// One sent email: its headers and tags, with no html or text.
export const showSent = async (id, {
  to, env = process.env, fetchImpl = globalThis.fetch,
} = {}) => {
  if (!id) throw new Error("Which email? bin/nff mail show <id>");

  const keep = to ? to.toLowerCase() : "";
  const email = await get(`${API}/${encodeURIComponent(id)}`, env, fetchImpl);

  return {
    ...row(email, keep),
    from: email.from,
    cc: recipients(email.cc, keep),
    bcc: recipients(email.bcc, keep),
    replyTo: recipients(email.reply_to, keep),
    tags: email.tags || [],
  };
};
