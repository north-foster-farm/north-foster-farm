// The terms of data/delivery.json with the pickup sites of
// data/markets.json added as `markets`, for the code that books or
// prints a market pickup.

import terms from "../../../data/delivery.json" with { type: "json" };
import markets from "../../../data/markets.json" with { type: "json" };
import {
  pickupSites,
} from "../../../assets/scripts/order/lib/sites.mjs";

export default { ...terms, markets: pickupSites(markets.markets) };
