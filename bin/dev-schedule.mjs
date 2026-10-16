// A pickup schedule made up for development (#264): every weekday, a
// morning and an afternoon window, like the fixed pair before W11d.
// The test fixture is this generator over fixed dates; bin/nff and
// `npm run start:functions` use it from today, so a fresh clone needs
// no PICKUP_SCHEDULE in .env. Netlify contexts get theirs from
// `bin/nff schedule set`, never from here.

import terms from "../data/delivery.json" with { type: "json" };
import {
  addDays, today, weekday,
} from "../assets/scripts/order/lib/zoned.mjs";

export const MORNING = "09:00-12:00";
export const AFTERNOON = "13:00-17:00";

// How far a development schedule reaches: past check:schedule's
// "week after next" with room to spare.
const DAYS_AHEAD = 42;

// From and to are ISO dates, both included. -> the variable's value,
// one date per line.
export const weekdaySchedule = (from, to) => {
  const days = [];

  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (weekday(d) >= 1 && weekday(d) <= 5) {
      days.push(`${d} ${MORNING} ${AFTERNOON}`);
    }
  }

  return days.join("\n");
};

export const devSchedule = (now = new Date()) => {
  const from = today(now, terms.timeZone);

  return weekdaySchedule(from, addDays(from, DAYS_AHEAD));
};
