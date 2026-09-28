#!/usr/bin/env node
// Fails the deploy when the pickup schedule would fail a customer
// (W11d, James's amendments 2 and 3): PICKUP_SCHEDULE missing, empty
// or malformed, every window past, or not reaching the week after
// next. Netlify runs it in every build command; a failed build leaves
// the last good deploy live. bin/nff schedule runs the same check
// before it sets the variable.
//
//   node bin/check-schedule.mjs           checks PICKUP_SCHEDULE
//   node bin/check-schedule.mjs <file>    checks a file instead

import { readFileSync } from "node:fs";

import terms from "../data/delivery.json" with { type: "json" };
import { checkSchedule } from "../assets/scripts/order/lib/schedule.mjs";

const file = process.argv[2];
const raw = file ? readFileSync(file, "utf8") : process.env.PICKUP_SCHEDULE;
const result = checkSchedule(raw, { timeZone: terms.timeZone });

if (!result.ok) {
  console.error(`Pickup schedule: ${result.errors.length} problem${
    result.errors.length === 1 ? "" : "s"}.`);
  for (const error of result.errors) console.error(`  ${error}`);
  process.exit(1);
}

const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const days = new Set(result.windows.map((w) => w.date)).size;

console.log(`Pickup schedule: ${count(result.windows.length, "window")} ` +
  `on ${count(days, "day")}, through ${result.last}.`);
