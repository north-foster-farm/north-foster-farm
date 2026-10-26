// POST /api/group { code }: what a buying group's code unlocks (#471),
// so the order page can offer the group's pickup and price by its
// locked list. With no code, a signed-in member's own group. The
// answer is the group's name, its place and series (which the page
// never embeds), the price lock and its open rounds. The order
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
import {
  INVALID_CODE, findGroupByCode, groupOf, memberKeyOf, memberTerms,
  publicGroup,
} from "./lib/groups.mjs";
import { json, readJson } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import { pickupSchedule } from "./lib/pickups.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

// Per-instance, best effort: a minted code is eight characters from
// 31, so a script gains nothing within this, and a member mistyping
// has tries to spare.
export const RATE = { windowMs: 10 * 60_000, max: 10 };
const hits = new Map();

const rateLimited = (ip, now) => {
  if (!ip) return false;

  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);

  recent.push(now);
  hits.set(ip, recent);

  return recent.length > RATE.max;
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

  const session = typed ? null : await sessionFrom(stores, req, { now });
  const group = typed
    ? await findGroupByCode(stores, typed)
    : (session ? groupOf(memberKeyOf(session.customer)) : null);

  if (!group) return json(404, { ok: false, message: INVALID_CODE });

  return json(200, {
    ok: true,
    group: publicGroup(group),
    dates: groupDates(group, now, env),
  });
};

export default withLog("group", async (req, context) =>
  handle(req, { ip: context && context.ip }));

export const config = {
  path: "/api/group",
  method: "POST",
};
