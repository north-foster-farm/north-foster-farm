// The pickup schedule every test runs against (test/setup.mjs sets it
// as PICKUP_SCHEDULE): each weekday of October and November 2026, a
// morning and an afternoon window, like the fixed pair before W11d.

import { addDays, weekday } from "../assets/scripts/order/lib/zoned.mjs";

export const MORNING = "09:00-12:00";
export const AFTERNOON = "13:00-17:00";

const days = [];

for (let d = "2026-10-01"; d <= "2026-11-30"; d = addDays(d, 1)) {
  if (weekday(d) >= 1 && weekday(d) <= 5) {
    days.push(`${d} ${MORNING} ${AFTERNOON}`);
  }
}

export const SCHEDULE = days.join("\n");
