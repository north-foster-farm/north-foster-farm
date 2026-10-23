#!/usr/bin/env node
// Fails the deploy when a location or series would stop resolving. A
// location or series is archived (`archived: true`), never deleted, so
// the orders that name it still have a place to read. The registry,
// data/registry.json, lists every code ever used. The build fails on a
// duplicate code, a code in the data missing from the registry, a
// registered code that no longer resolves, a series pointing at a
// missing or archived location while in season, and a schedule line
// naming an unknown code. Netlify runs it in every build command,
// beside check:schedule.
//
// A build cannot read the production orders store (a site-wide store
// answers 401 from a build, docs/monitoring.md), so the occurrences
// that real orders name are checked by `bin/nff orders occurrences`,
// which reads it with the farm's own credentials.
//
//   node bin/check-events.mjs           checks PICKUP_SCHEDULE's lines too
//   node bin/check-events.mjs <file>    checks a file's lines instead

import { readFileSync } from "node:fs";

import delivery from "../data/delivery.json" with { type: "json" };
import locations from "../data/locations.json" with { type: "json" };
import registry from "../data/registry.json" with { type: "json" };
import series from "../data/series.json" with { type: "json" };
import terms from "../netlify/functions/lib/terms.mjs";
import {
  checkIntegrity,
} from "../assets/scripts/order/lib/events.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import { today } from "../assets/scripts/order/lib/zoned.mjs";

const file = process.argv[2];
const raw = file ? readFileSync(file, "utf8") : process.env.PICKUP_SCHEDULE;
// A schedule that does not parse is check:schedule's to report.
const { lines } = parseSchedule(raw);
const errors = checkIntegrity({
  locations: locations.locations,
  series: series.series,
  registered: registry.codes,
  lines,
  today: today(new Date(), terms.timeZone),
});

// The drop site block of data/delivery.json stays, read by the order
// page and the cart until they read the series; it must say what the
// series does.
const drop = terms.model.series.find((s) => s.kind === "drop-site");
const block = delivery.scituate;

if (drop) {
  for (const [name, mine, theirs] of [
    ["window", block.window, drop.window],
    ["location", block.location, drop.place],
    ["short", block.short, drop.short],
    ["town", block.town, drop.town],
    ["start", block.start, drop.start],
    ["weekday", block.weekday, drop.weekday],
    ["opensHour", block.opensHour, drop.opensHour],
  ]) {
    if (mine !== theirs) {
      errors.push(`data/delivery.json scituate.${name} is ${mine}, but ` +
        `the drop site series ${drop.code} says ${theirs}.`);
    }
  }
}

if (errors.length) {
  console.error(`Events: ${errors.length} problem${
    errors.length === 1 ? "" : "s"}.`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

console.log(`Events: ${registry.codes.length} codes registered, all ` +
  "resolve.");
