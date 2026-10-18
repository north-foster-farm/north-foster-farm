// One JSON line per event, as the functions have always written to
// the console, and the same lines shipped to a log store that outlives
// the function and the deploy, so "when did this start" has an
// answer. Each invocation buffers its lines and ships them once, at
// the end, with a short timeout; the store being down changes nothing
// for the request.
//
//   AXIOM_TOKEN, AXIOM_DATASET   the store (api.axiom.co). Unset: the
//                                lines go to the console only.
//
// Under `node --test` nothing is shipped, like sendMail.

import { createHash } from "node:crypto";

const buffer = [];

const SHIP_TIMEOUT = 1500;

// Logs name an order by its id and carry no one's contact details
// (#267). Every record is scrubbed on its way in, so it holds for each
// call site, present and future: a field that holds personal data is
// replaced, an email address anywhere in a string becomes a short hash
// (the same address always hashes the same, so a trail can be
// followed), and a phone number becomes a tag. A name or street typed
// into free text cannot be found by a pattern; the fields that carry
// them are the ones listed here.
const REMOVED = "[removed]";

const PERSONAL = new Set([
  "email", "mail", "firstname", "lastname", "fullname", "phone", "tel",
  "mobile", "address", "address1", "address2", "street", "street1",
  "street2", "line1", "line2", "city", "town", "postal", "postalcode",
  "customer", "payer", "recipient", "recipients", "to", "from", "replyto",
  "note", "notes", "instructions", "text", "html", "subject", "token",
  "authorization", "cookie",
]);

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PHONE = /[+(]?\d[\d\s().-]{8,}\d/g;
const DEPTH = 8;

const tagEmail = (address) => `[email:${
  createHash("sha256").update(address.toLowerCase()).digest("hex")
    .slice(0, 8)}]`;

const scrubText = (text) => text
  .replace(EMAIL, tagEmail)
  .replace(PHONE, (m) => (m.replace(/\D/g, "").length >= 10 ? "[phone]" : m));

export const scrub = (value, depth = 0) => {
  if (typeof value === "string") return scrubText(value);
  if (!value || typeof value !== "object") return value;
  if (depth >= DEPTH) return REMOVED;
  if (value instanceof Error) {
    return scrub({ message: value.message, stack: value.stack }, depth + 1);
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));

  return Object.fromEntries(Object.entries(value).map(([key, v]) => [
    key,
    PERSONAL.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))
      ? REMOVED
      : scrub(v, depth + 1),
  ]));
};

const line = (level, fields) => {
  const record = scrub({
    _time: new Date().toISOString(),
    level,
    ...(fields && typeof fields === "object" ? fields : { message: fields }),
  });
  const out = level === "error" ? console.error
    : level === "warn" ? console.warn : console.info;

  out(JSON.stringify(record));
  buffer.push(record);

  return record;
};

export const log = {
  info: (fields) => line("info", fields),
  warn: (fields) => line("warn", fields),
  error: (fields) => line("error", fields),
};

export const pending = () => buffer.length;

export const configured = (env = process.env) =>
  !!(env.AXIOM_TOKEN && env.AXIOM_DATASET);

// Ships what is buffered and empties the buffer. -> how many lines
// were sent (0 when the store is not configured or refused them).
export const flush = async ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  source = "site",
} = {}) => {
  const lines = buffer.splice(0, buffer.length);

  if (!lines.length || !configured(env)) return 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHIP_TIMEOUT);

  const dataset = encodeURIComponent(env.AXIOM_DATASET);

  try {
    const res = await fetchImpl(
      `https://api.axiom.co/v1/datasets/${dataset}/ingest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.AXIOM_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(lines.map((l) => ({
          ...l, source, deploy: env.DEPLOY_ID || env.CONTEXT || null,
        }))),
        signal: controller.signal,
      }
    );

    return res.ok ? lines.length : 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
};

const STACK_LINES = 12;
const STACK_CHARS = 2000;

// A stack short enough for a log line and an alert: the message and
// the first frames, which name the file and line that threw.
export const trimStack = (error) => String((error && error.stack)
  || error).split("\n").slice(0, STACK_LINES).join("\n")
  .slice(0, STACK_CHARS);

// The alert for an exception no handler caught, through lib/health.mjs
// (imported here when needed, since it logs through this module). Its
// hourly limit is per function, so one noisy function cannot hide
// another's crash. `options` are alert()'s, for the tests.
export const alertCrash = async (detail, error, {
  stores: given, ...options
} = {}) => {
  const [{ alert }, { stores }] = await Promise.all([
    import("./health.mjs"), import("./store.mjs"),
  ]);

  const s = given || stores();

  return alert(s, "function.crashed", detail, {
    ...options, mute: `function.crashed/${detail.function}`,
  });
};

// Wraps a function handler so its lines ship after it answers,
// whatever happened inside. An exception the handler did not catch is
// logged as function.crashed with the function's name and a trimmed
// stack, raises one alert (`onCrash`), and is thrown on unchanged, so
// Netlify answers exactly as it would have. The report never fails
// the request: a failing onCrash is logged and dropped.
//
//   withLog("orders", handler)
//   withLog("orders", handler, { onCrash, flushImpl })
export const withLog = (name, handler, {
  onCrash = alertCrash,
  flushImpl = flush,
} = {}) => {
  if (typeof name === "function") return withLog("unnamed", name, handler);

  return async (req, context) => {
    try {
      return await handler(req, context);
    } catch (error) {
      let path = null;

      try {
        path = new URL(req.url).pathname;
      } catch {
        // A scheduled run has no request.
      }

      const detail = {
        function: name,
        error: String((error && error.message) || error).slice(0, 300),
        method: (req && req.method) || null,
        path,
        stack: trimStack(error),
      };

      line("error", { event: "function.crashed", ...detail });
      if (onCrash) {
        try {
          await onCrash(detail, error);
        } catch (failure) {
          line("error", {
            event: "function.crash_alert_failed", function: name,
            error: String(failure),
          });
        }
      }

      throw error;
    } finally {
      await flushImpl();
    }
  };
};
