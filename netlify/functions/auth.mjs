// Sign-in, sign-out and "who am I":
//
//   POST /api/auth/request   { email, next }  -> 200 always (no leaks)
//   GET  /api/auth/verify?token=...            -> 302 to next, cookie set
//   POST /api/auth/signout                     -> 204, cookie cleared
//   GET  /api/me                               -> { signedIn, customer }

import {
  clearCookieHeader, clearStampHeader, cookieHeader, createSession,
  endSession, normalizeEmail, publicCustomer, requestLink, safeNext, sameSite,
  sessionFrom, stampHeader, tokenEmail, verifyToken,
} from "./lib/auth.mjs";
import { now as clock, real } from "./lib/clock.mjs";
import { json, readJson } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import {
  MESSAGE, gate, isAdminAddress, readState,
} from "./lib/maintenance.mjs";
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
  now = clock(),
  ip = "",
  mail,
} = {}) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  // Sign-in and sign-up are closed under maintenance (#267). The link
  // in an email is not spent: it works once maintenance ends.
  if (path === "/api/auth/request" && req.method === "POST") {
    // An admin address may still ask for a link, so an admin with no
    // session can get in to test; the link goes only to that mailbox.
    const body = await readJson(req);
    const admin = body && isAdminAddress(normalizeEmail(body.email), env);
    const closed = admin ? null : await gate(stores);

    if (closed) return closed;
    if (!sameSite(req)) return json(403, { error: "Cross-site request." });

    if (!body || typeof body !== "object") {
      return json(400, { errors: { body: "Expected a JSON body." } });
    }
    if (body.website || rateLimited(ip, real(now).getTime())) {
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
    const closed = isAdminAddress(await tokenEmail(stores, token), env)
      ? null
      : await gate(stores, { html: true });

    if (closed) return closed;

    const result = await verifyToken(stores, token, {
      now,
    });

    if (!result.ok) {
      return redirect(`/login/?error=${result.reason}`);
    }

    const session = await createSession(stores, result.email, {
      now, via: "link",
    });

    return redirect(safeNext(result.next), [
      ["Set-Cookie", cookieHeader(session.id)],
      ["Set-Cookie", stampHeader(now)],
      ["Cache-Control", "no-store"],
    ]);
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
    // Sessions survive maintenance; this tells the pages to show the
    // message instead of the account.
    const state = await readState(stores);
    // An admin's pages stay open (the bypass in lib/maintenance.mjs).
    const closed = state.on && !(session
      && isAdminAddress(session.email, env))
      ? { maintenance: true, message: MESSAGE }
      : {};

    if (!session) return json(200, { signedIn: false, ...closed });

    return json(200, {
      ...closed,
      signedIn: true,
      via: session.via,
      customer: publicCustomer(session.customer),
    });
  }

  return json(404, { error: "Not found." });
};

export default withLog("auth", async (req, context) =>
  handle(req, { ip: context && context.ip }));

export const config = {
  path: [
    "/api/auth/request", "/api/auth/verify", "/api/auth/signout", "/api/me",
  ],
};
