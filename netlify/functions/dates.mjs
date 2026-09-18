// GET /api/dates: the three date lists and the server clock, computed
// now rather than at build time.

import terms from "../../data/delivery.json" with { type: "json" };
import { allDates } from "../../assets/scripts/order/lib/dates.mjs";
import { json } from "./lib/http.mjs";

export default async () => json(200, allDates(new Date(), terms));

export const config = {
  path: "/api/dates",
  method: "GET",
};
