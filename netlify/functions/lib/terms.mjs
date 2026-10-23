// The terms of data/delivery.json with the farm's scheduled pickups
// added as `model`: the locations of data/locations.json and the
// series of data/series.json (lib/events.mjs), for the code that books
// or prints a scheduled pickup.

import terms from "../../../data/delivery.json" with { type: "json" };
import locations from "../../../data/locations.json" with { type: "json" };
import series from "../../../data/series.json" with { type: "json" };
import {
  buildModel,
} from "../../../assets/scripts/order/lib/events.mjs";

export default {
  ...terms, model: buildModel(locations.locations, series.series),
};
