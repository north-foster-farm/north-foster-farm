// Criteria tests for #616, rule 2: an on-farm pickup time written in
// full for the "Pickup time" radios. Held out of `npm test` by its
// name until the formatter exists; the implementer turns it on with
//
//   git mv test/onfarm-label.criteria.mjs test/onfarm-label.test.mjs
//
// Contract (fixed here, before the code):
//   module    assets/scripts/order/lib/schedule.mjs
//   export    fullWindowLabel({ from, to }) -> string
//   input     a window as the schedule parses it, from and to "HH:MM"
//             on a 24-hour clock (parseRange's { from, to })
//   output    "8:00 – 10:00 AM": both ends with minutes, AM or PM once
//             when both ends share it and on each end when they
//             differ, twelve o'clock "12:00 PM" (never "noon"), an en
//             dash with an ordinary space each side, and no no-break
//             space; keeping it on one line is the page's text-nowrap
//             span, not the string's.
//
// windowLabel in the same module ("9 AM – noon") is left as it is
// (rule 3, the coordinator's reading); test/dates.test.mjs holds it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fullWindowLabel,
} from "../assets/scripts/order/lib/schedule.mjs";

const label = (id) => {
  const [from, to] = id.split("-");

  return fullWindowLabel({ from, to });
};

const NO_BREAK = new RegExp(`[${String.fromCharCode(0xa0, 0x202f)}]`);

// Minutes after midnight as "HH:MM".
const hhmm = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${
  String(n % 60).padStart(2, "0")}`;

// Every window on the quarter hour from 6:00 AM to 9:00 PM, as
// [from, to] in minutes.
const EVERY = [];

for (let from = 360; from < 1260; from += 15) {
  for (let to = from + 15; to <= 1260; to += 15) EVERY.push([from, to]);
}

describe("an on-farm pickup time written in full (#616)", () => {
  it("reads exactly as in James's list for his five windows", () => {
    assert.deepEqual(
      ["08:00-10:00", "10:00-12:00", "12:00-14:00", "14:00-16:00",
        "16:00-18:00"].map(label),
      ["8:00 – 10:00 AM", "10:00 AM – 12:00 PM", "12:00 – 2:00 PM",
        "2:00 – 4:00 PM", "4:00 – 6:00 PM"],
    );
  });

  it("follows rule 2 for any window", () => {
    const cases = {
      // A half-hour start.
      "09:30-11:00": "9:30 – 11:00 AM",
      "12:30-14:00": "12:30 – 2:00 PM",
      // A window that crosses noon.
      "11:00-13:00": "11:00 AM – 1:00 PM",
      "11:30-12:30": "11:30 AM – 12:30 PM",
      // One that ends at 12:00 PM.
      "10:30-12:00": "10:30 AM – 12:00 PM",
      "09:00-12:00": "9:00 AM – 12:00 PM",
      // Both ends AM, both PM.
      "07:00-09:45": "7:00 – 9:45 AM",
      "13:00-15:30": "1:00 – 3:30 PM",
      "17:15-19:00": "5:15 – 7:00 PM",
    };

    for (const [id, want] of Object.entries(cases)) {
      assert.equal(label(id), want, id);
    }

    // And the rule itself, for every quarter-hour window.
    const half = (n) => (n < 720 ? "AM" : "PM");
    const clock = (n) => `${((Math.floor(n / 60) + 11) % 12) + 1}:${
      String(n % 60).padStart(2, "0")}`;

    for (const [from, to] of EVERY) {
      const want = half(from) === half(to)
        ? `${clock(from)} – ${clock(to)} ${half(to)}`
        : `${clock(from)} ${half(from)} – ${clock(to)} ${half(to)}`;

      assert.equal(fullWindowLabel({ from: hhmm(from), to: hhmm(to) }),
        want, `${hhmm(from)}-${hhmm(to)}`);
    }
  });

  it("holds no noon and no no-break space, for any window", () => {
    for (const [from, to] of EVERY) {
      const got = fullWindowLabel({ from: hhmm(from), to: hhmm(to) });

      assert.doesNotMatch(got, /noon/i, got);
      assert.doesNotMatch(got, NO_BREAK, got);
    }
  });
});
