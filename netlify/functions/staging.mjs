// The staging toolbar's back end: the outbox of emails written instead
// of sent (MAIL_DRIVER=outbox), and a trigger for the scheduled jobs,
// which Netlify runs only on the production deploy. Answers only when
// the deploy's SITE_CONTEXT is set and is not production; anywhere
// else every path here is a 404, so nothing staging-only is reachable.
//
// Three ways in, none typed into a browser:
//
//   any gate session (lib/gate.mjs) opens the toolbar (#294): its own
//   session's mail, the jobs, the clock, the email library and the
//   signatures. The browser's cookie is the credential.
//
//   the gate session of GATE_TOOLBAR_EMAIL, James's, opens all of that
//   and also every session's mail (Sent) and the library's review.
//
//   STAGING_TOKEN, as a bearer, is for machines: the jobs workflow, a
//   health check. It opens only the "machine" areas below.
//
// Mail is scoped to the gate session whose request wrote it (lib/
// clock.mjs stamps it): a session lists and opens only its own, and a
// message carrying a sign-in link only if it went to that session's
// own address (ownLink). Mail no session wrote is in Sent alone.
//
//   GET    /api/staging/info          context, mail driver, Square env,
//                                     the clock, who is asking
//   GET    /api/staging/outbox        this session's messages, newest
//                                     first
//   GET    /api/staging/outbox/:id    one message as HTML (?format=text)
//   GET    /api/staging/outbox/:id/attachments/:name   a file it carries
//   DELETE /api/staging/outbox        empty this session's
//   GET    /api/staging/sent          every message, any session's
//   DELETE /api/staging/sent          empty the whole outbox
//   GET    /api/staging/clock         { offset, now }: this browser's
//   PUT    /api/staging/clock         { at } set it; DELETE resets it
//   POST   /api/staging/jobs/run      { at?, time?, reset? } run the
//                                     jobs now (on this browser's
//                                     clock), as of `at`, or at `time`
//                                     ("08:00") on its day; `reset`
//                                     lets the day's reports send again
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
// The review routes (approval, rewrite) are James's alone.
//
// With neither GATE_TOOLBAR_EMAIL nor STAGING_TOKEN set the API fails
// closed: a context that forgot them answers 404, as production does,
// rather than opening the outbox and its magic links to anyone. The
// same holds for /e2e and E2E_STAGING_TOKEN, the one token of the
// test suite; the two never open each other's paths.

import {
  MAX_OFFSET, clockAllowed, clockCookie, now as clock, offsetFrom, tagOf,
} from "./lib/clock.mjs";
import { runOp } from "./lib/e2e.mjs";
import { COOKIE, cookieValue, normalize, sessionFor } from "./lib/gate.mjs";
import { json, readJson } from "./lib/http.mjs";
import { runJobs } from "./lib/jobs.mjs";
import { entry, library } from "./lib/library.mjs";
import { log, withLog } from "./lib/log.mjs";
import { OUTBOX_PREFIX, attached } from "./lib/mail.mjs";
import {
  SENT as PACKING_SENT, fileName as packetFile, packetPreview,
} from "./lib/packing.mjs";
import {
  cleanParts, joined, revert, reviews, saveApproval, saveRewrite, standing,
  tokenize, versionFor, withdrawApproval,
} from "./lib/review.mjs";
import { mailLinks } from "./lib/site.mjs";
import { sameToken } from "./lib/token.mjs";
import {
  alone, entry as signature, library as signatures, render,
} from "./lib/signatures.mjs";
import { build as buildSlip, has, pages } from "./lib/slips.mjs";
import { deployContext, stores as defaultStores } from "./lib/store.mjs";
import terms from "../../data/delivery.json" with { type: "json" };
import { instant, today } from "../../assets/scripts/order/lib/zoned.mjs";

export const staging = (env = process.env) => {
  const context = deployContext(env);

  return !!context && context !== "production";
};

const tokenOf = (req) => {
  const auth = req.headers.get("authorization") || "";

  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
};

// What each way in opens, by the areas below. The machine token opens
// the areas a workflow needs, none that read mail or show the toolbar.
// A tester's session reads its own mail only ("inbox"); every
// session's ("sent") and the review are James's. Every new area is
// listed in docs/secrets.md.
const AREAS = [
  "info", "inbox", "sent", "jobs", "clock", "emails", "review",
  "signatures", "slips", "throw",
];

export const KEYS = {
  "owner session": AREAS,
  "gate session": [
    "info", "inbox", "jobs", "clock", "emails", "signatures", "slips",
  ],
  STAGING_TOKEN: ["info", "jobs", "throw"],
};

