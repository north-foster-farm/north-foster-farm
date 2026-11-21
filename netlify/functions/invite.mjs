// The invite page (#718), /invite/?t=<invite token>, the link the farm
// sends by hand:
//
//   POST /api/invite/check    { token }
//     200 { ok, perk: { type, name, parts, end } }
//     404 { ok: false, message }    a dead invite: used, expired,
//                                   revoked or never made
//   POST /api/invite/request  { token, email }
//     200 { ok: true }              the link is on its way (or was)
//     404 a dead invite, nothing mailed       422 { errors }
//
// 429 for a dead token from an address that sent too many of them, as
// the group sign-up page's (join.mjs); an open invite still works from
// there. The answer to a request is the same for every address: the
// link goes to the address typed, and nothing changes until it is
// followed (#521).

import {
  fieldError,
} from "../../assets/scripts/utils/field-errors.mjs";
import {
  perkName, perkParts,
} from "../../assets/scripts/order/lib/perks.mjs";
import {
  normalizeEmail, requestLink, sameSite, validEmail,
} from "./lib/auth.mjs";
import { now as clock, real } from "./lib/clock.mjs";
import { json, readJson } from "./lib/http.mjs";
import {
  INVALID_INVITE, INVITED_PATH, checkInvite, linkRecord,
} from "./lib/invites.mjs";
import { withLog } from "./lib/log.mjs";
import { gate } from "./lib/maintenance.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

// Per instance, best effort, on dead tokens only, as join.mjs: a
// token is 43 characters from 64, so a script gains nothing.
export const RATE = { windowMs: 5 * 60_000, max: 20 };
const misses = new Map();

const recent = (ip, at) =>
  (misses.get(ip) || []).filter((t) => at - t < RATE.windowMs);

const limited = (ip, at) => !!ip && recent(ip, at).length >= RATE.max;

const missed = (ip, at) => {
  if (ip) misses.set(ip, [...recent(ip, at), at]);
};

// Links asked for from one address, as the sign-in form limits them:
// past it, the answer is the same and nothing is sent.
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
export const TOO_MANY = "There have been too many tries to open an " +
  "invite link. Wait a few minutes and try again.";

// What the page says of the perk: its name and parts, as the cart and
// the account page name it (#717), and its last day.
const perkView = (invite) => ({
  type: invite.perk,
  name: perkName(invite.perk),
  parts: perkParts(invite.perk),
  end: invite.end || null,
});

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
  const held = limited(ip, at);

  const dead = () => {
    missed(ip, at);

    return held
      ? json(429, { ok: false, message: TOO_MANY })
      : json(404, { ok: false, message: INVALID_INVITE });
  };

  if (path === "/api/invite/check") {
    const checked = await checkInvite(stores, body.token, { now });

    if (!checked.ok) return dead();

    return json(200, { ok: true, perk: perkView(checked.invite) });
  }

  if (path === "/api/invite/request") {
    // Signing up is closed under maintenance, as signing in is (#267).
    const closed = await gate(stores);

    if (closed) return closed;

    const checked = await checkInvite(stores, body.token, { now });

    if (!checked.ok) return dead();
    // A bot filling the hidden field, or too many links from one
    // address, is told it worked.
    if (body.website || tooManySends(ip, at)) return json(200, { ok: true });

    const email = normalizeEmail(body.email);

    if (!validEmail(email)) {
      return json(422, { errors: { email: fieldError("email", body.email) } });
    }

    // Too many links for the address: the earlier one still works, and
    // the page says the same either way.
    await requestLink(stores, { email, next: INVITED_PATH }, {
      now, env, mail, invite: linkRecord(checked.invite),
    });

    return json(200, { ok: true });
  }

  return json(404, { error: "Not found." });
};

export default withLog("invite", async (req, context) =>
  handle(req, { ip: context && context.ip }));

export const config = {
  path: ["/api/invite/check", "/api/invite/request"],
  method: "POST",
};
