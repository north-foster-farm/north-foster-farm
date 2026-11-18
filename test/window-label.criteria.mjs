// Criteria tests for #616's shared label (James on PR #621,
// 2026-11-18: "The shared labels need to change too."). A pickup or
// delivery window reads in one format wherever a customer or the farm
// reads it, from one function. Held out of `npm test` by its name
// until the code changes; the implementer turns it on with
//
//   git mv test/window-label.criteria.mjs test/window-label.test.mjs
//
// It replaces test/onfarm-label.test.mjs (round one's fullWindowLabel,
// removed in this commit): its three tests are the first three here,
// on windowLabel.
//
// Contract (fixed here, before the code):
//   module    assets/scripts/order/lib/schedule.mjs
//   export    windowLabel({ from, to }) -> string, in the new format;
//             fullWindowLabel goes (every caller uses windowLabel)
//   input     a window as the schedule parses it, from and to "HH:MM"
//             on a 24-hour clock (parseRange's { from, to })
//   output    "8:00 – 10:00 AM": both ends with minutes, AM or PM once
//             when both ends share it and on each end when they
//             differ, twelve o'clock "12:00 PM" (never "noon"), an en
//             dash with an ordinary space each side, and no no-break
//             space; keeping it on one line is the page's text-nowrap
//             span, not the string's.
//   rangeWindow in assets/scripts/order/lib/events.mjs (the series'
//             windows) may stay as a thin adapter; it gives what
//             windowLabel gives for every window.
//   netlify/functions/lib/describe.mjs: placeOf(order).window is the
//             full label for every way of getting an order (on-farm,
//             scheduled, delivery), and between(window) keeps the
//             minutes: "between 10:00 AM and 4:00 PM", "between 10:00
//             and 11:00 AM".
//
// Stored or computed: computed. An order stores its on-farm window as
// { window: "09:00-12:00", from, to } (assets/scripts/order/lib/
// validate.mjs, the `out.onfarm` line), never its label, and each
// reader formats it; a placed order therefore reads in the new format,
// and its record does not change. The only stored label is a printed
// slip's snapshot (test/packing.criteria.mjs pins it).
//
// Out of scope: the hours the farm confirmed on a record from before
// W11d (describe.mjs hoursRange, "9 – 11 AM").

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rangeWindow } from "../assets/scripts/order/lib/events.mjs";
import {
  pickupTimes, windowLabel,
} from "../assets/scripts/order/lib/schedule.mjs";
import {
  between, pickupWindow, placeOf,
} from "../netlify/functions/lib/describe.mjs";
import {
  dropSite, library, market, order, pickup, popUp,
} from "../netlify/functions/lib/library.mjs";
import { mailLinks } from "../netlify/functions/lib/site.mjs";

const label = (id) => {
  const [from, to] = id.split("-");

  return windowLabel({ from, to });
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

describe("a window label written in full (#616)", () => {
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

      assert.equal(windowLabel({ from: hhmm(from), to: hhmm(to) }),
        want, `${hhmm(from)}-${hhmm(to)}`);
    }
  });

  it("holds no noon and no no-break space, for any window", () => {
    for (const [from, to] of EVERY) {
      const got = windowLabel({ from: hhmm(from), to: hhmm(to) });

      assert.doesNotMatch(got, /noon/i, got);
      assert.doesNotMatch(got, NO_BREAK, got);
    }
  });

  it("comes from one function: a series' window reads as windowLabel's",
    () => {
      for (const [from, to] of EVERY) {
        const [a, b] = [hhmm(from), hhmm(to)];

        assert.equal(rangeWindow(a, b), windowLabel({ from: a, to: b }),
          `${a}-${b}`);
      }
    });
});

describe("the shared label wherever a window is read (#616)", () => {
  it("reads in full for an on-farm, a scheduled and a delivery order", () => {
    assert.equal(placeOf(pickup()).window, "9:00 AM – 12:00 PM");
    assert.equal(pickupWindow(pickup()), "9:00 AM – 12:00 PM");
    assert.equal(placeOf(dropSite()).window, "10:00 – 11:00 AM");
    assert.equal(placeOf(market()).window, "9:00 AM – 1:00 PM");
    assert.equal(placeOf(popUp()).window, "10:00 AM – 2:00 PM");
    assert.equal(placeOf(order()).window, "10:00 AM – 4:00 PM");
  });

  it("keeps the minutes in a \"between\" line", () => {
    assert.equal(between("10:00 AM – 4:00 PM"), "10:00 AM and 4:00 PM");
    assert.equal(between("10:00 – 11:00 AM"), "10:00 and 11:00 AM");
    assert.equal(between("9:30 AM – 12:00 PM"), "9:30 AM and 12:00 PM");
  });

  it("reads an order placed before the change in the new format, its " +
    "record unchanged", () => {
    const onfarm = (o) => pickup({
      fulfilment: { method: "onfarm", date: "2026-10-08", onfarm: o },
    });
    const cases = [
      // As placed since W11d, and an id with no times beside it.
      [{ window: "09:00-12:00", from: "09:00", to: "12:00" },
        "9:00 AM – 12:00 PM"],
      [{ window: "13:30-15:00" }, "1:30 – 3:00 PM"],
      // The fixed pair from before W11d.
      [{ window: "morning" }, "9:00 AM – 12:00 PM"],
      [{ window: "afternoon" }, "1:00 – 5:00 PM"],
    ];

    for (const [stored, want] of cases) {
      const before = JSON.stringify(stored);
      const o = onfarm(stored);

      assert.equal(placeOf(o).window, want, before);
      assert.equal(windowLabel(pickupTimes(stored)), want, before);
      assert.equal(JSON.stringify(o.fulfilment.onfarm), before,
        "the record is not rewritten");
    }
  });

  it("gives no window in any email as noon", () => {
    const links = mailLinks({ SITE_URL: "https://staging.test" });

    for (const e of library) {
      const m = e.build(links);

      for (const s of [m.subject, m.text, m.html]) {
        assert.doesNotMatch(s || "", /noon\s*–|–\s*noon/, e.id);
      }
    }
  });
});
