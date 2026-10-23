import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allDates, datesFor, eventDates, orderOccurrence, scheduledDates,
} from "../assets/scripts/order/lib/dates.mjs";
import {
  ALPHABET, buildModel, checkIntegrity, legacyOccurrence, newCode,
  occurrenceId, parseOccurrence, resolveOccurrence,
} from "../assets/scripts/order/lib/events.mjs";
import {
  checkSchedule, parseSchedule,
} from "../assets/scripts/order/lib/schedule.mjs";
import locationData from "../data/locations.json" with { type: "json" };
import registry from "../data/registry.json" with { type: "json" };
import seriesData from "../data/series.json" with { type: "json" };
import { pickupSchedule } from "../netlify/functions/lib/pickups.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const ny = (iso, hour = 9, minute = 0) =>
  instant(iso, hour, minute, "America/New_York");

const LOCATIONS = [{
  code: "AAAA", name: "Town Common", street: "1 Main St", city: "Foster",
  state: "RI", zip: "02825", town: "Foster", lat: 41.8, lng: -71.7,
}];
const SERIES = [
  {
    code: "BBBB", kind: "market", name: "Common Market", location: "AAAA",
    start: "2026-10-04", end: "2026-11-29", opens: "09:00", closes: "13:00",
    href: "https://example.com/market", legacySite: "common",
  },
  {
    code: "CCCC", kind: "pop-up", name: "Harvest Fair", location: "AAAA",
    start: "2026-11-07", end: "2026-11-07", opens: "18:00", closes: "20:00",
  },
  {
    code: "DDDD", kind: "pop-up", name: "Old Fair", location: "AAAA",
    start: "2026-10-24", end: "2026-10-24", opens: "10:00", closes: "12:00",
    archived: true,
  },
];
const model = buildModel(LOCATIONS, SERIES);
const t = { ...terms, model };

// An on-farm window, so the schedule is a valid one.
const BASE = "2026-10-20 09:00-12:00\n";
// A schedule as the functions read it: the windows, with the
// occurrence lines riding on the array.
const withLines = (text) => Object.assign([], {
  lines: parseSchedule(`${BASE}${text}`).lines,
});

describe("codes", () => {
  it("generates four characters of the order-id alphabet, never a taken one",
    () => {
      const picks = [0, 0, 0, 0, 1, 1, 1, 1];
      let n = 0;
      const code = newCode(["AAAA"], () => picks[n++]);

      assert.equal(code, "BBBB", "AAAA was taken, so it drew again");
      assert.match(newCode([], (max) => max - 1), /^[A-HJKMNP-Z2-9]{4}$/);
      assert.equal(ALPHABET.length, 31);
      assert.doesNotMatch(ALPHABET, /[ILO01]/);
    });

  it("names an occurrence by series and date, and reads it back", () => {
    assert.equal(occurrenceId("K4Q7", "2026-11-01"), "K4Q7-261101");
    assert.deepEqual(parseOccurrence("K4Q7-261101"),
      { series: "K4Q7", date: "2026-11-01" });
    assert.equal(parseOccurrence("K4Q7-261301"), null, "no month 13");
    assert.equal(parseOccurrence("K4Q7-260230"), null, "no Feb 30");
    assert.equal(parseOccurrence("k4q7-261101"), null);
    assert.equal(parseOccurrence("K4Q0-261101"), null, "0 is not in it");
    assert.equal(parseOccurrence(null), null);
  });

  it("gives the real data unique, registered codes", () => {
    const errors = checkIntegrity({
      locations: locationData.locations, series: seriesData.series,
      registered: registry.codes, today: "2026-10-22",
    });

    assert.deepEqual(errors, []);
    assert.equal(registry.codes.length, 17);
  });
});

