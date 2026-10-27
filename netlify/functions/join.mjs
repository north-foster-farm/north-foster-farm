// A buying group's sign-up page (#495), /join/?t=<join token>:
//
//   POST /api/join/check    { token }
//     200 { ok, group: { name }, signedIn, already, elsewhere }
//     404 { ok: false, message }    a token not in force
//   POST /api/join/request  { token, email, firstName, lastName, news }
//     200 { ok: true }              the link is on its way (or was)
//     404 a dead token              422 { errors }
//   POST /api/join          { token }    signed in: joins now
//     200 { ok: true, next }        409 { ok: false, message }
//     401 not signed in             404 a dead token
//
// 429 for too many dead tokens from one address. The group's place and
// prices are not told here: the order page asks /api/group as before.

import { sameSite, sessionFrom } from "./lib/auth.mjs";
import { now as clock, real } from "./lib/clock.mjs";
import { memberKeyOf } from "./lib/groups.mjs";
import { json, readJson } from "./lib/http.mjs";
import {
  ELSEWHERE, INVALID_LINK, checkToken, joinNow, requestJoin,
} from "./lib/join.mjs";
import { withLog } from "./lib/log.mjs";
import { gate } from "./lib/maintenance.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

// Per instance, best effort, on dead tokens only, like the group
// code's: a token is 43 characters from 64, so a script gains nothing.
export const RATE = { windowMs: 10 * 60_000, max: 10 };
const misses = new Map();

const recent = (ip, at) =>
  (misses.get(ip) || []).filter((t) => at - t < RATE.windowMs);

const limited = (ip, at) => !!ip && recent(ip, at).length >= RATE.max;

const missed = (ip, at) => {
  if (ip) misses.set(ip, [...recent(ip, at), at]);
};

// Links asked for from one address, as the sign-in form limits them
// (auth.mjs): past it, the answer is the same and nothing is sent.
export const SEND_RATE = { windowMs: 10 * 60_000, max: 20 };
const sends = new Map();

const tooManySends = (ip, at) => {
  if (!ip) return false;

  const kept = (sends.get(ip) || [])
    .filter((t) => at - t < SEND_RATE.windowMs);

  kept.push(at);
  sends.set(ip, kept);

  return kept.length > SEND_RATE.max;
};

// Draft wording: names what was tried (#400).
export const TOO_MANY = "There have been too many tries to open a link " +
  "to join a group. Wait a few minutes and try again.";

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = clock(),
  ip = "",
  mail,
} = {}) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");

  if (req.method !== "POST") return json(404, { error: "Not found." });
  if (!sameSite(req)) return json(403, { error: "Cross-site request." });

  const body = await readJson(req);

  if (!body || typeof body !== "object" || typeof body.token !== "string") {
    return json(400, { errors: { body: "Expected JSON with a token." } });
  }

  const at = real(now).getTime();

  if (limited(ip, at)) return json(429, { ok: false, message: TOO_MANY });

  const dead = () => {
    missed(ip, at);

    return json(404, { ok: false, message: INVALID_LINK });
  };

  if (path === "/api/join/check") {
    const checked = await checkToken(stores, body.token);

    if (!checked.ok) return dead();

    const session = await sessionFrom(stores, req, { now });
    const own = session ? memberKeyOf(session.customer) : null;

    return json(200, {
      ok: true,
      group: { name: checked.group.name },
      signedIn: !!session,
      already: own === checked.group.key,
      elsewhere: !!own && own !== checked.group.key,
    });
  }

  // Joining is closed under maintenance, as signing in is (#267).
  const closed = await gate(stores);

  if (closed) return closed;

  if (path === "/api/join/request") {
    // A bot filling the hidden field, or too many links from one
    // address, is told it worked.
    if (body.website || tooManySends(ip, at)) return json(200, { ok: true });

    const r = await requestJoin(stores, body, { now, env, mail });

    if (r.invalid) return dead();
    if (r.errors) return json(422, { errors: r.errors });

    return json(200, { ok: true });
  }

  if (path === "/api/join") {
    const session = await sessionFrom(stores, req, { now });

    if (!session) return json(401, { ok: false, error: "Sign in first." });

    const r = await joinNow(stores, session.email, { token: body.token },
      { now });

    if (r.invalid) return dead();
    if (r.elsewhere) return json(409, { ok: false, message: ELSEWHERE });

    return json(200, { ok: true, next: r.path });
  }

  return json(404, { error: "Not found." });
};

export default withLog("join", async (req, context) =>
  handle(req, { ip: context && context.ip }));

export const config = {
  path: ["/api/join", "/api/join/check", "/api/join/request"],
  method: "POST",
};
