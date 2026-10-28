// What the edge function does with one request (netlify/edge-functions/
// gate.mjs holds only the platform glue). Kept here, with the platform
// handed in, so Node's test runner can drive it.
//
// A request passes when
//   - the gate is off (production, or any context it does not guard),
//   - it is for a path that is open to machines or to signing in
//     (EXEMPTIONS, below), or
//   - it carries a live session of an address on the allowlist.
// Anything else is stopped with the sign-in page (a browser asking for
// HTML) or a bare 401. Every response of a guarded context, passed or
// stopped, carries X-Robots-Tag: noindex.

import {
  COOKIE, MACHINE_COOKIE, cookieValue, gateActive, safeNext, same,
  sessionFor,
} from "./gate.mjs";
import { blockedText, signInPage } from "./gate-page.mjs";

export const NOINDEX = "noindex, nofollow, noarchive";

// Every way past the gate that is not a person's session, each with
// the credential that keeps it from being public. The paths are the
// sites' own; the credential is checked here for a token, and by the
// function itself for a signature (test/gate.test.mjs proves each
// stays closed without it). Every row is listed in docs/secrets.md.
//
//   credential "signature": the edge lets the request through and the
//   function refuses what is not signed by the provider.
//   credential "token": the edge refuses what does not carry the named
//   variable's value, as `Authorization: Bearer` or `X-Staging-Token`.
//   credential "sign-in": the gate's own endpoints, which answer the
//   same to anyone and send mail only to the allowlist.
//   credential "none": one exact path that is public on purpose. Only
//   /version.json, which holds the build's commit and version; the
//   repository is public, so it reveals nothing.
export const EXEMPTIONS = [
  { name: "sign-in", credential: "sign-in", paths: ["/api/gate/"],
    prefix: true },
  { name: "Square sandbox webhook", credential: "signature",
    paths: ["/api/square/webhook"] },
  { name: "PayPal sandbox webhook", credential: "signature",
    paths: ["/api/paypal/webhook"] },
  { name: "staging jobs workflow", credential: "token",
    env: "STAGING_TOKEN", paths: ["/api/staging/jobs/run"] },
  { name: "health check", credential: "token",
    env: "STAGING_TOKEN", paths: ["/api/health"] },
  { name: "build version", credential: "none", paths: ["/version.json"] },
  { name: "end-to-end suite", credential: "token",
    env: "E2E_STAGING_TOKEN", paths: null },
];

const matches = (rule, path) => rule.paths === null
  || rule.paths.some((p) => (rule.prefix ? path.startsWith(p) : path === p));

// The token a request presents, from the header or the machine cookie.
const presented = (req) => {
  const auth = req.headers.get("authorization") || "";

  return (auth.startsWith("Bearer ") ? auth.slice(7).trim() : "")
    || req.headers.get("x-staging-token")
    || cookieValue(req.headers, MACHINE_COOKIE)
    || "";
};

// -> the rule that lets this request by, or null.
export const exemption = async (req, path, env) => {
  const given = presented(req);

  for (const rule of EXEMPTIONS) {
    if (!matches(rule, path)) continue;
    if (rule.credential !== "token") return rule;

    const expected = env(rule.env);

    if (given && expected && await same(given, expected)) return rule;
  }

  return null;
};

const marked = (res) => {
  const out = new Response(res.body, res);

  out.headers.set("X-Robots-Tag", NOINDEX);

  return out;
};

// A request the gate let by, passed on. When the site behind fails to
// answer, `next()` rejects, and left alone the edge answers 500
// "uncaught exception" (full staging run 40638741710). It answers a
// plain 502 instead, which clients already treat as worth a retry, and
// says so in the log. Nothing of the site is let out either way.
const passOn = async (next) => {
  try {
    return marked(await next());
  } catch (error) {
    console.error(JSON.stringify({
      level: "error", event: "gate.next_failed",
      error: String((error && error.message) || error).slice(0, 200),
    }));

    return new Response("The site did not answer. Try again.\n", {
      status: 502,
      headers: {
        "X-Robots-Tag": NOINDEX,
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }
};

const wantsPage = (req) => ["GET", "HEAD"].includes(req.method)
  && (req.headers.get("accept") || "").includes("text/html");

const stop = (req, url) => {
  const headers = {
    "X-Robots-Tag": NOINDEX,
    "Cache-Control": "no-store",
  };

  if (wantsPage(req)) {
    return new Response(
      req.method === "HEAD"
        ? null : signInPage({ next: safeNext(url.pathname + url.search) }),
      {
        status: 401,
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  return new Response(blockedText, {
    status: 401,
    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
  });
};

// `deploy` is the deploy's context as the platform reports it; `env` a
// function name -> value; `next` passes the request on.
export const gateRequest = async (req, {
  deploy, env, store, next, now = new Date(),
}) => {
  // Production, and a request whose context is unknown, are untouched.
  if (!deploy || deploy === "production") return next();
  // Any other context that is not guarded (a local `netlify dev`) is
  // still kept out of search engines.
  if (!gateActive(deploy)) return passOn(next);

  const url = new URL(req.url);

  if (await exemption(req, url.pathname, env)) return passOn(next);

  const session = await sessionFor(store(), cookieValue(req.headers, COOKIE),
    now);

  return session ? passOn(next) : stop(req, url);
};