describe("the model", () => {
  it("shapes a pop-up as a series with one date", () => {
    const s = model.seriesOf("CCCC");

    assert.equal(s.weekday, 6);
    assert.equal(s.window, "6:00 – 8:00 PM");
    assert.equal(s.town, "Foster");
    assert.equal(s.place, "Harvest Fair, Town Common, 1 Main St, Foster");
    assert.equal(resolveOccurrence(model, "CCCC-261107").date, "2026-11-07");
    assert.equal(resolveOccurrence(model, "CCCC-261114"), null,
      "the series has no second date");
  });

  it("resolves an archived series but never offers it", () => {
    const o = resolveOccurrence(model, "DDDD-261024");

    assert.equal(o.archived, true);
    assert.deepEqual(scheduledDates(ny("2026-10-20"), t,
      withLines("2026-10-24 DDDD pickup")), []);
  });

  it("lets one date carry its own location and hours", () => {
    const other = buildModel([...LOCATIONS, {
      code: "EEEE", name: "Library", street: "2 Oak St", city: "Foster",
      town: "Foster",
    }], [{
      ...SERIES[0],
      overrides: { "2026-10-25": { location: "EEEE", opens: "10:00" } },
    }]);
    const moved = resolveOccurrence(other, "BBBB-261025");
    const usual = resolveOccurrence(other, "BBBB-261101");

    assert.equal(moved.location, "EEEE");
    assert.match(moved.place, /Library/);
    assert.equal(moved.window, "10:00 AM – 1:00 PM");
    assert.equal(usual.location, "AAAA");
  });

  it("reads the Stage 1 ways of naming a pickup", () => {
    assert.equal(legacyOccurrence(model, "market", "common", "2026-10-25"),
      "BBBB-261025");
    assert.equal(legacyOccurrence(model, "market", "common", "2026-10-26"),
      null, "a Monday");
    assert.equal(legacyOccurrence(model, "market", "gone", "2026-10-25"),
      null);
    assert.equal(legacyOccurrence(model, "delivery", null, "2026-10-25"),
      null);
    assert.equal(orderOccurrence(t, {
      method: "market", site: "common", date: "2026-10-25",
    }).id, "BBBB-261025");
    assert.equal(orderOccurrence(t, {
      method: "scheduled", occurrence: "BBBB-261101",
    }).series, "BBBB");
  });
});

describe("the schedule's occurrence lines", () => {
  it("parses pickup, attend and skip, and a narrower window", () => {
    const got = parseSchedule(`${BASE}2026-11-01 BBBB pickup
2026-11-08 BBBB pickup 10:00-12:00
2026-11-15 BBBB attend
2026-11-22 BBBB skip`);

    assert.deepEqual(got.errors, []);
    assert.deepEqual(got.lines.map((l) => [l.date, l.action, l.from]), [
      ["2026-11-01", "pickup", undefined],
      ["2026-11-08", "pickup", "10:00"],
      ["2026-11-15", "attend", undefined],
      ["2026-11-22", "skip", undefined],
    ]);
    assert.equal(got.windows.length, 1);
  });

  it("reports a line it can't read, and two lines for one occurrence", () => {
    const got = parseSchedule(`${BASE}2026-11-01 bbbb pickup
2026-11-02 BBBB maybe
2026-11-03 BBBB skip 10:00-11:00
2026-11-04 BBBB pickup 9:00-10:00
2026-11-05 BBBB pickup
2026-11-05 BBBB skip`);

    assert.equal(got.errors.length, 5);
    assert.match(got.errors.at(-1), /two lines/);
  });

  it("carries the lines on the schedule the functions read", () => {
    const got = pickupSchedule({
      PICKUP_SCHEDULE: `${BASE}2026-11-01 BBBB pickup`,
    });

    assert.equal(got.length, 1);
    assert.equal(got.lines.length, 1);
  });

  const now = ny("2026-10-20");
  // Every date the coverage window holds, so only the line under test
  // can fail.
  const FULL = "2026-10-25 BBBB pickup\n2026-11-01 BBBB pickup\n"
    + "2026-11-08 BBBB pickup\n2026-11-07 CCCC pickup\n";
  const check = (text, over = {}) => checkSchedule(
    `${BASE}2026-11-10 09:00-12:00\n${text}`,
    { now, timeZone: terms.timeZone, model, ...over }
  ).errors.join("|");

  it("passes when every in-season date in the window has its line", () => {
    assert.equal(check("2026-10-25 BBBB pickup\n2026-11-01 BBBB attend"), "");
  });

  it("fails the deploy on a date with no line", () => {
    assert.match(check("2026-10-25 BBBB pickup"),
      /2026-11-01: BBBB \(Common Market\) needs a line/);
    assert.equal(check("2026-10-25 BBBB pickup\n2026-11-01 BBBB skip"), "");
  });

  it("fails on an unknown or archived code", () => {
    assert.match(check(`${FULL}2026-11-02 ZZZZ pickup`), /not a series/);
    assert.match(check(`${FULL}2026-10-24 DDDD pickup`), /archived/);
  });

  it("fails on a date the series doesn't have", () => {
    assert.match(check(`${FULL}2026-11-02 BBBB pickup`), /no occurrence then/);
    assert.match(check(`${FULL}2026-12-06 BBBB pickup`), /no occurrence then/);
    assert.match(check(`${FULL}2026-11-14 CCCC pickup`), /no occurrence then/);
  });

  it("fails on a window outside the series' hours", () => {
    assert.match(check(`${FULL}2026-11-15 BBBB pickup 08:00-12:00`),
      /outside BBBB/);
    assert.match(check(`${FULL}2026-11-22 BBBB pickup 12:00-14:00`),
      /outside BBBB/);
    assert.equal(check(`${FULL}2026-11-15 BBBB pickup 10:00-12:00`), "");
  });

  it("fails on two lines for one occurrence", () => {
    assert.match(check(`${FULL}2026-11-15 BBBB pickup\n`
      + "2026-11-15 BBBB attend"), /two lines/);
  });

  it("asks nothing of an archived series", () => {
    assert.doesNotMatch(check(FULL), /DDDD/);
  });
});