// Who is asking -> { key, email?, tag? } (key a name of KEYS), or
// { refused: 401 }. `tag` is the session's mail stamp (lib/clock.mjs).
// Checked on the real clock: a tester's clock must not revive a
// session that has ended.
const whoIs = async (req, env, stores) => {
  const given = tokenOf(req);

  if (given && env.STAGING_TOKEN && sameToken(given, env.STAGING_TOKEN)) {
    return { key: "STAGING_TOKEN" };
  }

  const id = cookieValue(req.headers, COOKIE);
  const session = await sessionFor(stores.gate, id, new Date());

  if (!session) return { refused: 401 };

  const owner = !!env.GATE_TOOLBAR_EMAIL
    && session.email === normalize(env.GATE_TOOLBAR_EMAIL);

  return {
    key: owner ? "owner session" : "gate session",
    email: session.email,
    tag: await tagOf(id),
  };
};

// A message carrying a link that acts for its recipient: marked so at
// its source (`credential`, set by the shop's sign-in and the farm
// news confirm and welcome), and found by content as well, in case a
// sender forgets the mark. The sign-in links of the shop and the gate,
// news confirm and unsubscribe.
const SIGN_IN = new RegExp([
  "/api/(?:auth|gate)/verify\\?token=",
  "/api/news/(?:confirm|unsubscribe)\\?token=",
  "[?&]unsubscribe=",
].join("|"));

export const carriesSignIn = (m) => !!m.credential
  || SIGN_IN.test(`${m.text || ""}\n${m.html || ""}`);

// One mailbox, its +tags aside: pat+1@example.com is pat@example.com.
const mailbox = (address) => {
  const [local, domain] = normalize(address).split("@");

  return `${String(local).split("+")[0]}@${domain}`;
};

const recipients = (m) => [].concat(m.to).filter(Boolean);

// Whether a sign-in link in `m` is the asker's own to read: it was sent
// to their own mailbox and no other, or the asker is James. A message
// with no recipient is no one's.
export const ownLink = (m, who) => who.key === "owner session"
  || (recipients(m).length > 0 && !!who.email
    && recipients(m).every((to) => mailbox(to) === mailbox(who.email)));

// This browser's clock: whether it may move here, its offset, and the
// time it reads.
const clockOf = (req, env) => {
  const offset = offsetFrom(req.headers, env);

  return {
    available: clockAllowed(env),
    offset,
    now: new Date(Date.now() + offset).toISOString(),
  };
};

// Whether `m` was written by `who`'s own session; whether `who` may
// open it (James opens any, from Sent); and whether its sign-in link
// is kept from them.
const mine = (m, who) => !!who.tag && m.session === who.tag;
const withheld = (m, who) => carriesSignIn(m) && !ownLink(m, who);
const opens = (m, who) => (who.key === "owner session" || mine(m, who))
  && !withheld(m, who);

