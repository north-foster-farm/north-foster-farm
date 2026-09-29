// Sign-in, sign-out and "who am I":
//
//   POST /api/auth/request   { email, next }  -> 200 always (no leaks)
//   GET  /api/auth/verify?token=...            -> 302 to next, cookie set
//   POST /api/auth/signout                     -> 204, cookie cleared
//   GET  /api/me                               -> { signedIn, customer }

import {
  clearCookieHeader, clearStampHeader, cookieHeader, createSession,
  endSession, peekToken, publicCustomer, requestLink, safeNext, sameSite,
  sessionFrom, stampHeader, verifyToken,
} from "./lib/auth.mjs";
import { finishEmailChange } from "./lib/email-change.mjs";
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

// Headers as [name, value] pairs, so Set-Cookie can repeat.
const redirect = (location, headers = []) => new Response(null, {
  status: 302, headers: [["Location", location], ...headers],
});

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = new Date(),
  ip = "",
  mail,
  fetchImpl,
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

    const result = await requestLink(stores, body, { now, env, mail });

    if (!result.ok && result.reason === "invalid") {
      return json(422, {
        errors: { email: "That email address doesn't look right." },
      });
    }

    // Too many links: say nothing different, the earlier link still works.
    return json(200, { ok: true });
  }

  if (path === "/api/auth/verify" && req.method === "GET") {
    const token = url.searchParams.get("token");
    // A change link is only peeked at here, never spent: a prefetch
    // or a scanner following the emailed link must not move the
    // account on its own (#240). The token travels on to the confirm
    // step in the fragment, which the server never sees again, so it
    // never reaches a log. A plain sign-in link still works in one GET.
    const peek = await peekToken(stores, token, { now });

    if (!peek.ok) return redirect(`/login/?error=${peek.reason}`);
    if (peek.changeFrom) {
      return redirect(`/login/#confirm=${encodeURIComponent(token)}` +
        `&email=${encodeURIComponent(peek.email)}`);
    }

    const result = await verifyToken(stores, token, { now });

    if (!result.ok) return redirect(`/login/?error=${result.reason}`);

    const session = await createSession(stores, result.email, {
      now, via: "link",
    });

    return redirect(safeNext(result.next), [
      ["Set-Cookie", cookieHeader(session.id)],
      ["Set-Cookie", stampHeader(now)],
      ["Cache-Control", "no-store"],
    ]);
  }

  // The confirm step's button: only a POST spends a change token
  // (#240), so the GET above can be prefetched safely.
  if (path === "/api/auth/verify" && req.method === "POST") {
    if (!sameSite(req)) return json(403, { error: "Cross-site request." });

    const body = await readJson(req);

    if (!body || typeof body.token !== "string") {
      return json(400, { errors: { body: "Expected a JSON body." } });
    }

    const result = await verifyToken(stores, body.token, { now });

    if (!result.ok) return json(200, { ok: false, reason: result.reason });

    // A link to a new address moves the account first (#240); the
    // move ends the old address's sessions, so this one starts fresh.
    if (result.changeFrom) {
      const moved = await finishEmailChange(stores, result, {
        now, env, mail, fetchImpl,
      });

      if (!moved.ok) return json(200, { ok: false, reason: moved.reason });
    }

    const session = await createSession(stores, result.email, {
      now, via: "link",
    });
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });

    headers.append("Set-Cookie", cookieHeader(session.id));
    headers.append("Set-Cookie", stampHeader(now));

    return new Response(JSON.stringify({
      ok: true, next: safeNext(result.next),
    }), { status: 200, headers });
  }

  if (path === "/api/auth/signout" && req.method === "POST") {
    if (!sameSite(req)) return json(403, { error: "Cross-site request." });

    const session = await sessionFrom(stores, req, { now });

    await endSession(stores, session && session.id);

    return new Response(null, {
      status: 204,
      headers: [
        ["Set-Cookie", clearCookieHeader()],
        ["Set-Cookie", clearStampHeader()],
        ["Cache-Control", "no-store"],
      ],
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
