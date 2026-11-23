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
  "authorization", "cookie", "secretaccesskey", "apikey",
]);

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

// A phone number is 10 or more digits, ASCII or full-width, with
// spaces, dots, slashes, underscores, brackets or any dash between
// them (the hyphen, the figure, en and em dashes, the minus sign, the
// non-breaking hyphen, the horizontal bar, #922), and may end in an
// extension ("x23", "ext. 23"). A number in the 3-3-4 shape is
// scrubbed wherever it sits.
//
// Ids hold such runs too (an invite's hex, a UUID, an order id's tail,
// Square's and PayPal's ids, #896). A value logged under an id key
// keeps a run touching a letter, a digit or a dash-joined part of the
// same word, so the id survives whole; no id has the 3-3-4 shape. Any
// other value, free text above all, loses every run, glued to a word
// or not: an id inside a sentence loses its middle, which errs toward
// privacy.
const DIGIT = String.raw`[0-9０-９]`;
const DASH = String.raw`‐-―−﹘﹣－`;
const BETWEEN = String.raw`[\s.\/_\-${DASH}]`;
const EXTENSION = String.raw`(?:\s*(?:x|ext\.?)\s*${DIGIT}{1,6})?`;
const RUN = String.raw`[+(]?${DIGIT}(?:${DIGIT}|${BETWEEN}|[()]){8,}${
  DIGIT}${EXTENSION}`;
const NO_ID_LEFT = String.raw`(?<![A-Za-z0-9０-９-])`;
const NO_ID_RIGHT = String.raw`(?![A-Za-z0-9０-９]|-[A-Za-z0-9])`;
const PHONE = new RegExp(RUN, "gi");
const PHONE_BESIDE_ID = new RegExp(`${NO_ID_LEFT}${RUN}${NO_ID_RIGHT}`, "gi");
const SHAPED = new RegExp(String.raw`\(?(?<!${DIGIT})${DIGIT}{3}\)?${
  BETWEEN}${DIGIT}{3}${BETWEEN}${DIGIT}{4}(?!${DIGIT})${EXTENSION}`, "gi");
const DIGITS = new RegExp(DIGIT, "g");
const DEPTH = 8;

// A number value of 10 or more digits before the point could be a
// phone number logged as a number, not a string (#922), so off an id
// key it is tagged like one. A count, an amount in cents or a duration
// is far shorter.
const LONG_NUMBER = 1e9;

// An id key: "id", "key", "invite", or a camelCase or snake_case name
// ending in one ("squareOrderId", "idempotencyKey", "order_id"), or in
// "Run" or "run" for a GitHub Actions run id ("stagingRun", #922).
// Read from the key as written, so "paid" and "valid" are not ids.
const ID_KEY =
  /^(?:id|key|invite)$|(?:[a-z0-9](?:Id|ID|Key|Run)|[_-](?:id|key|run))$/;

const tagEmail = (address) => `[email:${
  createHash("sha256").update(address.toLowerCase()).digest("hex")
    .slice(0, 8)}]`;

const tagPhone = (m) => ((m.match(DIGITS) || []).length >= 10
  ? "[phone]" : m);

const scrubText = (text, asId) => text
  .replace(EMAIL, tagEmail)
  .replace(asId ? PHONE_BESIDE_ID : PHONE, tagPhone)
  .replace(SHAPED, tagPhone);

export const scrub = (value, depth = 0, asId = false) => {
  if (typeof value === "string") return scrubText(value, asId);
  if (typeof value === "number") {
    return !asId && Number.isFinite(value) && Math.abs(value) >= LONG_NUMBER
      ? "[phone]" : value;
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= DEPTH) return REMOVED;
  if (value instanceof Error) {
    return scrub({ message: value.message, stack: value.stack }, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrub(v, depth + 1, asId));
  }

  return Object.fromEntries(Object.entries(value).map(([key, v]) => [
    key,
    PERSONAL.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))
      ? REMOVED
      : scrub(v, depth + 1, ID_KEY.test(key)),
  ]));
};

// Exported for lib/with-log.mjs alone, whose wrapper writes its own
// lines into this one buffer. Everything else logs through `log`.
export const line = (level, fields) => {
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

// The store makes a field of every key path it is sent, nested ones
// included, and the free plan stops at 256 per dataset (#571). So a
// shipped line holds these top-level fields only, each a plain value,
// and everything else goes in one map field, `data`, which the dataset
// keeps as a single field whatever is inside it. The line is scrubbed
// before it is split (line() above), so the split changes no value.
// The console keeps the flat line.
export const FIXED = Object.freeze([
  "_time", "level", "event", "message", "error", "id", "function",
  "test", "source", "deploy",
]);
export const MAP = "data";

const plain = (v) => v === null || ["string", "number", "boolean"]
  .includes(typeof v);

// -> the record as the store receives it. The halves are built from
// entries, as scrub() builds the record, so every key ships as a
// field: assigning `__proto__` would set the prototype instead (#585).
export const shape = (record, { source, deploy }) => {
  const top = [];
  const data = [];

  for (const [key, value] of Object.entries(record)) {
    if (key === "source" || key === "deploy") continue;
    (FIXED.includes(key) && plain(value) ? top : data).push([key, value]);
  }

  return {
    ...Object.fromEntries(top), source, deploy,
    [MAP]: Object.fromEntries(data),
  };
};

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
        body: JSON.stringify(lines.map((l) => shape(l, {
          source, deploy: env.DEPLOY_ID || env.CONTEXT || null,
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

// A request that answers this slowly, or with a 5xx, gets one line.
export const SLOW_MS = 5000;

// The e2e test a request came from: its stock scope cookie (#507),
// present only on the suite's requests. -> the id, or null.
const SCOPE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const testOf = (req) => {
  const raw = (req && req.headers && req.headers.get("cookie")) || "";
  const match = raw.match(/(?:^|;\s*)nff_stock_scope=([^;]+)/);

  return match && SCOPE_ID.test(match[1]) ? match[1] : null;
};
