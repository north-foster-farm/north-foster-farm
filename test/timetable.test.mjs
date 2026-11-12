// The pickup picker as a timetable (#573): lib/timetable.mjs, the
// board's columns, places, routines and cells, and the words on its
// chips, heads and summary. order/pickup-picker.js draws what this
// works out; which pickup is chosen is test/picker.test.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  board, boardColumns, chipCutoff, chipName, chipText, columnOf,
  routineText, summary, weekRange,
} from "../assets/scripts/order/lib/timetable.mjs";
import {
  asRounds, mergeScheduled,
} from "../assets/scripts/order/lib/group.mjs";
import { scheduledChoices } from "../assets/scripts/order/lib/scheduled.mjs";

const ZONE = "America/New_York";
// Thursday, November 12, 2026: this week runs November 8 to 14.
const TODAY = "2026-11-12";

// The places as data/locations.json has them (the drop site's and
// Pawtucket's), for the row heads' addresses.
const LOCATIONS = {
  G4C6: {
    code: "G4C6", name: "46 Institute Lane", street: "46 Institute Lane",
    city: "North Scituate", state: "RI", zip: "02857",
    town: "North Scituate",
  },
  P7KX: {
    code: "P7KX", name: "Jordan's Jungle", street: "545 Pawtucket Ave",
    city: "Pawtucket", state: "RI", zip: "02860", town: "Pawtucket",
  },
};
const locate = (entry) => LOCATIONS[entry.location] || null;

const entry = (occurrence, date, label, extra) => ({
  occurrence, date, label, ...extra,
});
const DROP = {
  series: "VFVQ", name: "Drop site", town: "North Scituate",
  location: "G4C6", window: "10:00 – 11:00 AM",
};
const MARKET = {
  series: "H3TQ", name: "Pawtucket Farmers Market", town: "Pawtucket",
  location: "P7KX", window: "12:00 – 4:00 PM",
};
const PREP = {
  series: "W9MF", name: "Thanksgiving Prep", town: "Pawtucket",
  location: "P7KX", window: "12:00 – 5:00 PM",
};

// Today's list (horizon November 13 to 21), as on the wireframes: the
// drop site both Saturdays, the market's Tuesday and the pop-up on the
// second Saturday, a day with two places.
const LIST = scheduledChoices([
  entry("VFVQ-261114", "2026-11-14", "Saturday, November 14", {
    ...DROP, cutoff: "2026-11-14T04:59:00.000Z",
  }),
  entry("H3TQ-261117", "2026-11-17", "Tuesday, November 17", {
    ...MARKET, cutoff: "2026-11-17T04:59:00.000Z",
  }),
  entry("VFVQ-261121", "2026-11-21", "Saturday, November 21", {
    ...DROP, cutoff: "2026-11-21T04:59:00.000Z",
  }),
  entry("W9MF-261121", "2026-11-21", "Saturday, November 21", {
    ...PREP, cutoff: "2026-11-21T04:59:00.000Z",
  }),
]);
const ROUND = entry("36TS-261206", "2026-12-06", "Sunday, December 6", {
  series: "36TS", name: "Sample group", town: "Warwick", location: "",
  short: "Sample Hall, Warwick", window: "8:30 – 9:00 AM",
  cutoff: "2026-12-06T04:59:00.000Z",
});

describe("the timetable's columns", () => {
  it("are this week, next week and later, by today's week", () => {
    assert.equal(columnOf("2026-11-14", TODAY), "this");
    assert.equal(columnOf("2026-11-15", TODAY), "next");
    assert.equal(columnOf("2026-11-21", TODAY), "next");
    assert.equal(columnOf("2026-11-22", TODAY), "later");
    assert.equal(columnOf("2026-11-07", TODAY), "booked");
  });

  it("are only those with a pickup, each with its dates", () => {
    assert.deepEqual(boardColumns(LIST, TODAY), [
      { key: "this", name: "This week", range: "Nov 8 – 14" },
      { key: "next", name: "Next week", range: "Nov 15 – 21" },
    ]);
    assert.deepEqual(boardColumns(LIST.slice(1), TODAY).map((c) => c.key),
      ["next"]);
    assert.deepEqual(boardColumns([], TODAY), []);
  });

  it("gain Later for a group's round, with no dates under it", () => {
    const columns = boardColumns([...LIST, ROUND], TODAY);

    assert.deepEqual(columns.at(-1), { key: "later", name: "Later",
      range: "" });
  });

  it("put a week's range across two months as both", () => {
    assert.equal(weekRange("2026-11-29"), "Nov 29 – Dec 5");
    assert.equal(weekRange("2026-11-08"), "Nov 8 – 14");
  });
});

