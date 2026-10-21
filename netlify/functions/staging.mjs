// The staging toolbar's back end: the outbox of emails written instead
// of sent (MAIL_DRIVER=outbox), and a trigger for the scheduled jobs,
// which Netlify runs only on the production deploy. Answers only when
// the deploy's SITE_CONTEXT is set and is not production; anywhere
// else every path here is a 404, so nothing staging-only is reachable.
//
// Two ways in, neither typed into a browser:
//
//   a gate session (lib/gate.mjs) whose address is GATE_TOOLBAR_EMAIL,
//   James's, opens every area: the toolbar uses it, by cookie. Another
//   address that signed in gets 403 and no toolbar.
//
//   STAGING_TOKEN, as a bearer, is for machines: the jobs workflow, a
//   health check. It opens only the "machine" areas below.
//
//   GET    /api/staging/info          context, mail driver, Square env
//   GET    /api/staging/outbox        the last messages, newest first
//   GET    /api/staging/outbox/:id    one message as HTML (?format=text)
//   GET    /api/staging/outbox/:id/attachments/:name   a file it carries
//   DELETE /api/staging/outbox        empty it
//   POST   /api/staging/jobs/run      { at?, reset? } run the jobs now,
//                                     or as of `at`; `reset` lets the
//                                     day's reports send again
//   GET    /api/staging/emails        the email library (lib/library.mjs):
//                                     every email, built from sample data,
//                                     with its tags, approval and text
//   GET    /api/staging/emails/:id    one as HTML (?format=text); nothing
//                                     is sent
//   GET    /api/staging/emails/:id/attachments/:name   its sample file
//                                     (the packing slips' PDF)
//   PUT    /api/staging/emails/:id/approval  { version } James approves
//   DELETE /api/staging/emails/:id/approval  and withdraws it
//   PUT    /api/staging/emails/:id/rewrite   { version, subject, text }
//                                     his rewrite, as parts with the
//                                     sample values as tokens
//   DELETE /api/staging/emails/:id/rewrite   back to the code's wording
//                                     (all four: lib/review.mjs)
//   GET    /api/staging/signatures    the email signatures (lib/signatures
//                                     .mjs): id, label, html, text and
//                                     the fields still missing
//   GET    /api/staging/signatures/:id  one as a bare page, for Select All
//   POST   /api/staging/e2e          { op, ...args } the end-to-end
//                                     suite's records, mail and
//                                     maintenance switch (lib/e2e.mjs);
//                                     opens only to E2E_STAGING_TOKEN,
//                                     never to STAGING_TOKEN
//   POST   /api/staging/throw         throws, to prove the crash alert
//                                     (only with STAGING_TOKEN set)
//
// With neither GATE_TOOLBAR_EMAIL nor STAGING_TOKEN set the API fails
// closed: a context that forgot them answers 404, as production does,
// rather than opening the outbox and its magic links to anyone. The
// same holds for /e2e and E2E_STAGING_TOKEN, the one token of the
// test suite; the two never open each other's paths.

import { runOp } from "./lib/e2e.mjs";
import { COOKIE, cookieValue, sessionFor } from "./lib/gate.mjs";
import { json, readJson } from "./lib/http.mjs";
import { runJobs } from "./lib/jobs.mjs";
import { entry, library } from "./lib/library.mjs";
import { log, withLog } from "./lib/log.mjs";
import { OUTBOX_PREFIX, attached } from "./lib/mail.mjs";
import { SENT as PACKING_SENT } from "./lib/packing.mjs";
import {
  cleanParts, joined, revert, reviews, saveApproval, saveRewrite, standing,
  tokenize, versionFor, withdrawApproval,
} from "./lib/review.mjs";
import { mailLinks } from "./lib/site.mjs";
import { sameToken } from "./lib/token.mjs";
import {
  alone, entry as signature, library as signatures, render,
} from "./lib/signatures.mjs";
import { deployContext, stores as defaultStores } from "./lib/store.mjs";
import terms from "../../data/delivery.json" with { type: "json" };
import { today } from "../../assets/scripts/order/lib/zoned.mjs";

