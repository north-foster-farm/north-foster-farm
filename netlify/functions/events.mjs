// GET /api/events: every occurrence within the horizon that the farm
// attends (pickup or attend), with its status, for the home page and
// the map. Skipped occurrences are left out.

import terms from "./lib/terms.mjs";
import { eventDates } from "../../assets/scripts/order/lib/dates.mjs";
import { now as clock } from "./lib/clock.mjs";
import { json } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import { pickupSchedule } from "./lib/pickups.mjs";

export default withLog("events", async () => {
  const now = clock();

  return json(200, {
    now: now.toISOString(),
    events: eventDates(now, terms, pickupSchedule()),
  });
});

export const config = {
  path: "/api/events",
  method: "GET",
};
