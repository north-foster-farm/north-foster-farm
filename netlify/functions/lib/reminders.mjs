// Dated reminders for the farm, shown in the morning report from their
// day until they lapse. A change that takes effect on a date (data/
// delivery.json, money.changes) has no deploy to carry it, so nobody
// is prompted to do the by-hand part; the report prompts instead.

import terms from "../../../data/delivery.json" with { type: "json" };
import {
  dollars, toCents,
} from "../../../assets/scripts/order/lib/totals.mjs";
import { label } from "../../../assets/scripts/order/lib/zoned.mjs";

// How long before a money change its reminder starts, and how long
// after it the reminder is kept, in days.
export const LEAD_DAYS = 12;
export const KEEP_DAYS = 14;

const shift = (iso, days) => {
  const d = new Date(`${iso}T12:00:00Z`);

  d.setUTCDate(d.getUTCDate() + days);

  return d.toISOString().slice(0, 10);
};

const money = (n) => dollars(toCents(n));

// What the reminder for one money change says: the tiers it drops
// are rung up in the POS too, which only the farm can change.
const aboutChange = (change) => {
  const dropped = terms.money.bulkTiers
    .filter((t) => (change.dropTiers || []).includes(t.threshold))
    .map((t) => `${money(t.off)} off at ${money(t.threshold)}`);
  const minimum = change.deliveryMinimum
    ? `the delivery minimum becomes ${money(change.deliveryMinimum)}` : "";
  const what = [
    dropped.length ? `the ${dropped.join(" and ")} discount ends` : "",
    minimum,
  ].filter(Boolean).join(" and ");

  return {
    day: change.from,
    text: `On ${label(change.from)}, ${what}. The site and the order ` +
      "functions follow the date by themselves. Remove the matching " +
      "discount from the point of sale in Square before then. The " +
      "jobs start a build on the day, so the static pages follow too.",
  };
};

// -> the reminders showing on `day` (a YYYY-MM-DD in the farm's zone).
export const remindersOn = (day) => (terms.money.changes || [])
  .map(aboutChange)
  .filter((r) => day >= shift(r.day, -LEAD_DAYS)
    && day <= shift(r.day, KEEP_DAYS))
  .map((r) => r.text);