export const staging = (env = process.env) => {
  const context = deployContext(env);

  return !!context && context !== "production";
};

const tokenOf = (req) => {
  const auth = req.headers.get("authorization") || "";

  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
};

// What each way in opens, by the areas below. The machine token opens
// the areas a workflow needs, none that read customers' mail (the
// outbox and the email library carry sign-in links) or show the
// toolbar. Every new area is listed in docs/secrets.md.
const AREAS = ["info", "inbox", "jobs", "emails", "signatures", "throw"];

export const KEYS = {
  "gate session": AREAS,
  STAGING_TOKEN: ["info", "jobs", "throw"],
};

// Who is asking -> { key } (a name of KEYS), { refused: 401 | 403 }.
// The toolbar owner's gate session first; a session of anyone else is
// a refusal of its own, not a try at the token.
const whoIs = async (req, env, stores, now) => {
  const given = tokenOf(req);

  if (given && env.STAGING_TOKEN && sameToken(given, env.STAGING_TOKEN)) {
    return { key: "STAGING_TOKEN" };
  }

  const session = await sessionFor(stores.gate,
    cookieValue(req.headers, COOKIE), now);

  if (!session) return { refused: 401 };

  return env.GATE_TOOLBAR_EMAIL
    && session.email === String(env.GATE_TOOLBAR_EMAIL).trim().toLowerCase()
    ? { key: "gate session" }
    : { refused: 403 };
};

// Which area of the API a request is in, or null for a path no area
// owns. Deny by default: a null area is open only to the owner's session,
// so a route added without an area here is closed to a machine.
export const areaOf = (method, path) => {
  if (path === "/api/staging/info") return "info";
  if (path.startsWith("/api/staging/outbox")) return "inbox";
  if (path.startsWith("/api/staging/jobs")) return "jobs";
  if (path.startsWith("/api/staging/emails")) return "emails";
  if (path.startsWith("/api/staging/signatures")) return "signatures";
  if (method === "POST" && path === "/api/staging/throw") return "throw";

  return null;
};

const escape = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The message's own HTML with a bar above it saying who it was for.
const page = (m) => {
  const to = Array.isArray(m.to) ? m.to.join(", ") : m.to;
  const bar = `<div style="font:13px system-ui,sans-serif;padding:8px 12px;` +
    `background:#ffe02b;color:#1d1c1b">` +
    `<strong>${escape(m.subject)}</strong> · to ${escape(to)} · ${
      escape(m.at)} · <a href="?format=text">text</a>` +
    `</div>`;
  const html = m.html || `<pre>${escape(m.text)}</pre>`;

  return html.includes("<body")
    ? html.replace(/<body([^>]*)>/i, `<body$1>${bar}`)
    : `${bar}${html}`;
};

// A message sets its own policy: the emails carry their styles inline,
// and the site's stylesheet policy would strip them. It may load the
// site's fonts.
const MESSAGE_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; img-src https: data:; " +
    "style-src 'unsafe-inline'; font-src https:",
  "Cache-Control": "no-store",
};

// A message's attachments as links under `base` (#292: the packing
// slips' PDF).
const filesOf = (m, base) => attached(m).map((a) => ({
  filename: a.filename,
  url: `${base}/attachments/${encodeURIComponent(a.filename)}`,
}));

// One attachment of a message, served as itself, or null.
const fileResponse = (m, name) => {
  const a = attached(m).find((x) => x.filename === name);

  if (!a) return null;

  return new Response(Buffer.from(a.content, "base64"), {
    status: 200,
    headers: {
      "Content-Type": a.contentType || "application/octet-stream",
      "Content-Disposition": `inline; filename="${
        a.filename.replace(/[^\w.-]+/g, "-")}"`,
      "Content-Security-Policy": "default-src 'none'",
      "Cache-Control": "no-store",
    },
  });
};

const about = (e) => ({
  id: e.id, name: e.name, when: e.when, audience: e.audience,
  tags: e.tags, note: e.note,
});

