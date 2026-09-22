// POST /api/venmo/inbound: Resend received an email at the farm's
// receiving address. The webhook carries only the metadata, so the
// message is fetched from Resend and, if it is Venmo saying someone
// paid, applied to the order named in the note (lib/venmo.mjs).
//
// Resend signs the request (Svix headers); RESEND_WEBHOOK_SECRET is
// the endpoint's signing secret. Reading a received email needs a key
// with read access, RESEND_READ_KEY; the sending key alone will not
// do. Anything that is not a Venmo payment answers 200 so Resend does
// not retry it.

import { alert } from "./lib/health.mjs";
import { json } from "./lib/http.mjs";
import { log, withLog } from "./lib/log.mjs";
import { stores as defaultStores } from "./lib/store.mjs";
import {
  applyPayment, parseNotification, verifySignature,
} from "./lib/venmo.mjs";

export const fetchReceived = async (id, {
  env = process.env, fetchImpl = globalThis.fetch,
} = {}) => {
  const key = env.RESEND_READ_KEY || env.RESEND_API_KEY;
  const res = await fetchImpl(
    `https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`,
    { headers: { Authorization: `Bearer ${key}` } }
  );

  if (!res.ok) throw new Error(`Resend ${res.status} fetching ${id}`);

  return res.json();
};

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = new Date(),
  mail,
  cancel,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const body = await req.text();

  if (!verifySignature(env.RESEND_WEBHOOK_SECRET, req.headers, body, now)) {
    return json(401, { error: "Bad signature." });
  }

  let event;

  try {
    event = JSON.parse(body);
  } catch {
    return json(400, { error: "Expected JSON." });
  }

  if (!event || event.type !== "email.received" || !event.data
    || !event.data.email_id) {
    return json(200, { handled: false, reason: "ignored" });
  }

  let message;

  try {
    message = await fetchReceived(event.data.email_id, { env, fetchImpl });
  } catch (error) {
    log.error({
      event: "venmo.fetch_failed", id: event.data.email_id,
      error: String(error.message),
    });
    await alert(stores, "venmo.fetch_failed", {
      emailId: event.data.email_id, error: String(error.message),
    }, { env, mail, now });

    // Resend retries on a 5xx, so the message is not lost.
    return json(502, { error: "Could not fetch the message." });
  }

  const parsed = parseNotification({
    from: (message.headers && message.headers.from) || message.from,
    subject: message.subject,
    html: message.html,
  });

  if (!parsed.ok) return json(200, { handled: false, reason: parsed.reason });

  const result = await applyPayment(stores, parsed, { env, mail, now, cancel });

  log.info({ event: "venmo.received", ...result });

  return json(200, result);
};

export default withLog(async (req) => handle(req));

export const config = {
  path: "/api/venmo/inbound",
  method: "POST",
};