describe("the timetable's places and routines", () => {
  const { columns, places } = board(LIST, { today: TODAY, locate });

  it("come in the order of their first pickup", () => {
    assert.deepEqual(places.map((p) => p.key), ["G4C6", "P7KX"]);
  });

  it("head a place of one routine with the pickup's name", () => {
    const [drop] = places;

    assert.equal(drop.several, false);
    assert.equal(drop.title, "North Scituate · Drop site");
    assert.equal(drop.address, "46 Institute Lane, North Scituate, RI 02857");
    assert.equal(drop.routines[0].when, "Saturdays, 10:00 – 11:00 AM");
    assert.equal(drop.routines[0].name, "");
  });

  it("head a place of several with its town and venue, a row each", () => {
    const pawtucket = places[1];

    assert.equal(pawtucket.several, true);
    assert.equal(pawtucket.title, "Pawtucket · Jordan's Jungle");
    assert.equal(pawtucket.address, "545 Pawtucket Ave, Pawtucket, RI 02860");
    assert.deepEqual(pawtucket.routines.map((r) => [r.name, r.when]), [
      ["Pawtucket Farmers Market", "Tuesday, 12:00 – 4:00 PM"],
      ["Thanksgiving Prep", "Saturday, 12:00 – 5:00 PM"],
    ]);
  });

  it("put each pickup in its week's cell, a dash where none", () => {
    const cells = (place, i = 0) => place.routines[i].cells
      .map((list) => list.map((d) => d.value));

    assert.equal(columns.length, 2);
    assert.deepEqual(cells(places[0]), [["VFVQ-261114"], ["VFVQ-261121"]]);
    assert.deepEqual(cells(places[1], 0), [[], ["H3TQ-261117"]]);
    assert.deepEqual(cells(places[1], 1), [[], ["W9MF-261121"]]);
  });

  it("show a day with two places as two chips in two rows", () => {
    const sat21 = places.flatMap((p) => p.routines)
      .flatMap((r) => r.cells[1]).filter((d) => d.date === "2026-11-21");

    assert.deepEqual(sat21.map((d) => d.series), ["VFVQ", "W9MF"]);
  });

  it("stack two dates of one routine in one week in one cell", () => {
    const twice = scheduledChoices([
      entry("VFVQ-261118", "2026-11-18", "Wednesday, November 18", DROP),
      entry("VFVQ-261121", "2026-11-21", "Saturday, November 21", DROP),
    ]);
    const [place] = board(twice, { today: TODAY, locate }).places;

    assert.deepEqual(place.routines[0].cells[0].map((d) => d.value),
      ["VFVQ-261118", "VFVQ-261121"]);
    assert.equal(place.routines[0].when,
      "Wednesday and Saturday, 10:00 – 11:00 AM");
  });

  it("name each place and routine in full for a screen reader", () => {
    assert.equal(places[0].spoken, "North Scituate, Drop site, 46 " +
      "Institute Lane, North Scituate, RI 02857, Saturdays, 10:00 to " +
      "11:00 AM");
    assert.equal(places[1].spoken, "Pawtucket, Jordan's Jungle, 545 " +
      "Pawtucket Ave, Pawtucket, RI 02860");
    assert.equal(places[1].routines[1].spoken,
      "Thanksgiving Prep, Saturday, 12:00 to 5:00 PM");
    assert.equal(places[0].routines[0].spoken, "");
  });

  it("is one row with one place only", () => {
    const one = board(LIST.filter((d) => d.series === "VFVQ"),
      { today: TODAY, locate });

    assert.equal(one.places.length, 1);
    assert.equal(one.places[0].routines.length, 1);
    assert.equal(one.columns.length, 2);
  });

  it("is empty with nothing open", () => {
    assert.deepEqual(board([], { today: TODAY, locate }),
      { columns: [], places: [] });
  });

  it("badge a group's round, which sits in Later", () => {
    const list = mergeScheduled(LIST, asRounds([ROUND]));
    const { columns: cols, places: all } = board(scheduledChoices(list),
      { today: TODAY, locate });
    const round = all.at(-1);

    assert.equal(cols.length, 3);
    assert.equal(round.title, "Warwick · Sample group");
    assert.equal(round.address, "Sample Hall, Warwick");
    assert.equal(round.routines[0].round, true);
    assert.deepEqual(round.routines[0].cells.map((c) => c.length),
      [0, 0, 1]);
    assert.equal(all[0].routines[0].round, false);
  });

  it("keep a booked pickup that has gone in its place's row", () => {
    const booked = {
      value: "VFVQ-261107", occurrence: "VFVQ-261107", date: "2026-11-07",
      label: "Saturday, November 7", window: "", name: "", town: "",
      place: "", short: "", series: "VFVQ", booked: true,
    };
    const got = board([booked, ...LIST], { today: TODAY, locate });

    assert.deepEqual(got.columns.map((c) => c.key),
      ["booked", "this", "next"]);
    assert.equal(got.places[0].title, "North Scituate · Drop site");
    assert.deepEqual(got.places[0].routines[0].cells.map((c) => c.length),
      [1, 1, 1]);
    assert.equal(got.places[0].routines[0].when,
      "Saturdays, 10:00 – 11:00 AM", "the booked date is left out");
  });

  it("keep a pickup that just closed in its cell, struck", () => {
    const closed = { ...LIST[0], closed: true };
    const got = board([closed, ...LIST.slice(1)], { today: TODAY, locate });

    assert.deepEqual(got.places[0].routines[0].cells[0], [closed]);
    assert.equal(got.places[0].routines[0].when,
      "Saturday, 10:00 – 11:00 AM", "only the open dates count");
  });
});