// A library email as the toolbar shows it: built, split into sample
// tokens for the rewrite editor, and where James's review stands.
const view = (e, m, saved) => ({
  ...about(e),
  subject: m.subject,
  text: m.text,
  attachments: filesOf(m, `/api/staging/emails/${encodeURIComponent(e.id)}`),
  parts: { subject: tokenize(m.subject), text: tokenize(m.text) },
  ...standing(e, versionFor(e), saved),
});

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = new Date(),
  run = runJobs,
} = {}) => {
  if (new URL(req.url).pathname.replace(/\/$/, "") === "/api/staging/e2e") {
    if (!staging(env) || !env.E2E_STAGING_TOKEN) {
      return json(404, { error: "Not found." });
    }
    if (!sameToken(tokenOf(req), env.E2E_STAGING_TOKEN)) {
      return json(401, { error: "E2E token required." });
    }
    if (req.method !== "POST") return json(405, { error: "POST." });

    const done = await runOp(stores, await readJson(req), env);

    return json(done.status, done.body);
  }

  if (!staging(env) || !(env.STAGING_TOKEN || env.GATE_TOOLBAR_EMAIL)) {
    return json(404, { error: "Not found." });
  }

  const who = await whoIs(req, env, stores, now);

  if (who.refused === 401) return json(401, { error: "Sign in required." });
  if (who.refused) {
    return json(403, { error: "This session does not open that." });
  }

  const { key } = who;

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "");
  const can = KEYS[key];

  // Every use is logged by the key's name, never its value.
  log.info({ event: "staging.key_used", key, method: req.method, path });
  const area = areaOf(req.method, path);

  if (area ? !can.includes(area) : key !== "gate session") {
    return json(403, { error: "This key does not open that.", key });
  }

  // #256's proof that an uncaught exception is logged and alerted
  // (withLog, function.crashed). Never without a token.
  if (req.method === "POST" && path === "/api/staging/throw") {
    log.info({ event: "staging.throw" });

    throw new Error("Staging proof: an exception no handler caught.");
  }

  if (req.method === "GET" && path === "/api/staging/info") {
    return json(200, {
      key,
      can,
      context: deployContext(env),
      mailDriver: env.MAIL_DRIVER || "log",
      squareEnv: env.SQUARE_ENV || "sandbox",
      siteUrl: env.SITE_URL || env.URL || null,
    });
  }

  if (path === "/api/staging/outbox") {
    const keys = (await stores.jobs.list(OUTBOX_PREFIX)).map((k) => k.key);

    if (req.method === "DELETE") {
      for (const key of keys) await stores.jobs.delete(key);

      return json(200, { ok: true, removed: keys.length });
    }
    if (req.method !== "GET") return json(405, { error: "GET or DELETE." });

    const messages = (await Promise.all(
      keys.map((key) => stores.jobs.get(key))
    )).filter(Boolean).reverse().map((m) => ({
      id: m.id, at: m.at, to: m.to, subject: m.subject,
      attachments: filesOf(m,
        `/api/staging/outbox/${encodeURIComponent(m.id)}`),
    }));

    return json(200, { messages });
  }

  const file = req.method === "GET" && path.match(
    /^\/api\/staging\/(outbox|emails)\/([^/]+)\/attachments\/([^/]+)$/
  );

  if (file) {
    const id = decodeURIComponent(file[2]);
    const e = file[1] === "emails" ? entry(id) : null;
    const m = file[1] === "emails"
      ? e && e.build(mailLinks(env))
      : await stores.jobs.get(`${OUTBOX_PREFIX}${id}`);
    const res = m && fileResponse(m, decodeURIComponent(file[3]));

    return res || json(404, { error: "No such attachment." });
  }

  if (req.method === "GET" && path.startsWith("/api/staging/outbox/")) {
    const id = decodeURIComponent(path.slice("/api/staging/outbox/".length));
    const m = await stores.jobs.get(`${OUTBOX_PREFIX}${id}`);

    if (!m) return json(404, { error: "No such message." });

    const headers = MESSAGE_HEADERS;

    if (url.searchParams.get("format") === "text") {
      const to = Array.isArray(m.to) ? m.to.join(", ") : m.to;

      return new Response(`To: ${to}\nSubject: ${m.subject}\n\n${m.text}\n`, {
        status: 200,
        headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return new Response(page(m), {
      status: 200,
      headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (req.method === "GET" && path === "/api/staging/emails") {
    const links = mailLinks(env);
    const saved = await reviews(stores);

    return json(200, {
      emails: library.map((e) => {
        try {
          return view(e, e.build(links), saved[e.id]);
        } catch (error) {
          return {
            ...about(e), subject: e.name, error: String(error.message),
          };
        }
      }),
    });
  }

  const review = path.match(
    /^\/api\/staging\/emails\/([^/]+)\/(approval|rewrite)$/
  );

  if (review) {
    const e = entry(decodeURIComponent(review[1]));

    if (!e) return json(404, { error: "No such email." });

    const m = e.build(mailLinks(env));
    const version = versionFor(e);
    const answer = async () => json(200, {
      email: view(e, m, (await reviews(stores))[e.id]),
    });

    if (req.method === "DELETE") {
      await (review[2] === "approval" ? withdrawApproval : revert)(
        stores, e.id
      );

      return answer();
    }
    if (req.method !== "PUT") return json(405, { error: "PUT or DELETE." });

    const body = (await readJson(req)) || {};

    if (body.version !== version) {
      return json(409, {
        error: "This email has changed since you opened it. Reload.",
      });
    }
    if (e.approval === "approved") {
      return json(409, { error: "Already approved in the code." });
    }
    if (review[2] === "approval") {
      await saveApproval(stores, e.id, version, now);

      return answer();
    }

    const allowed = new Set([...tokenize(m.subject), ...tokenize(m.text)]
      .filter((p) => p.token !== undefined).map((p) => p.token));
    const subject = cleanParts(body.subject, allowed);
    const text = cleanParts(body.text, allowed);

    if (!subject || !text || !joined(subject).trim()
      || joined(subject).includes("\n")) {
      return json(400, { error: "A subject on one line and a body." });
    }
    await saveRewrite(stores, e.id, { version, subject, text }, now);
    log.info({ event: "staging.email_rewritten", id: e.id });

    return answer();
  }

  if (req.method === "GET" && path.startsWith("/api/staging/emails/")) {
    const e = entry(decodeURIComponent(
      path.slice("/api/staging/emails/".length)
    ));

    if (!e) return json(404, { error: "No such email." });

    const m = e.build(mailLinks(env));

    if (url.searchParams.get("format") === "text") {
      return new Response(`Subject: ${m.subject}\n\n${m.text}\n`, {
        status: 200,
        headers: {
          ...MESSAGE_HEADERS, "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    return new Response(m.html, {
      status: 200,
      headers: {
        ...MESSAGE_HEADERS, "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  if (req.method === "GET" && path === "/api/staging/signatures") {
    return json(200, { signatures: signatures(env) });
  }

  if (req.method === "GET" && path.startsWith("/api/staging/signatures/")) {
    const v = signature(decodeURIComponent(
      path.slice("/api/staging/signatures/".length)
    ));

    if (!v) return json(404, { error: "No such signature." });

    // Nothing but the signature, so Select All and Copy takes only it.
    return new Response(alone(render(v, env).html), {
      status: 200,
      headers: {
        ...MESSAGE_HEADERS, "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  if (req.method === "POST" && path === "/api/staging/jobs/run") {
    const body = (await readJson(req)) || {};
    const at = body.at ? new Date(body.at) : now;

    if (Number.isNaN(at.getTime())) return json(400, { error: "Bad at." });
    if (body.reset) {
      const day = today(at, terms.timeZone);

      for (const kind of ["morning", "tomorrow"]) {
        await stores.jobs.delete(`report/${kind}/${day}`);
      }
      // The packing slips go again; what was printed stays printed.
      await stores.jobs.delete(`${PACKING_SENT}${day}`);
    }
    log.info({ event: "staging.jobs_run", at: at.toISOString() });

    return json(200, await run(stores, { env, now: at }));
  }

  return json(404, { error: "Not found." });
};

export default withLog("staging", (req) => handle(req));

export const config = {
  path: ["/api/staging/*"],
};
