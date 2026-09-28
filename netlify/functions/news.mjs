// Farm news by email.
//
//   POST /api/news/subscribe   { email, firstName? }  on the list at
//                              once; answers { ok: true } for any
//                              address that looks like one, so the
//                              list cannot be probed from here
//   GET  /api/news/confirm     ?token=  the old list's click (bin/nff
//                              audience invite); lands on /news/ with
//                              ?news=confirmed, expired or invalid
//   POST /api/news/unsubscribe ?token= or { token }  off the list in
//                              one click (T6c): the welcome's link, by
//                              way of /news/, or a mail app's
//                              List-Unsubscribe-Post; no sign-in, so
//                              it takes requests from any site

import { sameSite } from "./lib/auth.mjs";
import { json, readJson } from "./lib/http.mjs";
import { log, withLog } from "./lib/log.mjs";
import { sendMail } from "./lib/mail.mjs";
import { confirmSubscribe, subscribe, unsubscribe } from "./lib/news.mjs";
import { siteUrl } from "./lib/site.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = new Date(),
  mail = sendMail,
} = {}) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (req.method === "POST" && path === "/api/news/subscribe") {
    if (!sameSite(req)) return json(403, { error: "Cross-site request." });

    const body = await readJson(req);

    if (!body) return json(400, { errors: { body: "Expected JSON." } });

    const r = await subscribe(stores, body, { now, env, mail });

    if (!r.ok && r.reason === "invalid") {
      return json(422, {
        errors: { email: "That email address doesn't look right." },
      });
    }
    // A rate-limited address gets the same answer as any other: it
    // is on the list already.
    log.info({ event: "news.subscribed", ok: r.ok, reason: r.reason || null });

    return json(200, { ok: true });
  }

  if (req.method === "GET" && path === "/api/news/confirm") {
    const r = await confirmSubscribe(stores, url.searchParams.get("token"),
      { now });
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

export default withLog((req) => handle(req));

export const config = {
  path: ["/api/news/*"],
};