describe("the timetable's words", () => {
  it("say a routine by its weekdays and hours", () => {
    assert.equal(routineText(["2026-11-14", "2026-11-21"], "10 – 11 AM"),
      "Saturdays, 10 – 11 AM");
    assert.equal(routineText(["2026-11-21"], "12:00 – 5:00 PM"),
      "Saturday, 12:00 – 5:00 PM");
    assert.equal(routineText(["2026-11-17", "2026-11-14", "2026-11-21"]),
      "Tuesday and Saturdays");
    assert.equal(routineText(["2026-11-15", "2026-11-17", "2026-11-21"]),
      "Sunday, Tuesday, and Saturday");
  });

  it("put the day and date on a chip, and the month when it's later", () => {
    assert.equal(chipText("2026-11-21", "next"), "Sat 21");
    assert.equal(chipText("2026-11-14", "this"), "Sat 14");
    assert.equal(chipText("2026-12-06", "later"), "Sun Dec 6");
    assert.equal(chipText("2026-11-07", "booked"), "Sat Nov 7");
  });

  it("give a chip its order-by day in the farm's zone", () => {
    assert.equal(chipCutoff(LIST[0].cutoff, ZONE), "Order by Fri");
    assert.equal(chipCutoff(LIST[1].cutoff, ZONE), "Order by Mon");
    assert.equal(chipCutoff("", ZONE), "");
  });

  it("name a chip in full, beside its group's name", () => {
    assert.equal(chipName(LIST[2], "next"),
      "Saturday, November 21, next week");
    assert.equal(chipName({ ...LIST[2], booked: true }, "next"),
      "Saturday, November 21, next week, as booked");
    assert.equal(chipName({ ...LIST[0], closed: true }, "this"),
      "Saturday, November 14, this week, closed");
    assert.equal(chipName(ROUND, "later"), "Sunday, December 6, later");
  });

  it("sum up the chosen pickup", () => {
    assert.deepEqual(summary(LIST[1], locate(LIST[1]), { timeZone: ZONE }), {
      title: "Your pickup",
      when: "Tuesday, November 17, 12:00 – 4:00 PM",
      name: "Pawtucket Farmers Market",
      orderBy: "Order by Monday, November 16, 11:59 PM",
    });
  });

  it("title the summary for an order being changed", () => {
    const opts = { timeZone: ZONE, booked: "VFVQ-261121" };

    assert.equal(summary(LIST[2], null, opts).title,
      "Your pickup, as booked");
    assert.equal(summary(LIST[1], null, opts).title, "Moving to");
  });

  it("have no semicolons or em dashes (#400)", () => {
    const { columns, places } = board([...LIST, ROUND],
      { today: TODAY, locate });
    const lines = [
      ...columns.flatMap((c) => [c.name, c.range]),
      ...places.flatMap((p) => [p.title, p.address, p.spoken,
        ...p.routines.flatMap((r) => [r.name, r.when, r.spoken])]),
      ...Object.values(summary(LIST[3], null, { timeZone: ZONE })),
      chipName(LIST[3], "next"), chipCutoff(LIST[3].cutoff, ZONE),
    ];

    for (const line of lines) assert.doesNotMatch(line, /[;—]/, line);
  });
});
