// Farm news by email.
//
//   POST /api/news/subscribe   { email, firstName? }  mails the one-click
//                              confirmation; answers { ok: true } for
//                              any address that looks like one, so the
//                              list cannot be probed from here
//   GET  /api/news/confirm     ?token=  the click; lands on /news/ with
//                              ?news=confirmed, expired or invalid

import { sameSite } from "./lib/auth.mjs";
import { json, readJson } from "./lib/http.mjs";
import { log, withLog } from "./lib/log.mjs";
import { confirmSubscribe, requestSubscribe } from "./lib/news.mjs";
import { siteUrl } from "./lib/site.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = new Date(),
  mail,
} = {}) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (req.method === "POST" && path === "/api/news/subscribe") {
    if (!sameSite(req)) return json(403, { error: "Cross-site request." });

    const body = await readJson(req);

    if (!body) return json(400, { errors: { body: "Expected JSON." } });

    const r = await requestSubscribe(stores, body, { now, env, mail });

    if (!r.ok && r.reason === "invalid") {
      return json(422, {
        errors: { email: "That email address doesn't look right." },
      });
    }
    // A rate-limited address gets the same answer as any other: the
    // email it already has is the one to open.
    log.info({ event: "news.requested", ok: r.ok, reason: r.reason || null });

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

  return json(404, { error: "Not found." });
};

export default withLog((req) => handle(req));

export const config = {
  path: ["/api/news/*"],
};
