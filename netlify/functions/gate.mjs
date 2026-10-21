// Signing in to a non-production deploy (the edge function in front of
// it, netlify/gate-edge/gate.mjs, lets these paths by):
//
//   GET  /api/gate/signin            the sign-in page
//   POST /api/gate/request           { email, next } -> the "check your
//                                    email" page, whoever asks
//   GET  /api/gate/verify?token=...  302 to next, session cookie set
//   POST /api/gate/signout           302 to the sign-in page
//   GET  /api/gate/me                { email, toolbar } for the toolbar
//
// A request for an address off the allowlist is answered exactly as
// one on it, and the link is mailed after the answer, so neither the
// words nor the time give the list away. Rate limits per address and
// per IP are in lib/gate.mjs. In production, and in any context the
// gate does not guard, every path here is a 404.

import {
  COOKIE, clearCookieHeader, cookieHeader, cookieValue, createSession,
  gateActive, normalize, requestLink, safeNext, sessionFor, sessionKey,
  verifyToken,
} from "./lib/gate.mjs";
import { sendLink } from "./lib/gate-mail.mjs";
import {
  checkEmailPage, invalidLinkPage, signInPage,
} from "./lib/gate-page.mjs";
import { json } from "./lib/http.mjs";
import { log, withLog } from "./lib/log.mjs";
import { deployContext, stores as defaultStores } from "./lib/store.mjs";

const html = (status, body, headers = []) => new Response(body, {
  status,
  headers: [
    ["Content-Type", "text/html; charset=utf-8"],
    ["Cache-Control", "no-store"],
    ["X-Robots-Tag", "noindex, nofollow, noarchive"],
    ...headers,
  ],
});

const redirect = (location, headers = []) => new Response(null, {
  status: 302,
  headers: [
    ["Location", location], ["Cache-Control", "no-store"], ...headers,
  ],
});

// A form from the sign-in page, or the same fields as JSON.
const readBody = async (req) => {
  const type = req.headers.get("content-type") || "";

  try {
    if (type.includes("application/json")) return await req.json();

    return Object.fromEntries(new URLSearchParams(await req.text()));
  } catch {
    return {};
  }
};

// Whether the address on a session is the toolbar's owner: James,
// named in GATE_TOOLBAR_EMAIL, never in code.
export const toolbarOwner = (email, env = process.env) =>
  !!env.GATE_TOOLBAR_EMAIL && !!email
  && normalize(email) === normalize(env.GATE_TOOLBAR_EMAIL);

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = new Date(),
  ip = "",
  after = () => {},
  fetchImpl = globalThis.fetch,
} = {}) => {
  if (!gateActive(deployContext(env))) {
    return json(404, { error: "Not found." });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const { gate } = stores;

  if (path === "/api/gate/signin" && req.method === "GET") {
    return html(200, signInPage({
      next: safeNext(url.searchParams.get("next")),
    }));
  }

  if (path === "/api/gate/request" && req.method === "POST") {
    const body = await readBody(req);

    // A filled honeypot gets the same page and nothing else.
    if (!body.website) {
      const result = await requestLink(gate, {
        email: body.email, next: body.next, ip,
      }, { now });

      if (result.issue) {
        const link = `${url.origin}/api/gate/verify?token=${result.token}`;

        after(sendLink({ to: result.email, url: link, key: null }, {
          env, stores, fetchImpl, now,
        }).then((sent) => {
          if (!sent.sent) {
            log.warn({ event: "gate.link_not_sent", reason: sent.reason });
          }
        }));
      }
    }

    return html(200, checkEmailPage());
  }

  if (path === "/api/gate/verify" && req.method === "GET") {
    const result = await verifyToken(gate, url.searchParams.get("token"), {
      now,
    });

    if (!result.ok) {
      return html(401, invalidLinkPage());
    }

    const id = await createSession(gate, result.email, now);

    log.info({ event: "gate.signed_in" });

    return redirect(safeNext(result.next), [["Set-Cookie", cookieHeader(id)]]);
  }

  if (path === "/api/gate/signout" && req.method === "POST") {
    const id = cookieValue(req.headers, COOKIE);

    if (id) {
      await gate.delete(await sessionKey(id));
    }

    return redirect("/api/gate/signin", [["Set-Cookie", clearCookieHeader()]]);
  }

  if (path === "/api/gate/me" && req.method === "GET") {
    const session = await sessionFor(gate, cookieValue(req.headers, COOKIE),
      now);

    return json(200, {
      signedIn: !!session,
      toolbar: !!session && toolbarOwner(session.email, env),
    });
  }

  return json(404, { error: "Not found." });
};

export default withLog("gate", async (req, context) =>
  handle(req, {
    ip: context && context.ip,
    after: (work) => {
      if (context && typeof context.waitUntil === "function") {
        context.waitUntil(work);
      }
    },
  }));

export const config = {
  path: "/api/gate/*",
};
