// The staging toolbar's back end: the outbox of emails written instead
// of sent (MAIL_DRIVER=outbox), and a trigger for the scheduled jobs,
// which Netlify runs only on the production deploy. Answers only when
// the deploy's SITE_CONTEXT is set and is not production; in production
// every path here is a 404, so nothing staging-only is reachable.
//
//   GET    /api/staging/info          context, mail driver, Square env
//   GET    /api/staging/outbox        the last messages, newest first
//   GET    /api/staging/outbox/:id    one message as HTML (?format=text)
//   DELETE /api/staging/outbox        empty it
//   POST   /api/staging/jobs/run      { at?, reset? } run the jobs now,
//                                     or as of `at`; `reset` lets the
//                                     day's reports send again
//   GET    /api/staging/emails        the email library (lib/library.mjs):
//                                     every email, built from sample data,
//                                     with its tags, approval and text
//   GET    /api/staging/emails/:id    one as HTML (?format=text); nothing
//                                     is sent
//
// STAGING_TOKEN, when set, is required as a bearer or ?token=.

import { json, readJson } from "./lib/http.mjs";
import { runJobs } from "./lib/jobs.mjs";
import { entry, library } from "./lib/library.mjs";
import { log, withLog } from "./lib/log.mjs";
import { OUTBOX_PREFIX } from "./lib/mail.mjs";
import { mailLinks } from "./lib/site.mjs";
import { deployContext, stores as defaultStores } from "./lib/store.mjs";
import terms from "../../data/delivery.json" with { type: "json" };
import { today } from "../../assets/scripts/order/lib/zoned.mjs";

export const staging = (env = process.env) => {
  const context = deployContext(env);

  return !!context && context !== "production";
};

const tokenOf = (req) => {
  const auth = req.headers.get("authorization") || "";

  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();

  return new URL(req.url).searchParams.get("token") || "";
};

const escape = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The message's own HTML with a bar above it saying who it was for.
const page = (m) => {
  const to = Array.isArray(m.to) ? m.to.join(", ") : m.to;
  const bar = `<div style="font:13px system-ui,sans-serif;padding:8px 12px;` +
    `background:#ffe02b;color:#1d1c1b">` +
    `<strong>${escape(m.subject)}</strong> · to ${escape(to)} · ${
      escape(m.at)} · <a href="?format=text${
      m.token ? `&amp;token=${encodeURIComponent(m.token)}` : ""}">text</a>` +
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

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = new Date(),
  run = runJobs,
} = {}) => {
  if (!staging(env)) return json(404, { error: "Not found." });
  if (env.STAGING_TOKEN && tokenOf(req) !== env.STAGING_TOKEN) {
    return json(401, { error: "Staging token required." });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "");

  if (req.method === "GET" && path === "/api/staging/info") {
    return json(200, {
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
    }));

    return json(200, { messages });
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

    return new Response(page({ ...m, token: tokenOf(req) }), {
      status: 200,
      headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (req.method === "GET" && path === "/api/staging/emails") {
    const links = mailLinks(env);

    return json(200, {
      emails: library.map((e) => {
        const base = {
          id: e.id, name: e.name, when: e.when, audience: e.audience,
          tags: e.tags, approval: e.approval, note: e.note,
        };

        try {
          const m = e.build(links);

          return { ...base, subject: m.subject, text: m.text };
        } catch (error) {
          return { ...base, subject: e.name, error: String(error.message) };
        }
      }),
    });
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

  if (req.method === "POST" && path === "/api/staging/jobs/run") {
    const body = (await readJson(req)) || {};
    const at = body.at ? new Date(body.at) : now;

    if (Number.isNaN(at.getTime())) return json(400, { error: "Bad at." });
    if (body.reset) {
      const day = today(at, terms.timeZone);

      for (const kind of ["morning", "tomorrow"]) {
        await stores.jobs.delete(`report/${kind}/${day}`);
      }
    }
    log.info({ event: "staging.jobs_run", at: at.toISOString() });

    return json(200, await run(stores, { env, now: at }));
  }

  return json(404, { error: "Not found." });
};

export default withLog((req) => handle(req));

export const config = {
  path: ["/api/staging/*"],
};
