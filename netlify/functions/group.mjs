// POST /api/group { code }: what a buying group's code unlocks (#471),
// so the order page can offer the group's pickup and price by its
// locked list. With no code, a signed-in member's own group. The
// answer is the group's name, its place and series (which the page
// never embeds), the member price list and its open rounds. The order
// handler checks the code again when the order is placed.
//
//   200 { ok: true, group, dates }     404 { ok: false, message }
//   429 too many tries from one address
//
// Every miss says the same thing, and the page source carries no
// hash of the code (James, 6424477473): a group shows nothing of
// itself until its code is accepted.

import terms from "./lib/terms.mjs";
import { scheduledDates } from "../../assets/scripts/order/lib/dates.mjs";
import { sameSite, sessionFrom } from "./lib/auth.mjs";
import { now as clock } from "./lib/clock.mjs";
import { creditBalance } from "./lib/credit.mjs";
import {
  INVALID_CODE, findGroupByCode, groupOf, memberKeyOf, memberTerms,
  namedGroup, publicGroup,
} from "./lib/groups.mjs";
import { json, readJson } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import { pickupSchedule } from "./lib/pickups.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

// Per-instance, best effort, and on misses only (James, 6424477473):
// a minted code is eight characters from 31, so a script gains
// nothing within this, while a member whose page asks again on every
// load is never held back.
export const RATE = { windowMs: 10 * 60_000, max: 10 };
const misses = new Map();

const recentMisses = (ip, now) =>
  (misses.get(ip) || []).filter((t) => now - t < RATE.windowMs);

const rateLimited = (ip, now) => !!ip
  && recentMisses(ip, now).length >= RATE.max;

const missed = (ip, now) => {
  if (ip) misses.set(ip, [...recentMisses(ip, now), now]);
};

// The group's open rounds, as /api/dates would list them for a member.
export const groupDates = (group, now, env = process.env) =>
  scheduledDates(now, memberTerms(terms, group), pickupSchedule(env))
    .filter((d) => d.series === group.series);

export const handle = async (req, {
  stores = defaultStores(),
  now = clock(),
  ip = "",
  env = process.env,
} = {}) => {
  if (req.method !== "POST") return json(404, { error: "Not found." });
  if (!sameSite(req)) return json(403, { error: "Cross-site request." });

  const body = await readJson(req);

  if (body === null) return json(400, { errors: { body: "Expected JSON." } });

  const typed = typeof body.code === "string" ? body.code : "";

  if (typed && rateLimited(ip, now.getTime())) {
    return json(429, {
      ok: false,
      message: "There have been too many tries to apply a code. Wait " +
        "a few minutes and try again.",
    });
  }

  const session = await sessionFrom(stores, req, { now });
  const own = session ? memberKeyOf(session.customer) : null;
  const group = typed
    ? await findGroupByCode(stores, typed)
    : groupOf(own);

  if (!group) {
    if (typed) missed(ip, now.getTime());

    return json(404, { ok: false, message: INVALID_CODE });
  }

  // The name the farm set on the record, if any, is the one members
  // see: on the group, its series and its rounds.
  const named = await namedGroup(stores, group);
  const pub = publicGroup(named);

  pub.places.series = pub.places.series
    .map((s) => ({ ...s, name: named.name }));

  return json(200, {
    ok: true,
    group: pub,
    dates: groupDates(group, now, env).map((d) => ({ ...d, name: named.name })),
    // A member signed in learns their credit (#471), in cents, which
    // the order handler reads again from the ledger. A code alone
    // earns none: the account is what says the credit is theirs. The
    // order handler spends it for any signed-in order with a group,
    // typed or not, so the page is told the same.
    credit: session ? await creditBalance(stores, session.email, now) : 0,
    // A member signed in who types their own group's code again
    // (#495, edge 1): the page says they are in already.
    already: !!typed && own === group.key,
  });
};

export default withLog("group", async (req, context) =>
  handle(req, { ip: context && context.ip }));

export const config = {
  path: "/api/group",
  method: "POST",
};