// Which area of the API a request is in, or null for a path no area
// owns. Deny by default: a null area is open only to the owner's session,
// so a route added without an area here is closed to a machine and to
// a tester.
export const areaOf = (method, path) => {
  if (path === "/api/staging/info") return "info";
  if (path.startsWith("/api/staging/outbox")) return "inbox";
  if (path === "/api/staging/sent") return "sent";
  if (path === "/api/staging/clock") return "clock";
  if (/^\/api\/staging\/emails\/[^/]+\/(?:approval|rewrite)$/.test(path)) {
    return "review";
  }
  if (path.startsWith("/api/staging/jobs")) return "jobs";
  if (path.startsWith("/api/staging/emails")) return "emails";
  if (path.startsWith("/api/staging/signatures")) return "signatures";
  if (path.startsWith("/api/staging/slips")) return "slips";
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

// A PDF to show in the reader, open alone or download. Same-origin
// framing only; the toolbar's reader embeds it, and the site-wide
// frame-ancestors 'none' would blank that frame.
const pdfResponse = (bytes, filename) => new Response(bytes, {
  status: 200,
  headers: {
    "Content-Type": "application/pdf",
    "Content-Security-Policy": "frame-ancestors 'self'",
    "Content-Disposition": `inline; filename="${filename}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  },
});

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
  now = clock(),
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

  const who = await whoIs(req, env, stores);

  if (who.refused) return json(401, { error: "Sign in required." });

  const { key } = who;

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "");
  const can = KEYS[key];

  // Every use is logged by the key's name, never its value.
  log.info({ event: "staging.key_used", key, method: req.method, path });
  const area = areaOf(req.method, path);

  if (area ? !can.includes(area) : key !== "owner session") {
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
      email: who.email || null,
      // A short name for this gate session, for what the browser keeps
      // once per session (the card overlay's flag). It opens nothing.
      session: who.tag ? who.tag.slice(0, 16) : null,
      clock: clockOf(req, env),
    });
  }

  if (path === "/api/staging/clock") {
    if (!clockAllowed(env)) return json(404, { error: "Not found." });
    if (req.method === "GET") return json(200, clockOf(req, env));
    if (req.method === "DELETE") {
      log.info({ event: "staging.clock_reset" });

      return json(200, { offset: 0, now: new Date().toISOString() }, {
        "Set-Cookie": clockCookie(null),
      });
    }
    if (req.method !== "PUT") {
      return json(405, { error: "GET, PUT or DELETE." });
    }

    const body = (await readJson(req)) || {};
    const at = Date.parse(body.at);
    const offset = at - Date.now();

    if (Number.isNaN(at) || Math.abs(offset) > MAX_OFFSET) {
      return json(400, { error: "A date and time within three years." });
    }
    log.info({ event: "staging.clock_set", offset });

    return json(200, { offset, now: new Date(at).toISOString() }, {
      "Set-Cookie": clockCookie(offset),
    });
  }

  if (path === "/api/staging/outbox" || path === "/api/staging/sent") {
    const all = path === "/api/staging/sent";
    const keys = (await stores.jobs.list(OUTBOX_PREFIX)).map((k) => k.key);
    const found = (await Promise.all(
      keys.map(async (k) => [k, await stores.jobs.get(k)])
    )).filter(([, m]) => m && (all || mine(m, who)));

    if (req.method === "DELETE") {
      for (const [k] of found) await stores.jobs.delete(k);

      return json(200, { ok: true, removed: found.length });
    }
    if (req.method !== "GET") return json(405, { error: "GET or DELETE." });

    const messages = found.map(([, m]) => m).reverse().map((m) => (
      withheld(m, who)
        ? { id: m.id, at: m.at, to: m.to, subject: m.subject, withheld: true }
        : {
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
    const res = m && (file[1] === "emails" || opens(m, who))
      && fileResponse(m, decodeURIComponent(file[3]));

    return res || json(404, { error: "No such attachment." });
  }

  if (req.method === "GET" && path.startsWith("/api/staging/outbox/")) {
    const id = decodeURIComponent(path.slice("/api/staging/outbox/".length));
    const m = await stores.jobs.get(`${OUTBOX_PREFIX}${id}`);

    // Another session's, or a sign-in link not theirs: as if absent.
    if (!m || !opens(m, who)) return json(404, { error: "No such message." });

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

  if (req.method === "GET" && path === "/api/staging/slips") {
    return json(200, { slips: pages(), today: today(now, terms.timeZone) });
  }

  // The packet the morning job would build from staging's orders for a
  // day (?date=YYYY-MM-DD, default today), read-only.
  if (req.method === "GET" && path === "/api/staging/slips/today") {
    const date = url.searchParams.get("date")
      || today(now, terms.timeZone);

    const day = new Date(`${date}T00:00:00Z`);
    const real = /^\d{4}-\d{2}-\d{2}$/.test(date)
      && !Number.isNaN(day.getTime())
      && day.toISOString().startsWith(date);

    if (!real) {
      return json(400, { error: "Give the date as YYYY-MM-DD." });
    }

    const { bytes } = await packetPreview(stores, date, { env, now });

    return bytes ? pdfResponse(bytes, packetFile(date)) : json(404, {
      error: "Nothing to pack for that day.",
    });
  }

  if (req.method === "GET" && path.startsWith("/api/staging/slips/")) {
    let id = null;

    try {
      id = decodeURIComponent(path.slice("/api/staging/slips/".length));
    } catch {
      // Bad percent-encoding names no page.
    }

    return id !== null && has(id) ? pdfResponse(buildSlip(id, env), `${id}.pdf`)
      : json(404, { error: "No such page." });
  }

  if (req.method === "POST" && path === "/api/staging/jobs/run") {
    const body = (await readJson(req)) || {};
    const time = /^(\d{2}):(\d{2})$/.exec(String(body.time || ""));
    // A time of day is on the day this browser's clock reads.
    const at = body.at ? new Date(body.at)
      : time ? instant(today(now, terms.timeZone), Number(time[1]),
        Number(time[2]), terms.timeZone)
        : now;

    // No further from the real time than the clock may go; the sweeps
    // keep the real time whatever this is (lib/jobs.mjs, realNow).
    if (Number.isNaN(at.getTime())
      || Math.abs(at.getTime() - Date.now()) > MAX_OFFSET) {
      return json(400, { error: "Bad at: within three years of now." });
    }
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
