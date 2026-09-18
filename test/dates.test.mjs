import assert from "node:assert/strict";
import { describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import {
  cutoffFor, deliveryDates, onFarmDates, scituateDates,
} from "../assets/scripts/order/lib/dates.mjs";
import { instant, label } from "../assets/scripts/order/lib/zoned.mjs";

// A wall-clock time in New York as an instant.
const ny = (iso, hour = 9, minute = 0) =>
  instant(iso, hour, minute, "America/New_York");

const dates = (list) => list.map((d) => d.date);

describe("on-farm pickup window", () => {
  it("from Tuesday 6 Oct: Wed 7 Oct through Fri 16 Oct, weekdays only", () => {
    const got = dates(onFarmDates(ny("2026-10-06"), terms));

    assert.equal(got[0], "2026-10-07");
    assert.equal(got.at(-1), "2026-10-16");
    assert.equal(got.length, 7);
    assert.ok(!got.includes("2026-10-12"), "Columbus Day dropped");
    assert.ok(!got.includes("2026-10-10"));
    assert.ok(!got.includes("2026-10-11"));
  });

  it("from a Friday reaches the Friday after next", () => {
    const got = dates(onFarmDates(ny("2026-10-02"), terms));

    assert.equal(got[0], "2026-10-05");
    assert.equal(got.at(-1), "2026-10-09");
  });

  it("from a Saturday starts on Monday", () => {
    const got = dates(onFarmDates(ny("2026-10-03"), terms));

    assert.equal(got[0], "2026-10-05");
    assert.equal(got.at(-1), "2026-10-16");
  });

  it("from a Sunday starts on Monday", () => {
    const got = dates(onFarmDates(ny("2026-10-04"), terms));

    assert.equal(got[0], "2026-10-05");
    assert.equal(got.at(-1), "2026-10-16");
  });

  it("spans the November DST change without losing a day", () => {
    const got = dates(onFarmDates(ny("2026-10-29"), terms));

    assert.deepEqual(got, [
      "2026-10-30",
      "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06",
    ]);
  });
});

describe("delivery Thursdays and the Wednesday-noon cutoff", () => {
  it("Wednesday 11:00 offers next-day Thursday", () => {
    const got = dates(deliveryDates(ny("2026-10-07", 11), terms));

    assert.deepEqual(got, ["2026-10-08", "2026-10-15"]);
  });

  it("Wednesday 13:00 does not", () => {
    const got = dates(deliveryDates(ny("2026-10-07", 13), terms));

    assert.deepEqual(got, ["2026-10-15", "2026-10-22"]);
  });

  it("Wednesday 12:00:00 exactly still makes it", () => {
    const got = dates(deliveryDates(ny("2026-10-07", 12), terms));

    assert.equal(got[0], "2026-10-08");
  });

  it("Thursday morning never offers that day", () => {
    const got = dates(deliveryDates(ny("2026-10-08", 9), terms));

    assert.deepEqual(got, ["2026-10-15", "2026-10-22"]);
  });

  it("skips Thanksgiving: 17 Nov offers 19 Nov then 3 Dec", () => {
    const got = dates(deliveryDates(ny("2026-11-17"), terms));

    assert.deepEqual(got, ["2026-11-19", "2026-12-03"]);
  });

  it("carries the cutoff instant for the countdown", () => {
    const [first] = deliveryDates(ny("2026-10-05"), terms);

    assert.equal(first.cutoff, "2026-10-07T16:00:00.000Z");
  });

  it("computes the cutoff in standard time after the DST change", () => {
    assert.equal(
      cutoffFor("2026-11-12", terms).toISOString(),
      "2026-11-11T17:00:00.000Z"
    );
  });

  it("computes the cutoff across the March 2027 DST start", () => {
    const got = deliveryDates(ny("2027-03-10", 11), terms);

    assert.deepEqual(dates(got), ["2027-03-11", "2027-03-18"]);
    assert.equal(got[0].cutoff, "2027-03-10T17:00:00.000Z");
    assert.equal(got[1].cutoff, "2027-03-17T16:00:00.000Z");
  });
});

describe("Scituate drop Saturdays", () => {
  it("before the start date offers 17 and 24 Oct", () => {
    const got = dates(scituateDates(ny("2026-09-20"), terms));

    assert.deepEqual(got, ["2026-10-17", "2026-10-24"]);
  });

  it("on the start day at 08:00 still offers 17 Oct", () => {
    const got = dates(scituateDates(ny("2026-10-17", 8), terms));

    assert.deepEqual(got, ["2026-10-17", "2026-10-24"]);
  });

  it("on the start day after the window rolls forward", () => {
    const got = dates(scituateDates(ny("2026-10-17", 11), terms));

    assert.deepEqual(got, ["2026-10-24", "2026-10-31"]);
  });

  it("only ever emits Saturdays", () => {
    const got = scituateDates(ny("2026-12-01"), terms, 6);

    for (const d of got) assert.ok(d.label.startsWith("Saturday"));
  });
});

describe("labels", () => {
  it("reads as a weekday, month and day", () => {
    assert.equal(label("2026-10-08"), "Thursday, October 8");
  });
});
