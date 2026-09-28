// GET /api/pass?code=XXXX-XXXX: whether a pass (#182) would lift the
// delivery minimum, so the order page can let the order through. The
// answer is advice only: POST /api/orders checks the pass again with
// the order's email and holds it. Nothing about the pass is returned
// but whether it is good and, if not, why.
//
//   200 { ok: true, rideAlong? }     404 { ok: false, message }
// `rideAlong` says the pass makes the order a ride-along (#183), at no
// fee as well as no minimum, so the page can show the price.
//   429 too many tries from one address

import { json } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import {
  PASS_MESSAGES, getPass, passCodeOf, passProblem, ridesAlong,
} from "./lib/passes.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

// Per-instance, best effort, as /api/orders: a pass is eight
// characters from 31, so this only blunts a script.
const RATE = { windowMs: 10 * 60_000, max: 20 };
const hits = new Map();

const rateLimited = (ip, now) => {
  if (!ip) return false;

  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);

  recent.push(now);
  hits.set(ip, recent);

  return recent.length > RATE.max;
};

export const handle = async (req, {
  stores = defaultStores(),
  now = new Date(),
  ip = "",
} = {}) => {
  if (rateLimited(ip, now.getTime())) {
    return json(429, {
      ok: false, message: "Too many tries. Wait a few minutes.",
    });
  }

  const code = passCodeOf(new URL(req.url).searchParams.get("code"));
  const pass = code ? await getPass(stores, code) : null;
  const problem = code ? passProblem(pass, { now }) : "unknown";

  return problem
    ? json(404, { ok: false, message: PASS_MESSAGES[problem] })
    : json(200, ridesAlong(pass) ? { ok: true, rideAlong: true }
      : { ok: true });
};

export default withLog(async (req, context) =>
  handle(req, { ip: context && context.ip }));

export const config = {
  path: "/api/pass",
  method: "GET",
};
