// The launch email James sends from Fastmail, with its facts read from
// data/ (Q21b). data/emails/launch-email.json holds the email lane's
// words with a {token} wherever a price, fee, day, hour, date or place
// would go; fill() puts in the values for the day it renders. An unknown
// token throws, so a typo can't reach the list.

import email from "../../../data/emails/launch-email.json" with {
  type: "json",
};
import company from "../../../data/company.json" with { type: "json" };
import terms from "./terms.mjs";
import {
  dayName, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { moneyOn } from "../../../assets/scripts/order/lib/money-on.mjs";
import { now as clock } from "./clock.mjs";

const dollars = (n) => `$${n}`;

// 12 -> "noon", 9 -> "9:00 AM", 17 -> "5:00 PM"
const hour = (h) => {
  if (h === 12) return "noon";
  return `${h % 12 || 12}:00 ${h < 12 ? "AM" : "PM"}`;
};

// "2026-10-17" -> "October 17"
const monthDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(
  "en-US", { month: "long", day: "numeric", timeZone: "UTC" },
);

// "10:00 AM – 4:00 PM" -> ["10:00 AM", "4:00 PM"]
const ends = (window) => window.split(/\s*–\s*/);

// 7 -> "a week", 3 -> "3 days": the email says it in words.
export const span = (days) => (days === 7 ? "a week" : `${days} days`);

// The drop site: the series of data/series.json that the order page
// offers as scheduled pickup, first.
const { delivery } = terms;
const drop = terms.model.series.find((s) => s.kind === "drop-site");
const { address } = company;

// ", starting October 17" while the drop site's first day is ahead in
// the farm's zone, else nothing, as the terms shortcode's "starting".
const starting = (now) =>
  today(now, terms.timeZone) < drop.start
    ? `, starting ${monthDay(drop.start)}`
    : "";

// The facts as of now, so an email sent after the drop site opens
// doesn't announce its first day.
export const facts = (now = clock()) => {
  const money = moneyOn(terms.money, today(now, terms.timeZone));
  const tiers = money.bulkTiers;

  return {
    deliveryDay: dayName(delivery.weekday),
    deliveryFrom: ends(delivery.window)[0],
    deliveryTo: ends(delivery.window)[1],
    cutoff: `${hour(delivery.cutoffHour)} on ${
      dayName(delivery.cutoffWeekday)}`,
    minimum: dollars(money.deliveryMinimum),
    fee: dollars(money.deliveryFee),
    feeWaivedAt: dollars(money.feeWaivedAt),
    // On-farm pickup's "When", as the order page and the map say it.
    onfarmWhen: terms.onfarm.when,
    farmAddress:
      `${address.street}, ${address.city}, ${address.state} ${address.zip}`,
    dropDay: dayName(drop.weekday),
    dropTown: drop.town,
    dropWindow: ends(drop.window).join(" to "),
    dropStarting: starting(now),
    // The place without its state and ZIP, which the list knows.
    dropPlace: drop.place.replace(/, [A-Z]{2} \d{5}$/, ""),
    bulkFirstOff: dollars(tiers[0].off),
    bulkFirstAt: dollars(tiers[0].threshold),
    bulkLastOff: dollars(tiers.at(-1).off),
    bulkLastAt: dollars(tiers.at(-1).threshold),
  };
};

export const fill = (text, values = facts()) =>
  text.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`launch email: unknown {${key}}`);
    return values[key];
  });

export const launchEmail = (now = clock()) => {
  const values = facts(now);
  return {
    subject: fill(email.subject, values),
    preview: fill(email.preview, values),
    body: fill(email.body, values),
  };
};
