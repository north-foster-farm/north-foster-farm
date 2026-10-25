// Farm news by email.
//
//   POST /api/news/subscribe   { email, firstName? }  mails the
//                              confirmation link (#303); answers
//                              { ok: true } for any address that looks
//                              like one, so the list cannot be probed
//                              from here
//   GET  /api/news/confirm     ?token=  that link's click, which puts
//                              the address on the list; lands on
//                              /news/ with ?news=confirmed, expired or
//                              invalid
//   POST /api/news/unsubscribe ?token= or { token }  off the list in
//                              one click (T6c): the welcome's link, by
//                              way of /news/, or a mail app's
//                              List-Unsubscribe-Post; no sign-in, so
//                              it takes requests from any site

import {
  fieldError,
} from "../../assets/scripts/utils/field-errors.mjs";
import { sameSite } from "./lib/auth.mjs";
import { now as clock } from "./lib/clock.mjs";
import { json, readJson } from "./lib/http.mjs";
import { log, withLog } from "./lib/log.mjs";
import { sendMail } from "./lib/mail.mjs";
import { gate } from "./lib/maintenance.mjs";
import { confirmSubscribe, subscribe, unsubscribe } from "./lib/news.mjs";
import { noteInteraction } from "./lib/retention.mjs";
import { siteUrl } from "./lib/site.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

// The page a sign-up came from, for the consent log: the path of a
// same-site Referer, or "".
const fromPage = (req) => {
  try {
    const ref = new URL(req.headers.get("referer") || "");

    return ref.host === new URL(req.url).host ? ref.pathname.slice(0, 100)
      : "";
  } catch {
    return "";
  }
};

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = clock(),
  mail = sendMail,
} = {}) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  // Sign-ups are closed under maintenance, the confirm link included
  // (it is not spent); unsubscribing is not (#267).
  if (req.method === "POST" && path === "/api/news/subscribe") {
    const closed = await gate(stores);

    if (closed) return closed;
    if (!sameSite(req)) return json(403, { error: "Cross-site request." });

    const body = await readJson(req);

    if (!body) return json(400, { errors: { body: "Expected JSON." } });

    const r = await subscribe(stores, body, {
      now, env, mail, page: fromPage(req),
    });

    if (!r.ok && r.reason === "invalid") {
      return json(422, {
        errors: { email: fieldError("email", body.email) },
      });
    }
    // A rate-limited address gets the same answer as any other: its
    // link is on the way already.
    log.info({ event: "news.subscribed", ok: r.ok, reason: r.reason || null });

    return json(200, { ok: true });
  }

  if (req.method === "GET" && path === "/api/news/confirm") {
    const closed = await gate(stores, { html: true });

    if (closed) return closed;

    const r = await confirmSubscribe(stores, url.searchParams.get("token"),
      { now, env, mail });

    // The link proves the address is theirs, so it counts as an
    // interaction (#189). The sign-up form above does not: anyone can
    // type any address into it.
    if (r.ok) await noteInteraction(stores, r.email, "sign-up", { now });

    const status = r.ok ? "confirmed"
      : (r.reason === "expired" ? "expired" : "invalid");

    log.info({ event: "news.confirmed", ok: r.ok, reason: r.reason || null });

    return new Response(null, {
      status: 303,
      headers: { Location: `${siteUrl(env)}/news/?news=${status}` },
    });
  }

  if (req.method === "POST" && path === "/api/news/unsubscribe") {
    const body = (req.headers.get("content-type") || "")
      .includes("application/json") ? await readJson(req) : null;
    const token = url.searchParams.get("token") || (body && body.token);
    const r = await unsubscribe(stores, token, { now });

    log.info({
      event: "news.unsubscribed", ok: r.ok, reason: r.reason || null,
    });

    return r.ok ? json(200, { ok: true })
      : json(404, { errors: { token: "That link isn't valid." } });
  }

  return json(404, { error: "Not found." });
};

export default withLog("news", (req) => handle(req));

export const config = {
  path: ["/api/news/*"],
};
