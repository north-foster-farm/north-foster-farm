// Sign-in, sign-out and "who am I":
//
//   POST /api/auth/request   { email, next }  -> 200 always (no leaks)
//   GET  /api/auth/verify?token=...            -> 302 to next, cookie set
//   POST /api/auth/signout                     -> 204, cookie cleared
//   GET  /api/me                               -> { signedIn, customer }

import {
  fieldError,
} from "../../assets/scripts/utils/field-errors.mjs";
import {
  clearCookieHeader, clearStampHeader, cookieHeader, createSession,
  endSession, hasStamp, normalizeEmail, peekToken, publicCustomer,
  requestLink, safeNext, sameSite, sessionFrom, stampHeader, tokenEmail,
  verifyToken,
} from "./lib/auth.mjs";
import { finishEmailChange } from "./lib/email-change.mjs";
import { creditBalance } from "./lib/credit.mjs";
import { groupOf, memberKeyOf, namedGroup } from "./lib/groups.mjs";
import { finishJoin } from "./lib/join.mjs";
import { roleOf } from "./lib/membership.mjs";
import { cartOwner } from "./lib/records.mjs";
import { now as clock, real } from "./lib/clock.mjs";
import { json, noCopy, readJson } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import {
  MESSAGE, gate, isAdminAddress, readState,
} from "./lib/maintenance.mjs";
import { noteInteraction } from "./lib/retention.mjs";
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
  status: 302, headers: [["Location", noCopy(location)], ...headers],
});

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = clock(),
  ip = "",
  mail,
  fetchImpl,
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
        errors: { email: fieldError("email", body.email) },
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

    // A change link is only peeked at here, never spent: a prefetch
    // or a scanner following the emailed link must not move the
    // account on its own (#240). The token travels on to the confirm
    // step in the fragment, which the server never sees again, so it
    // never reaches a log. The step is on the account page (#345);
    // `from` is only a hint for the page, which sends a browser signed
    // in as anyone else to the sign-in page's card. The POST below
    // decides, from the token alone. A plain sign-in link still works
    // in one GET.
    const peek = await peekToken(stores, token, { now });

    if (!peek.ok) return redirect(`/login/?error=${peek.reason}`);
    if (peek.changeFrom) {
      return redirect(`/account/#confirm=${encodeURIComponent(token)}` +
        `&email=${encodeURIComponent(peek.email)}` +
        `&from=${encodeURIComponent(peek.changeFrom)}`);
    }

    const result = await verifyToken(stores, token, { now });

    if (!result.ok) return redirect(`/login/?error=${result.reason}`);

    const session = await createSession(stores, result.email, {
      now, via: "link",
    });

    // Signing in is an interaction (#189), taken back if the session
    // only opts out (lib/retention.mjs).
    await noteInteraction(stores, session.email, "sign-in", {
      now, session: session.id,
    });

    // A link from a group's sign-up page (#495) joins the group too,
    // and lands on Membership, or on the account when it joined none.
    const landing = result.join
      ? (await finishJoin(stores, session.email, result.join, {
        now, env, mail,
      })).path
      : result.next;

    return redirect(safeNext(landing), [
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

    // Under maintenance the link is not spent, as with the GET above.
    const closed = isAdminAddress(await tokenEmail(stores, body.token), env)
      ? null
      : await gate(stores);

    if (closed) return closed;

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
    // Sessions survive maintenance; this tells the pages to show the
    // message instead of the account.
    const state = await readState(stores);
    // An admin's pages stay open (the bypass in lib/maintenance.mjs).
    const closed = state.on && !(session
      && isAdminAddress(session.email, env))
      ? { maintenance: true, message: MESSAGE }
      : {};

    if (!session) {
      return json(200, { signedIn: false, ...closed },
        hasStamp(req) ? { "Set-Cookie": clearStampHeader() } : {});
    }

    // A buying group's member (#471) sees their group and their
    // credit on the account page: the name as the farm set it, and
    // the balance in cents, read from the ledger now.
    const group = groupOf(memberKeyOf(session.customer));
    const member = group
      ? {
        key: group.key,
        name: (await namedGroup(stores, group)).name,
        credit: await creditBalance(stores, session.email, now),
      }
      : null;

    // A group's member or host (#495) has the Membership tab and its
    // entry in the header's menu; no one else sees either.
    const role = await roleOf(stores, session);
    // Credit is the account's (#495, decision 6): kept after leaving a
    // group, shown in the account's head and taken off any signed-in
    // order, as the order handler does.
    const kept = member ? 0 : await creditBalance(stores, session.email, now);

    // `owner`: the tag of this account's cart draft (#149).
    return json(200, {
      ...closed,
      signedIn: true,
      via: session.via,
      customer: publicCustomer(session.customer),
      owner: cartOwner(session.email),
      ...(member ? { member } : {}),
      ...(role ? { membership: true } : {}),
      ...(kept > 0 ? { credit: kept } : {}),
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
