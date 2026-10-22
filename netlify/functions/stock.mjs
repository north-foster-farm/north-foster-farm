// GET /api/stock: what can be bought right now, for every catalog
// item. The page asks on load, on return to the tab and before it
// submits, so a cart never holds what just sold out. Each read also
// tells the farm, once a day, of an archived product stock has on
// hand (#267).
//
// Square's counts come from a snapshot no older than 15 s
// (lib/stock.mjs, SNAPSHOT), and in production one address may ask
// 120 times in ten minutes, about one every 5 s, before a 429. The
// page then keeps what it had, and the order check still reads
// Square fresh. Staging has no limit: the QA suite's browsers share
// one address and send no token with the page's own fetch.

import { now as clock, real } from "./lib/clock.mjs";
import { json } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import {
  archivedInStock, availability, liveCounts,
} from "./lib/stock.mjs";
import { deployContext, stores as defaultStores } from "./lib/store.mjs";

// Per-instance, best effort, as /api/orders.
const RATE = { windowMs: 10 * 60_000, max: 120 };
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
  now = clock(),
  env = process.env,
  ip = "",
  mail,
  catalogIndex,
  inventory,
} = {}) => {
  if (deployContext(env) === "production"
    && rateLimited(ip, real(now).getTime())) {
    return new Response(JSON.stringify({ message: "Too many tries." }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Retry-After": String(RATE.windowMs / 1000),
      },
    });
  }

  // One read of Square for both (#267).
  const counts = await liveCounts(stores, {
    catalogIndex, env, inventory, snapshot: true, now,
  });
  const items = await availability(stores, { catalogIndex, counts });

  await archivedInStock(stores, { env, mail, now, catalogIndex, counts });

  return json(200, { at: now.toISOString(), items });
};

export default withLog("stock", async (req, context) =>
  handle(req, { ip: context && context.ip }));

export const config = {
  path: "/api/stock",
  method: "GET",
};