describe("the dates a customer is offered", () => {
  const now = ny("2026-10-20");
  const lines = withLines(`2026-10-25 BBBB pickup
2026-11-01 BBBB pickup
2026-11-07 CCCC pickup`);

  it("offers an occurrence only where a line opens it, in the horizon", () => {
    const got = scheduledDates(now, t, lines);

    assert.deepEqual(got.map((d) => d.occurrence), ["BBBB-261025"],
      "Nov 1 lies past the horizon (Oct 31)");
    assert.deepEqual({ ...got[0], cutoff: "" }, {
      occurrence: "BBBB-261025",
      date: "2026-10-25",
      label: "Sunday, October 25",
      series: "BBBB",
      name: "Common Market",
      location: "AAAA",
      town: "Foster",
      place: "Common Market, Town Common, 1 Main St, Foster",
      short: "Town Common, 1 Main St, Foster",
      window: "9:00 AM – 1:00 PM",
      cutoff: "",
    });
  });

  it("does not offer an occurrence with no line", () => {
    assert.deepEqual(scheduledDates(now, t, withLines("")), []);
  });

  it("offers neither an attend nor a skip as pickup", () => {
    const quiet = withLines("2026-10-25 BBBB attend");

    assert.deepEqual(scheduledDates(now, t, quiet), []);
    assert.deepEqual(scheduledDates(now, t,
      withLines("2026-10-25 BBBB skip")), []);
  });

  it("narrows a window when the line does", () => {
    const got = scheduledDates(now, t,
      withLines("2026-10-25 BBBB pickup 10:00-12:00"));

    assert.equal(got[0].window, "10:00 AM – 12:00 PM");
  });

  it("ends at the horizon, however many dates the schedule has", () => {
    const soon = ny("2026-11-02");
    const many = withLines(`2026-11-08 BBBB pickup
2026-11-15 BBBB pickup
2026-11-22 BBBB pickup
2026-11-07 CCCC pickup`);
    const got = scheduledDates(soon, t, many);

    assert.deepEqual(got.map((d) => d.occurrence),
      ["CCCC-261107", "BBBB-261108"], "by date; Nov 15 is past Nov 14");
    assert.ok(got.every((d) => d.date <= "2026-11-14"));
  });

  it("sorts by date, then start time", () => {
    const sameDay = buildModel(LOCATIONS, [
      { ...SERIES[0], code: "FFFF", name: "Late", opens: "15:00",
        closes: "17:00" },
      { ...SERIES[0], code: "GGGG", name: "Early", opens: "08:00",
        closes: "10:00" },
    ]);
    const got = scheduledDates(now, { ...terms, model: sameDay },
      withLines("2026-10-25 FFFF pickup\n2026-10-25 GGGG pickup"));

    assert.deepEqual(got.map((d) => d.series), ["GGGG", "FFFF"]);
  });

  it("has a cutoff of the end of the day before", () => {
    const [got] = scheduledDates(now, t, lines);

    assert.equal(got.cutoff, ny("2026-10-25", 0).toISOString());
  });

  it("drops an occurrence whose cutoff has passed", () => {
    const late = ny("2026-10-25", 0, 1);
    const only = withLines("2026-10-25 BBBB pickup");

    assert.deepEqual(scheduledDates(late, t, only), []);
  });

  it("lists attended occurrences for the map, not the skipped", () => {
    const events = eventDates(now, t, withLines(`2026-10-25 BBBB attend
2026-11-01 BBBB skip`));

    assert.deepEqual(events.map((e) => [e.occurrence, e.status, e.kind]),
      [["BBBB-261025", "attend", "market"]]);
    assert.equal(events[0].href, "https://example.com/market");
    assert.equal(events[0].lat, 41.8);
    assert.deepEqual(eventDates(now, t, lines).map((e) => e.status),
      ["pickup"]);
  });

  it("gives /api/dates a scheduled list beside the others", () => {
    const got = allDates(now, t, lines);

    assert.equal(got.scheduled.length, 1);
    assert.deepEqual(got.scituate, [], "the drop site isn't in this data");
    assert.ok(got.onfarm && got.delivery);
    assert.equal(got.pickup, undefined);
  });

  it("lets the farm book any live occurrence, not only the schedule's", () => {
    const all = datesFor("scheduled", now, t, lines, true);

    assert.ok(all.some((d) => d.occurrence === "BBBB-261122"));
    assert.ok(all.some((d) => d.occurrence === "CCCC-261107"));
    assert.ok(!all.some((d) => d.series === "DDDD"));
  });
});

