// GET /api/dates: the three date lists and the server clock, computed
// now rather than at build time; on-farm pickup's from the farm's
// schedule (PICKUP_SCHEDULE), each date with its windows.

import terms from "../../data/delivery.json" with { type: "json" };
import { allDates } from "../../assets/scripts/order/lib/dates.mjs";
import { json } from "./lib/http.mjs";
import { pickupSchedule } from "./lib/pickups.mjs";

export default async () =>
  json(200, allDates(new Date(), terms, pickupSchedule()));

export const config = {
  path: "/api/dates",
  method: "GET",
};
