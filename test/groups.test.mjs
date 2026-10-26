// Buying groups (#471): the group's series runs every other week, is
// listed nowhere a request without the group can see, and runs its
// rounds without a schedule line.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allDates, datesFor, eventDates, scheduledDates,
} from "../assets/scripts/order/lib/dates.mjs";
import {
  buildModel, hasDate, offered, seriesDates,
} from "../assets/scripts/order/lib/events.mjs";
import {
  checkSchedule, parseSchedule,
} from "../assets/scripts/order/lib/schedule.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import groupData from "../data/groups.json" with { type: "json" };
import locationData from "../data/locations.json" with { type: "json" };
import seriesData from "../data/series.json" with { type: "json" };
import terms from "../netlify/functions/lib/terms.mjs";

const ny = (iso, hour = 9, minute = 0) =>
  instant(iso, hour, minute, "America/New_York");

const LOCATIONS = [
  {
    code: "AAAA", name: "Town Common", street: "1 Main St", city: "Foster",
    state: "RI", zip: "02825", town: "Foster", lat: 41.8, lng: -71.7,
  },
  {
    code: "GGGG", name: "The Gym", street: "2 Fit St", city: "Warwick",
    state: "RI", zip: "02888", town: "Warwick", lat: 41.7, lng: -71.4,
    private: true,
  },
];
const SERIES = [
  {
    code: "BBBB", kind: "drop-site", name: "Drop site", location: "AAAA",
    start: "2026-10-17", opens: "10:00", closes: "11:00",
  },
  {
    code: "HHHH", kind: "group", name: "The Gym", location: "GGGG",
    start: "2026-11-08", every: 2, opens: "08:30", closes: "09:00",
    group: "gym",
  },
];
const model = buildModel(LOCATIONS, SERIES);
const base = { ...terms, model };
const member = { ...base, groups: ["gym"] };
// The schedule as the functions hold it: the windows, with the
// occurrence lines on them.
const lines = (text) => {
  const parsed = parseSchedule(text);

  return Object.assign(parsed.windows, { lines: parsed.lines });
};

describe("a series every other week", () => {
  const s = model.seriesOf("HHHH");

  it("has its start, and every second Sunday after", () => {
    assert.equal(hasDate(s, "2026-11-08"), true);
    assert.equal(hasDate(s, "2026-11-15"), false);
    assert.equal(hasDate(s, "2026-11-22"), true);
    assert.equal(hasDate(s, "2026-11-29"), false);
    assert.equal(hasDate(s, "2026-12-06"), true);
    assert.equal(hasDate(s, "2026-11-01"), false);
    assert.deepEqual(seriesDates(s, "2026-11-01", "2026-12-31"),
      ["2026-11-08", "2026-11-22", "2026-12-06", "2026-12-20"]);
  });

  it("leaves a weekly series weekly", () => {
    const weekly = model.seriesOf("BBBB");

    assert.deepEqual(seriesDates(weekly, "2026-11-01", "2026-11-14"),
      ["2026-11-07", "2026-11-14"]);
  });
});

