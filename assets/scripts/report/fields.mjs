// What a browser error report may carry (#258): the one place its
// fields are defined. The reporter (report.js) builds its body from
// SENT and nothing else; the /api/health handler
// (netlify/functions/lib/client-report.mjs) keeps STORED and drops
// every other key. A report says what went wrong, on which page, and
// in which browser, never who: no name, no contact details, no order.
//
// A thrown error can quote an input's value, so a message and a stack
// are scrubbed on both sides of anything shaped like an email address
// or a phone number.

export const KINDS = ["error", "payment.unavailable"];

// The steps a breadcrumb may name. Anything else is dropped.
export const CRUMBS = [
  "page.load", "pay.load", "config.ok", "config.failed",
  "square.ready", "square.load_failed", "card.ready", "card.attach_failed",
  "wallets.ready", "paypal.ready", "paypal.load_failed", "venmo.ready",
  "venmo.render_failed", "pay.press", "pay.ok", "pay.failed",
  "venmo.approve", "venmo.cancel",
];

export const SDKS = ["square", "paypal"];
export const SDK_STATES = ["loading", "ready", "failed"];

export const LIMITS = {
  where: 40, message: 300, stack: 2000, build: 40, page: 200, crumbs: 20,
};

// The places a report may name: each one pay.js reports from, the
// stock check's two (order/stock.js), and the window's own two.
// Anything else is sent and kept as null.
export const WHERES = [
  "checkout.config", "checkout.init", "square.load", "sdks.gone",
  "card.attach", "paypal.load", "paypal.render", "paypal.error",
  "cashapp.tokenize", "wallet.tokenize", "wallet.pay",
  "stock.unavailable", "stock.final_check",
  "window.error", "window.rejection",
];

// A build is a commit.
export const BUILD = /^[0-9a-f]{7,40}$/;

// The body the browser sends.
export const SENT = [
  "kind", "where", "message", "stack", "build", "page", "crumbs", "sdks",
];

// What the server keeps of it, with the browser it works out from the
// user agent.
export const STORED = [
  "where", "message", "stack", "build", "page", "crumbs", "square",
  "paypal", "browser", "browserVersion",
];

// -> a copy of `obj` with only the listed keys.
export const allow = (obj, keys) => {
  const out = {};

  for (const key of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key)) {
      out[key] = obj[key];
    }
  }

  return out;
};

// Anything the order form takes as an email (something@host.tld,
// with brackets, quotes or commas on either side), and as a phone
// number: ten digits or more, each set off from the next by up to
// three of the separators a person types (spaces, dots, dashes of any
// kind, slashes, underscores, parentheses, a +). A longer run goes
// too: a phone number glued to other digits cannot be told from a
// long number, and a long number is no loss. Not touched: a column
// number after a line's colon, a fingerprint in a script's URL, and
// Safari's "f@https://..." frames, whose "host" has no dot before its
// colon. No lookbehind: Safari before 16.4 cannot parse one, and the
// reporter would never load.
const LOCAL = "[^\\s@:/<>;]+";
const DOMAIN = "[^\\s@:/<>;\"']*\\.[^\\s@:/<>;\"'.]{2,}";
const EMAIL = new RegExp(`${LOCAL}@${DOMAIN}`, "g");
const SEP = "[\\s.\\-\\u2010-\\u2015\\u2212/_()+]";
const PHONE = new RegExp(
  `(^|[^\\d:]|[^\\d]:)\\+?\\d(?:${SEP}{0,3}\\d){9,}`, "g"
);
// A bundle's fingerprint as a stack's URL has it (main.<hex>.js), kept
// whole so the stack still maps. Only that: any other run of hex is
// scrubbed like the rest, since digits are hex too.
const HEX = /(\.[0-9a-f]{32,}\.js)/;

export const scrub = (text) => String(text ?? "").split(HEX)
  .map((part, i) => (i % 2 ? part : part
    .replace(EMAIL, "[email]")
    .replace(PHONE, "$1[phone]")))
  .join("");
