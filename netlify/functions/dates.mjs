// GET /api/dates: the three date lists and the server clock, computed
// now rather than at build time; on-farm pickup's from the farm's
// schedule (PICKUP_SCHEDULE), each date with its windows.

import terms from "../../data/delivery.json" with { type: "json" };
import { allDates } from "../../assets/scripts/order/lib/dates.mjs";
import { now as clock } from "./lib/clock.mjs";
import { json } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import { pickupSchedule } from "./lib/pickups.mjs";

export default withLog("dates", async () =>
  json(200, allDates(clock(), terms, pickupSchedule())));

export const config = {
  path: "/api/dates",
  method: "GET",
};
