// What the suite says when a request of its own fails, and how it
// keeps a session cookie out of the log (#665).
//
// The Actions log is public. Playwright's error for a failed or late
// request ends in a "Call log" that prints the request with every
// header, the cookie among them, and Node's fetch error carries its
// cause. So the suite never rethrows either, and never hangs one on
// its own error as a cause: it throws a new error made here, which
// names the method, the path and the kind of failure and nothing
// else. Nothing of the first error is copied into it, only matched.

import { COOKIE as SESSION } from "../../netlify/functions/lib/auth.mjs";

// The first line of each message down the chain of causes, with each
// error's name and code: enough to tell the kind, and before any call
// log. Only ever tested against a pattern, never shown.
const signs = (error) => {
  const out = [];

  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth += 1) {
    out.push(String(e.name || ""), String(e.code || ""),
      String(e.message || "").split("\n")[0]);
  }

  return out.join("\n");
};

// Node's codes, and the browser's for a navigation (net::ERR_...).
const KINDS = [
  [/time(d)?\s?out|TimeoutError/i, "timed out"],
  [/ECONNREFUSED|CONNECTION_REFUSED/, "connection refused"],
  [/ECONNRESET|CONNECTION_RESET/, "connection reset"],
  [/socket hang up/i, "socket hang up"],
  [/UND_ERR_SOCKET|other side closed|been closed|EPIPE/i,
    "connection closed"],
  [/EMPTY_RESPONSE|CONNECTION_CLOSED|connection was lost/,
    "connection closed"],
  [/ENOTFOUND|EAI_AGAIN|NAME_NOT_RESOLVED/, "host not found"],
  [/CERT_|SSL|TLS/, "TLS failure"],
  [/ERR_ABORTED|interrupted by another navigation/,
    "navigation interrupted"],
];

// "timed out after 300 ms" where the first error gave the time.
const kindOf = (error) => {
  const text = signs(error);
  const hit = KINDS.find(([pattern]) => pattern.test(text));

  if (!hit) return "failed";

  const ms = hit[1] === "timed out" && text.match(/Timeout (\d+)ms/);

  return ms ? `timed out after ${ms[1]} ms` : hit[1];
};

// The path alone: a query can hold a sign-in token. Most of the
// suite's requests are relative ("/api/dates" against the base URL),
// so a relative URL is resolved against a placeholder, only to take
// its path: the placeholder never reaches the message. Anything that
// is not a URL, or not a web address, has no path to name.
const PLACEHOLDER = "http://relative.invalid";

const pathOf = (url) => {
  try {
    if (!(url instanceof URL) && (typeof url !== "string" || !url)) {
      return "(no path)";
    }

    const { protocol, pathname } = new URL(url, PLACEHOLDER);

    return /^https?:$/.test(protocol) ? pathname : "(no path)";
  } catch {
    return "(no path)";
  }
};

// The error to throw in place of `error`, for a request of `method`
// to `url`. `what` goes first when given ("e2e ordersList").
export const requestError = (method, url, error, what = "") => new Error(
  `${what ? `${what}: ` : ""}${String(method).toUpperCase()} ${
    pathOf(url)}: ${kindOf(error)}`
);

// Opens a link that carries a credential in its query (a sign-in or
// confirmation link from an email, the back office's sign-in link, a
// signed maintenance link) as page.goto does. When the navigation
// fails or times out, Playwright's error prints the whole URL, and a
// link that never reached the server is still good. Every spec opens
// such a link through here, never with page.goto.
export const followLink = async (page, url, options) => {
  try {
    return await page.goto(url, options);
  } catch (error) {
    throw requestError("GET", url, error, "link");
  }
};

// Belt and braces: a session cookie the suite obtains is registered
// with the runner's mask, so a line that would print it prints ***.
// Only on GitHub: anywhere else the line itself would show the value.
const SAFE = /^[\w.~%+/=-]+$/;
const masked = new WeakMap();

// `cookies` as Playwright lists them; `owner` is the context holding
// them, so each value is written once per context.
export const maskSessions = (owner, cookies) => {
  if (process.env.GITHUB_ACTIONS !== "true") return;

  const seen = masked.get(owner) || new Set();

  masked.set(owner, seen);
  for (const { name, value } of cookies) {
    if (name !== SESSION || !value || seen.has(value)) continue;
    // A value with a line break could write a command of its own.
    if (!SAFE.test(value)) continue;
    seen.add(value);
    process.stdout.write(`::add-mask::${value}\n`);
  }
};
