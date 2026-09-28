import assert from "node:assert/strict";
import { describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import {
  cutoffFor, deliveryDates, dropCutoffFor, onFarmDates, scituateDates,
} from "../assets/scripts/order/lib/dates.mjs";
import {
  checkSchedule, coverUntil, parseSchedule, pickupTimes, windowLabel,
} from "../assets/scripts/order/lib/schedule.mjs";
import { instant, label } from "../assets/scripts/order/lib/zoned.mjs";

// A wall-clock time in New York as an instant.
const ny = (iso, hour = 9, minute = 0) =>
  instant(iso, hour, minute, "America/New_York");

const dates = (list) => list.map((d) => d.date);

describe("on-farm pickup, from the farm's schedule (W11d)", () => {
  const schedule = parseSchedule([
    "2026-10-06 09:00-12:00",
    "2026-10-07 09:00-12:00 13:00-17:00",
    "2026-10-10 10:00-11:30",
    "2026-10-12 13:00-17:00",
  ].join("\n")).windows;

  it("offers each scheduled day from tomorrow, with its windows", () => {
    const got = onFarmDates(ny("2026-10-06"), terms, schedule);

    assert.deepEqual(dates(got), ["2026-10-07", "2026-10-10", "2026-10-12"],
      "today is past booking; a Saturday and a holiday are offered if " +
      "listed");
    assert.equal(got[0].label, label("2026-10-07"));
    assert.deepEqual(got[0].windows, [
      { id: "09:00-12:00", from: "09:00", to: "12:00", label: "9 AM – noon" },
      { id: "13:00-17:00", from: "13:00", to: "17:00", label: "1 – 5 PM" },
    ]);
    assert.equal(got[1].windows[0].label, "10 – 11:30 AM");
  });

  it("closes a day at midnight before it (W11d-A)", () => {
    const late = dates(onFarmDates(ny("2026-10-06", 23, 59), terms,
      schedule));
    const after = dates(onFarmDates(ny("2026-10-07", 0, 0), terms,
      schedule));

    assert.equal(late[0], "2026-10-07");
    assert.equal(after[0], "2026-10-10");
  });

  it("offers nothing without a schedule", () => {
    assert.deepEqual(onFarmDates(ny("2026-10-06"), terms), []);
  });
});

describe("the schedule's format and deploy check", () => {
  it("reads new lines, commas, semicolons and comments", () => {
    const { windows, errors } = parseSchedule(
      "# October\n2026-10-07 09:00-12:00, 2026-10-08 13:00-17:00;\n\n" +
      "2026-10-06 09:00-12:00 13:00-14:30"
    );

    assert.deepEqual(errors, []);
    assert.deepEqual(windows.map((w) => `${w.date} ${w.id}`), [
      "2026-10-06 09:00-12:00", "2026-10-06 13:00-14:30",
      "2026-10-07 09:00-12:00", "2026-10-08 13:00-17:00",
    ], "sorted by day and start");
  });

  it("names every problem at once", () => {
    const { errors } = parseSchedule([
      "2026-02-30 09:00-12:00", "10/07 09:00-12:00", "2026-10-07",
      "2026-10-08 9-12", "2026-10-09 12:00-09:00", "2026-10-10 25:00-26:00",
      "2026-10-11 09:00-12:00 11:00-13:00",
    ].join("\n"));

    assert.equal(errors.length, 7, errors.join("\n"));
    assert.match(errors[0], /"2026-02-30" is not a date/);
    assert.match(errors[2], /at least one time range/);
    assert.match(errors[3], /not a time range/);
    assert.match(errors[4], /ends before it starts/);
    assert.match(errors[5], /doesn't exist/);
    assert.match(errors[6], /overlap/);
  });

  it("fails a missing, empty, past or short schedule (amendments 2, 3)",
    () => {
      const check = (raw, day = "2026-10-06") =>
        checkSchedule(raw, { now: ny(day), timeZone: terms.timeZone });

      assert.match(check(undefined).errors[0], /missing or empty/);
      assert.match(check("  \n  ").errors[0], /missing or empty/);
      assert.match(check("# only a comment").errors[0], /no windows/);
      assert.match(check("2026-10-01 09:00-12:00").errors[0],
        /already past/);
      // Tuesday the 6th: this week's Monday is the 5th, so the
      // schedule must reach the week of the 19th.
      assert.equal(coverUntil(ny("2026-10-06"), terms.timeZone),
        "2026-10-19");
      assert.match(check("2026-10-16 09:00-12:00").errors[0],
        /must reach the week of 2026-10-19; its last window is on 2026-10-16/);
      assert.equal(check("2026-10-19 09:00-12:00").ok, true);
      // A Sunday still counts in its own week.
      assert.equal(coverUntil(ny("2026-10-11"), terms.timeZone),
        "2026-10-19");
    });

  it("labels a window for people", () => {
    assert.equal(windowLabel({ from: "09:00", to: "12:00" }), "9 AM – noon");
    assert.equal(windowLabel({ from: "13:00", to: "17:00" }), "1 – 5 PM");
    assert.equal(windowLabel({ from: "11:30", to: "13:00" }),
      "11:30 AM – 1 PM");
    assert.equal(windowLabel({ from: "12:00", to: "14:00" }), "noon – 2 PM");
  });

  it("gives the times of any record's pickup, however old", () => {
    assert.deepEqual(pickupTimes({ window: "morning" }),
      { from: "09:00", to: "12:00" });
    assert.deepEqual(pickupTimes({ window: "afternoon" }),
      { from: "13:00", to: "17:00" });
    assert.deepEqual(pickupTimes({ window: "10:00-11:00", from: "10:00",
      to: "11:00" }), { from: "10:00", to: "11:00" });
    assert.equal(pickupTimes(null), null);
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

describe("drop site Saturdays", () => {
  it("before the start date offers 17 and 24 Oct", () => {
    const got = dates(scituateDates(ny("2026-09-20"), terms));

    assert.deepEqual(got, ["2026-10-17", "2026-10-24"]);
  });

  it("late on the Friday before still offers 17 Oct", () => {
    const got = scituateDates(ny("2026-10-16", 23, 59), terms);

    assert.deepEqual(dates(got), ["2026-10-17", "2026-10-24"]);
    assert.equal(got[0].cutoff, "2026-10-17T04:00:00.000Z");
  });

  it("takes an order at exactly midnight, the end of Friday", () => {
    const got = dates(scituateDates(ny("2026-10-17", 0), terms));

    assert.deepEqual(got, ["2026-10-17", "2026-10-24"]);
  });

  it("after midnight rolls forward, before the window opens", () => {
    for (const hour of [0, 8]) {
      const got = dates(scituateDates(
        ny("2026-10-17", hour, hour ? 0 : 1), terms
      ));

      assert.deepEqual(got, ["2026-10-24", "2026-10-31"], `${hour}`);
    }
  });

  it("puts the cutoff at the end of Friday across the DST change", () => {
    assert.equal(dropCutoffFor("2026-10-31", terms).toISOString(),
      "2026-10-31T04:00:00.000Z");
    assert.equal(dropCutoffFor("2026-11-07", terms).toISOString(),
      "2026-11-07T05:00:00.000Z");
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
