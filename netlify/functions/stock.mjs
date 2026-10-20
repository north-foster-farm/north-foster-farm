// GET /api/stock: what can be bought right now, for every catalog
// item. The page asks on load, on return to the tab and before it
// submits, so a cart never holds what just sold out. Each read also
// tells the farm, once a day, of an archived product stock has on
// hand (#267).

import { json } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import { archivedInStock, availability } from "./lib/stock.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

export const handle = async (req, {
  stores = defaultStores(),
  now = new Date(),
  env = process.env,
  mail,
  catalogIndex,
} = {}) => {
  const items = await availability(stores, { catalogIndex });

  await archivedInStock(stores, { env, mail, now, catalogIndex });

  return json(200, { at: now.toISOString(), items });
};

export default withLog("stock", async (req) => handle(req));

export const config = {
  path: "/api/stock",
  method: "GET",
};
