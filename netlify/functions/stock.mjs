// GET /api/stock: what can be bought right now, for every catalog
// item. The page asks on load, on return to the tab and before it
// submits, so a cart never holds what just sold out.

import { json } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import { availability } from "./lib/stock.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

export const handle = async (req, {
  stores = defaultStores(),
  now = new Date(),
} = {}) => json(200, {
  at: now.toISOString(), items: await availability(stores),
});

export default withLog("stock", async (req) => handle(req));

export const config = {
  path: "/api/stock",
  method: "GET",
};
