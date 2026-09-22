// Sign-in, sign-out and "who am I":
//
//   POST /api/auth/request   { email, next }  -> 200 always (no leaks)
//                            { email, orderId }  "Find my order": the
//                            link goes to that order, if the pair match
//   GET  /api/auth/verify?token=...            -> 302 to next, cookie set
//   POST /api/auth/signout                     -> 204, cookie cleared
//   GET  /api/me                               -> { signedIn, customer }

import {
  clearCookieHeader, cookieHeader, createSession, endSession, publicCustomer,
  requestLink, requestOrderLink, safeNext, sameSite, sessionFrom,
  verifyToken,
} from "./lib/auth.mjs";
import { json, readJson } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

// Per-instance, best effort, like the order handler's.
const RATE = { windowMs: 10 * 60_000, max: 20 };
const hits = new Map();

const rateLimited = (ip, now) => {
  if (!ip) return false;

  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);

  recent.push(now);
  hits.set(ip, recent);

  return recent.length > RATE.max;
};

const redirect = (location, headers = {}) => new Response(null, {
  status: 302, headers: { Location: location, ...headers },
});

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = new Date(),
  ip = "",
  mail,
} = {}) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/api/auth/request" && req.method === "POST") {
    if (!sameSite(req)) return json(403, { error: "Cross-site request." });

    const body = await readJson(req);

    if (!body || typeof body !== "object") {
      return json(400, { errors: { body: "Expected a JSON body." } });
    }
    if (body.website || rateLimited(ip, now.getTime())) {
      return json(200, { ok: true });
    }

    const result = body.orderId
      ? await requestOrderLink(stores, body, { now, env, mail })
      : await requestLink(stores, body, { now, env, mail });

    if (!result.ok && result.reason === "invalid") {
      return json(422, {
        errors: { email: "That email address doesn't look right." },
      });
    }

    // Too many links: say nothing different, the earlier link still works.
    return json(200, { ok: true });
  }

  if (path === "/api/auth/verify" && req.method === "GET") {
    const result = await verifyToken(stores, url.searchParams.get("token"), {
      now,
    });

    if (!result.ok) {
      return redirect(`/login/?error=${result.reason}`);
    }

    const session = await createSession(stores, result.email, {
      now, via: "link", userAgent: req.headers.get("user-agent"),
    });

    return redirect(safeNext(result.next), {
      "Set-Cookie": cookieHeader(session.id),
      "Cache-Control": "no-store",
    });
  }

  if (path === "/api/auth/signout" && req.method === "POST") {
    if (!sameSite(req)) return json(403, { error: "Cross-site request." });

    const session = await sessionFrom(stores, req, { now });

    await endSession(stores, session && session.id);

    return new Response(null, {
      status: 204,
      headers: {
        "Set-Cookie": clearCookieHeader(), "Cache-Control": "no-store",
      },
    });
  }

  if (path === "/api/me" && req.method === "GET") {
    const session = await sessionFrom(stores, req, { now });

    if (!session) return json(200, { signedIn: false });

    return json(200, {
      signedIn: true,
      via: session.via,
      customer: publicCustomer(session.customer),
    });
  }

  return json(404, { error: "Not found." });
};

export default withLog(async (req, context) =>
  handle(req, { ip: context && context.ip }));

export const config = {
  path: [
    "/api/auth/request", "/api/auth/verify", "/api/auth/signout", "/api/me",
  ],
};
