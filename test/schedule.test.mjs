import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  nextPlaces, skipped, startingBadge, windowDates,
} from "../assets/scripts/schedule/schedule.js";

// Wednesday, October 21, 2026, noon in New York: the window runs
// through Saturday, October 31.
const now = new Date("2026-10-21T16:00:00Z");
const market = { code: "WAC5", start: "2026-06-07", end: "2026-10-25" };

describe("the schedule, read at view time", () => {
  it("finds a series' dates inside the booking window", () => {
    assert.deepEqual(windowDates(market, now), ["2026-10-25"]);
    assert.deepEqual(
      windowDates({ code: "VFVQ", start: "2026-10-17" }, now),
      ["2026-10-24", "2026-10-31"],
    );
  });

  it("leaves out a series the schedule skips", () => {
    assert.equal(skipped(market, [], now), true);
    assert.equal(skipped(market, [
      { series: "WAC5", date: "2026-10-25", status: "attend" },
    ], now), false);
  });

  it("does not judge a series with no date in the window", () => {
    const over = { code: "2MPW", start: "2026-06-06", end: "2026-09-26" };
    const later = { code: "XXXX", start: "2026-11-15", end: "2026-11-15" };

    assert.equal(skipped(over, [], now), false);
    assert.equal(skipped(later, [], now), false);
  });

  it("lists the next open date of each series, soonest first", () => {
    const got = nextPlaces([
      { series: "A", date: "2026-10-24" },
      { series: "B", date: "2026-10-25" },
      { series: "A", date: "2026-10-31" },
      { series: "C", date: "2026-10-31" },
      { series: "D", date: "2026-10-31" },
    ]);

    assert.deepEqual(got.map((d) => d.series), ["A", "B", "C"]);
  });

  it("words a series' first day as a badge", () => {
    assert.equal(startingBadge("2026-10-17"), "Starting Oct 17");
  });
});
