// Criteria tests for #617: the pickup-day picker (#540) out of `next`.
// Held out of `npm test` by its name until the picker is out; the
// implementer turns it on with
//
//   git mv test/picker-out.criteria.mjs test/picker-out.test.mjs
//
// The picker's own unit tests, test/picker.test.mjs, move with it to
// `parked/pickup-picker` and leave `next`: they import the modules
// this file says are gone. The browser's side (no week strip, no
// picker markup, styles or scripts) is e2e/picker-out.spec.mjs.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scheduleFor } from "../bin/dev-schedule.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import { allDates } from "../assets/scripts/order/lib/dates.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import {
  scheduledChoice,
} from "../assets/scripts/order/lib/scheduled.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

// The picker's modules as #540 added them.
const MODULES = [
  "assets/scripts/order/lib/picker.mjs",
  "assets/scripts/order/pickup-picker.js",
  "assets/styles/components/_pickup-picker.scss",
  "layouts/partials/order/pickup-picker.html",
];

const files = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? files(join(dir, e.name))
    : [join(dir, e.name)]));

describe("the picker out of next (#617)", () => {
  it("the picker's modules are gone", () => {
    for (const path of MODULES) {
      assert.equal(existsSync(join(ROOT, path)), false, `${path} is gone`);
    }
    // And nothing the site builds from still reaches for them.
    const uses = /pickup-picker|lib\/picker\.mjs|PickupPicker/;

    for (const path of [...files("assets"), ...files("layouts")]) {
      if (!/\.(m?js|scss|html)$/.test(path)) continue;
      assert.doesNotMatch(readFileSync(join(ROOT, path), "utf8"), uses,
        path);
    }
  });

  // Restored from main (test/scheduled.test.mjs and
  // test/pawtucket.test.mjs there): production's lapsed dialog labels
  // each scheduled pickup with this line. The places as `next` names
  // them (North Scituate, #541; Pawtucket, #544).
  it("a scheduled choice reads as production's lapsed line", () => {
    const drop = {
      occurrence: "VFVQ-261024", date: "2026-10-24",
      label: "Saturday, October 24", series: "VFVQ", name: "Drop site",
      town: "North Scituate", window: "10:00 – 11:00 AM",
    };

    assert.equal(scheduledChoice(drop).text,
      "Saturday, October 24: Drop site, North Scituate, 10:00 – 11:00 AM");

    const { windows, lines } = parseSchedule(
      scheduleFor("2026-11-01", "2027-05-01")
    );
    const now = instant("2026-11-11", 9, 0, "America/New_York");
    const [market, popup] = allDates(now, terms,
      Object.assign(windows, { lines })).scheduled
      .filter((d) => ["H3TQ", "W9MF"].includes(d.series))
      .map(scheduledChoice);

    assert.equal(market.text,
      `${market.label}: Pawtucket Farmers Market, Pawtucket, ` +
      "12:00 – 4:00 PM");
    assert.equal(popup.text,
      `${popup.label}: Thanksgiving Prep, Pawtucket, 12:00 – 5:00 PM`);
  });
});
