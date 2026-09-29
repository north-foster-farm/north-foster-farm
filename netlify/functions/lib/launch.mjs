// The launch email James sends from Fastmail, with its facts read from
// data/ (Q21b). data/emails/launch-email.json holds the email lane's
// words with a {token} wherever a price, fee, day, hour, date or place
// would go; fill() puts today's values in. An unknown token throws, so
// a typo can't reach the list.

import email from "../../../data/emails/launch-email.json" with {
  type: "json",
};
import accounts from "../../../data/accounts.json" with { type: "json" };
import company from "../../../data/company.json" with { type: "json" };
import terms from "../../../data/delivery.json" with { type: "json" };
import { dayName } from "../../../assets/scripts/order/lib/zoned.mjs";

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

const { money, delivery, scituate } = terms;
const tiers = money.bulkTiers;
const { address } = company;

export const FACTS = {
  deliveryDay: dayName(delivery.weekday),
  deliveryFrom: ends(delivery.window)[0],
  deliveryTo: ends(delivery.window)[1],
  cutoff: `${hour(delivery.cutoffHour)} on ${dayName(delivery.cutoffWeekday)}`,
  minimum: dollars(money.deliveryMinimum),
  fee: dollars(money.deliveryFee),
  feeWaivedAt: dollars(money.feeWaivedAt),
  farmAddress:
    `${address.street}, ${address.city}, ${address.state} ${address.zip}`,
  dropDay: dayName(scituate.weekday),
  dropWindow: ends(scituate.window).join(" to "),
  dropStart: monthDay(scituate.start),
  // The place without its state and ZIP, which the list knows.
  dropPlace: scituate.location.replace(/, [A-Z]{2} \d{5}$/, ""),
  bulkFirstOff: dollars(tiers[0].off),
  bulkFirstAt: dollars(tiers[0].threshold),
  bulkLastOff: dollars(tiers.at(-1).off),
  bulkLastAt: dollars(tiers.at(-1).threshold),
  // How long the sign-up email's button works (news.mjs CONFIRM_TTL).
  inviteLife: span(accounts.newsInviteDays),
};

export const fill = (text, facts = FACTS) =>
  text.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in facts)) throw new Error(`launch email: unknown {${key}}`);
    return facts[key];
  });

export const launchEmail = () => ({
  subject: fill(email.subject),
  preview: fill(email.preview),
  body: fill(email.body),
});
