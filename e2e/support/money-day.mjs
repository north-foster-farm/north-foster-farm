// The money rules for a day, and the day to run a test on (#362).
// data/delivery.json holds today's prices under `money` and the ones
// that start later under `money.changes`; the page and /api/orders
// both read them through `moneyOn` for the day on the site's clock.
//
// DAYS is today and the first day of every change still to come, so a
// spec that runs its money tests once per day checks the rules in
// force now and every set the data has queued, before the day comes.
// Once the last change is past, DAYS is today alone.
//
// A day other than today is reached with the business clock's offset
// (the `nff_clock` cookie, netlify/functions/lib/clock.mjs). The
// functions honor it in the dev and branch-deploy contexts only, so
// the local e2e build takes it; the page follows the functions' clock
// through /api/dates (assets/scripts/order/date-lists.js).

import terms from "../../data/delivery.json" with { type: "json" };
import { moneyOn } from "../../assets/scripts/order/lib/money-on.mjs";
import { today } from "../../assets/scripts/order/lib/zoned.mjs";

export const TODAY = today(new Date(), terms.timeZone);

export const DAYS = [...new Set([TODAY,
  ...(terms.money.changes || []).map((c) => c.from)
    .filter((day) => day > TODAY)])].sort();

export const moneyFor = (day) => moneyOn(terms.money, day);

// Noon on `day` in the farm's zone, give or take its daylight hour:
// well inside the day either way.
const noon = (day) => Date.parse(`${day}T12:00:00-05:00`);

// Moves this context's site clock to noon on `day`; today leaves it.
// The cookie covers the page and `context.request` alike.
export const onDay = async (context, baseURL, day) => {
  if (day === TODAY) return;

  await context.addCookies([{
    name: "nff_clock", value: String(noon(day) - Date.now()), url: baseURL,
  }]);
};