describe("a group's series is offered only to its group", () => {
  const now = ny("2026-11-02");
  const schedule = lines("2026-11-07 BBBB pickup\n2026-11-14 BBBB pickup");

  it("is left out of the series a request may see", () => {
    assert.deepEqual(offered(model).map((s) => s.code), ["BBBB"]);
    assert.deepEqual(offered(model, ["gym"]).map((s) => s.code),
      ["BBBB", "HHHH"]);
    assert.deepEqual(offered(model, ["other"]).map((s) => s.code),
      ["BBBB"]);
  });

  it("is left out of /api/dates and /api/events for everyone else", () => {
    const codes = (list) => list.map((d) => d.series);

    assert.deepEqual(codes(scheduledDates(now, base, schedule)),
      ["BBBB", "BBBB"]);
    assert.deepEqual(codes(eventDates(now, base, schedule)),
      ["BBBB", "BBBB"]);
    assert.deepEqual(codes(allDates(now, base, schedule).scheduled),
      ["BBBB", "BBBB"]);
  });

  it("is offered to the group, open without a schedule line", () => {
    const mine = scheduledDates(now, member, schedule);

    assert.deepEqual(mine.map((d) => [d.series, d.date]),
      [["BBBB", "2026-11-07"], ["HHHH", "2026-11-08"],
        ["BBBB", "2026-11-14"]]);

    const round = mine.find((d) => d.series === "HHHH");

    assert.equal(round.occurrence, "HHHH-261108");
    assert.equal(round.name, "The Gym");
    assert.equal(round.window, "8:30 – 9:00 AM");
    assert.equal(round.location, "GGGG");
    // Orders close 11:59 PM the Saturday before (James, 6424212209).
    assert.equal(round.cutoff, ny("2026-11-07", 23, 59).toISOString());
  });

  it("closes once its cutoff has passed", () => {
    const late = ny("2026-11-08", 0, 1);
    const mine = scheduledDates(late, member, schedule);

    assert.equal(mine.some((d) => d.series === "HHHH"), false);
  });

  it("sits out a round the schedule skips, and attends one it says", () => {
    const skipped = lines("2026-11-07 BBBB pickup\n2026-11-08 HHHH skip");
    const attended = lines("2026-11-07 BBBB pickup\n" +
      "2026-11-08 HHHH attend");

    assert.equal(scheduledDates(now, member, skipped)
      .some((d) => d.series === "HHHH"), false);
    assert.equal(scheduledDates(now, member, attended)
      .some((d) => d.series === "HHHH"), false);
    assert.equal(eventDates(now, member, attended)
      .find((d) => d.series === "HHHH").status, "attend");
  });

  it("is validated by datesFor the same way", () => {
    const has = (t) => datesFor("scheduled", now, t, schedule)
      .some((d) => d.occurrence === "HHHH-261108");

    assert.equal(has(base), false);
    assert.equal(has(member), true);
  });

  it("is the farm's to book, like any live series", () => {
    assert.equal(datesFor("scheduled", now, base, schedule, true)
      .some((d) => d.occurrence === "HHHH-261122"), true);
  });
});

describe("the schedule check and a group's series", () => {
  const now = ny("2026-11-02");
  const windows = "2026-11-03 09:00-12:00\n2026-11-17 09:00-12:00\n";

  it("asks for no line for a group's rounds", () => {
    const result = checkSchedule(
      `${windows}2026-11-07 BBBB pickup\n2026-11-14 BBBB pickup`,
      { now, timeZone: terms.timeZone, model },
    );

    assert.deepEqual(result.errors, []);
  });

  it("still asks for the other series' lines", () => {
    const result = checkSchedule(`${windows}2026-11-14 BBBB pickup`,
      { now, timeZone: terms.timeZone, model });

    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /2026-11-07: BBBB/);
  });

  it("takes a skip or attend line for a round", () => {
    const result = checkSchedule(
      `${windows}2026-11-07 BBBB pickup\n2026-11-14 BBBB pickup\n` +
      "2026-11-08 HHHH skip",
      { now, timeZone: terms.timeZone, model },
    );

    assert.deepEqual(result.errors, []);
  });

  it("refuses a line on a Sunday the series skips", () => {
    const result = checkSchedule(
      `${windows}2026-11-07 BBBB pickup\n2026-11-14 BBBB pickup\n` +
      "2026-11-15 HHHH pickup",
      { now, timeZone: terms.timeZone, model },
    );

    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /2026-11-15: HHHH .* has no occurrence/);
  });
});

describe("the real group data", () => {
  it("names a series and a private location that exist", () => {
    for (const g of groupData.groups) {
      const s = seriesData.series.find((x) => x.code === g.series);
      const loc = locationData.locations.find((x) => x.code === g.location);

      assert.ok(s, `${g.key} series`);
      assert.equal(s.group, g.key);
      assert.equal(s.location, g.location);
      assert.equal(s.kind, "group");
      assert.ok(loc, `${g.key} location`);
      assert.equal(loc.private, true);
      assert.equal(typeof g.name, "string");
      assert.ok(g.name.length);
    }
  });

  it("keeps every group's series off the public lists", () => {
    const now = ny("2026-11-02");

    for (const d of eventDates(now, terms, { lines: [] })) {
      assert.equal(terms.model.seriesOf(d.series).group, undefined);
    }
  });

  it("runs the first round on Sunday 2026-11-08, then every other", () => {
    const s = terms.model.seriesOf("36TS");

    assert.deepEqual(seriesDates(s, "2026-11-01", "2026-12-07"),
      ["2026-11-08", "2026-11-22", "2026-12-06"]);
  });
});
