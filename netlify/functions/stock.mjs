// GET /api/stock: what can be bought right now, for every catalog
// item. The page asks on load, as the customer shops, once a minute
// and before it submits, so a cart never holds what just sold out
// (#908; order/stock.js has the rhythm). Each read also
// tells the farm, once a day, of an archived product stock has on
// hand (#267).
//
// Square's counts come from a snapshot no older than 15 s
// (lib/stock.mjs, SNAPSHOT), and in production one address may ask
// 240 times in ten minutes before a 429 (#908, James's rule 6): five
// tabs of one household at the page's busiest rhythm. The page then
// keeps what it had, and the order check still reads Square fresh.
// The check right before paying (?final=1) is counted apart, so
// browsing never blocks a payment, under a cap of its own, so the
// flag is no way around the limit. Staging has no limit: the QA
// suite's browsers share one address and send no token with the
// page's own fetch.

import { now as clock, real } from "./lib/clock.mjs";
import { json } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import {
  archivedInStock, availability, liveCounts,
} from "./lib/stock.mjs";
import { applyPins, scopeOf } from "./lib/stock-pins.mjs";
import { deployContext, stores as defaultStores } from "./lib/store.mjs";

// Per-instance, best effort, as /api/orders. One bucket for browsing,
// one for the checks before paying.
const WINDOW_MS = 10 * 60_000;
const BROWSING = { max: 240, hits: new Map() };
const PAYING = { max: 60, hits: new Map() };

const rateLimited = (ip, now, bucket) => {
  if (!ip) return false;

  const recent = (bucket.hits.get(ip) || [])
    .filter((t) => now - t < WINDOW_MS);

  recent.push(now);
  bucket.hits.set(ip, recent);

  return recent.length > bucket.max;
};

// The check right before paying asks with ?final=1 (order/stock.js).
const paying = (req) => new URL(req.url).searchParams.get("final") === "1";

// Whether this ask is over its bucket's limit.
const limited = (req, ip, now) =>
  rateLimited(ip, now, paying(req) ? PAYING : BROWSING);

export const handle = async (req, {
  stores = defaultStores(),
  now = clock(),
  env = process.env,
  ip = "",
  mail,
  catalogIndex,
  inventory,
  // Where the farm's daily notice runs once the answer is out: the
  // platform's waitUntil for the real function; here it is awaited,
  // which tests rely on.
  after = (work) => work,
} = {}) => {
  if (deployContext(env) === "production"
    && limited(req, ip, real(now).getTime())) {
    return new Response(JSON.stringify({
      message: "We've checked stock too many times from here. Wait a " +
        "few minutes and try again.",
    }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Retry-After": String(WINDOW_MS / 1000),
      },
    });
  }

  // One read of Square for both (#267). A test's pins (#507) are laid
  // on the page's answer only: the farm's notice reads the real counts.
  const counts = await liveCounts(stores, {
    catalogIndex, env, inventory, snapshot: true, now,
  });
  const scope = scopeOf(req.headers, env);
  const items = await availability(stores, {
    catalogIndex,
    counts: scope
      ? await applyPins(stores, { ...counts }, { scope, env, now: real(now) })
      : counts,
  });

  // A slow or failing Resend must never cost the page its answer:
  // without stock the order page is shut (#333).
  await after(archivedInStock(stores, {
    env, mail, now, catalogIndex, counts,
  }));

  return json(200, { at: now.toISOString(), items });
};

export default withLog("stock", async (req, context) =>
  handle(req, {
    ip: context && context.ip,
    after: (work) => {
      if (context && typeof context.waitUntil === "function") {
        context.waitUntil(work);
      }
    },
  }));

export const config = {
  path: "/api/stock",
  method: "GET",
};