describe("the drop site", () => {
  it("keeps the old scituate list, from the drop site's occurrences", () => {
    const drop = terms.model.series.find((s) => s.kind === "drop-site");
    const monday = ny("2026-10-19");
    const lines = withLines(`2026-10-24 ${drop.code} pickup`);
    const got = allDates(monday, terms, lines);

    assert.deepEqual(got.scituate.map((d) => d.date), ["2026-10-24"]);
    assert.deepEqual(Object.keys(got.scituate[0]),
      ["date", "label", "cutoff"]);
    assert.equal(got.scheduled[0].name, "Drop site");
    assert.equal(got.scheduled[0].town, "Scituate");
  });
});

describe("integrity", () => {
  const ok = {
    locations: LOCATIONS, series: SERIES,
    registered: ["AAAA", "BBBB", "CCCC", "DDDD"], today: "2026-10-22",
  };

  it("passes a sound set", () => {
    assert.deepEqual(checkIntegrity(ok), []);
  });

  it("fails on a duplicate code", () => {
    const errors = checkIntegrity({
      ...ok, series: [...SERIES, { ...SERIES[1], name: "Twin" }],
    });

    assert.ok(errors.some((e) => /"CCCC" is used by more than one/.test(e)));
  });

  it("fails on a code in the data that the registry lacks", () => {
    const errors = checkIntegrity({ ...ok, registered: ["AAAA", "BBBB"] });

    assert.equal(errors.filter((e) => /not in data\/registry/.test(e))
      .length, 2);
  });

  it("fails on a registered code that no longer resolves", () => {
    const errors = checkIntegrity({
      ...ok, registered: [...ok.registered, "HHHH"],
    });

    assert.ok(errors.some((e) => /"HHHH" is registered but no data/.test(e)));
  });

  it("fails on a code registered twice and on a malformed code", () => {
    assert.ok(checkIntegrity({
      ...ok, registered: [...ok.registered, "AAAA"],
    }).some((e) => /registered twice/.test(e)));
    assert.ok(checkIntegrity({
      ...ok, series: [{ ...SERIES[0], code: "bad" }],
      registered: ["AAAA", "bad"],
    }).some((e) => /not a 4-character code/.test(e)));
  });

  it("fails on a series at a missing location", () => {
    const errors = checkIntegrity({
      ...ok, locations: [{ ...LOCATIONS[0], code: "XXXX" }],
      registered: [...ok.registered, "XXXX"],
    });

    assert.ok(errors.some((e) => /names location "AAAA", which doesn't/
      .test(e)));
  });

  it("fails on a series in season at an archived location, not after", () => {
    const archived = [{ ...LOCATIONS[0], archived: true }];

    assert.ok(checkIntegrity({ ...ok, locations: archived })
      .some((e) => /still in season at archived location AAAA/.test(e)));
    assert.deepEqual(checkIntegrity({
      ...ok, locations: archived, today: "2026-12-01",
    }), [], "BBBB has ended by December; CCCC and DDDD too");
  });

  it("fails on a schedule line naming an unknown code", () => {
    const errors = checkIntegrity({
      ...ok, lines: [{ date: "2026-11-01", code: "ZZZZ", action: "skip" }],
    });

    assert.ok(errors.some((e) => /names "ZZZZ", which is not a series/
      .test(e)));
  });
});
