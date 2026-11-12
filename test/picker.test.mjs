// The pickup picker's choosing logic (#540, kept by the timetable of
// #573): lib/picker.mjs, which order/pickup-picker.js draws on the
// order page, in the lapsed dialog and in the account's Change pickup,
// and the refresh date-lists.js sets for the earliest cutoff. The
// board's layout is test/timetable.test.mjs.

import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { DateLists } from "../assets/scripts/order/date-lists.js";
import {
  CLOSED, addressOf, bookedEntry, chosenText, closedEntry, earliestCutoff,
  keptNote, movedNote, occurrenceDate, orderBy, resolveChoice, stillOpen,
  weekStart, withBooked,
} from "../assets/scripts/order/lib/picker.mjs";
import { scheduledChoices } from "../assets/scripts/order/lib/scheduled.mjs";

const ZONE = "America/New_York";
// Wednesday, November 11, 2026: this week runs November 8 to 14.
const TODAY = "2026-11-11";

// /api/dates' `scheduled` entries as it reads them (lib/dates.mjs),
// with the place names of #541 and Pawtucket (#544): three places
// some weeks, a day with two, and a buying group's round three weeks
// out.
const entry = (occurrence, date, label, extra) => ({
  occurrence, date, label, cutoff: "", ...extra,
});
const LIST = scheduledChoices([
  entry("VFVQ-261114", "2026-11-14", "Saturday, November 14", {
    series: "VFVQ", name: "Drop site", town: "North Scituate",
    location: "north-scituate", window: "10:00 – 11:00 AM",
    short: "46 Institute Lane, North Scituate",
    cutoff: "2026-11-14T04:59:00.000Z",
  }),
  entry("WAC5-261115", "2026-11-15", "Sunday, November 15", {
    series: "WAC5", name: "Foster Farmers Market", town: "Foster",
    location: "foster", window: "9:00 AM – 1:00 PM",
    cutoff: "2026-11-15T04:59:00.000Z",
  }),
  entry("H3TQ-261117", "2026-11-17", "Tuesday, November 17", {
    series: "H3TQ", name: "Pawtucket Farmers Market", town: "Pawtucket",
    location: "pawtucket", window: "12:00 – 4:00 PM",
    short: "Jordan's Jungle, Pawtucket",
    cutoff: "2026-11-17T04:59:00.000Z",
  }),
  entry("VFVQ-261121", "2026-11-21", "Saturday, November 21", {
    series: "VFVQ", name: "Drop site", town: "North Scituate",
    location: "north-scituate", window: "10:00 – 11:00 AM",
    cutoff: "2026-11-21T04:59:00.000Z",
  }),
  entry("W9MF-261121", "2026-11-21", "Saturday, November 21", {
    series: "W9MF", name: "Thanksgiving Prep", town: "Pawtucket",
    location: "pawtucket", window: "12:00 – 5:00 PM",
    cutoff: "2026-11-21T04:59:00.000Z",
  }),
  entry("G7RD-261205", "2026-12-05", "Saturday, December 5", {
    series: "G7RD", name: "Round", town: "Foster", location: "foster",
    window: "10:00 – 11:00 AM", cutoff: "2026-12-05T04:59:00.000Z",
  }),
]);
const [drop, foster, , drop21, popup] = LIST;

describe("the picker's weeks", () => {
  it("run Sunday to Saturday", () => {
    assert.equal(weekStart(TODAY), "2026-11-08");
    assert.equal(weekStart("2026-11-08"), "2026-11-08");
    assert.equal(weekStart("2026-11-14"), "2026-11-08");
  });
});

describe("the picker's words", () => {
  it("announce a pickup chosen, with its day", () => {
    assert.equal(chosenText(drop), "Pickup chosen: Saturday, November " +
      "14, 10:00 to 11:00 AM, North Scituate, Drop site");
    assert.equal(chosenText(foster), "Pickup chosen: Sunday, November " +
      "15, 9:00 AM to 1:00 PM, Foster Farmers Market");
  });

  it("take the town from the location when the entry has none", () => {
    assert.equal(chosenText({ ...drop, town: "" }, { town: "Scituate" }),
      "Pickup chosen: Saturday, November 14, 10:00 to 11:00 AM, " +
      "Scituate, Drop site");
  });

  it("have no semicolons or em dashes (#400)", () => {
    const lines = [
      chosenText(popup), CLOSED, movedNote("VFVQ-261114", drop21),
      orderBy(drop.cutoff, ZONE),
    ];

    for (const line of lines) assert.doesNotMatch(line, /[;—]/, line);
  });
});

describe("the row heads' and summary's facts", () => {
  it("give the order-by time in the farm's zone", () => {
    assert.equal(orderBy(drop.cutoff, ZONE),
      "Order by Friday, November 13, 11:59 PM");
    assert.equal(orderBy("", ZONE), "");
  });

  it("take the address from the location when the page has it", () => {
    const loc = {
      name: "North Scituate Community House", street: "46 Institute Lane",
      city: "North Scituate", state: "RI", zip: "02857",
      town: "North Scituate",
    };

    assert.deepEqual(addressOf(drop, loc), [
      "North Scituate Community House", "46 Institute Lane",
      "North Scituate, RI 02857",
    ]);
  });

  it("fall back to the entry's own short address, then its place", () => {
    assert.deepEqual(addressOf(drop, null),
      ["46 Institute Lane", "North Scituate"]);
    assert.deepEqual(addressOf({
      name: "Drop site", place: "Drop site, 46 Institute Lane, North Scituate",
    }, null), ["46 Institute Lane", "North Scituate"]);
  });
});

describe("the pickup that just closed", () => {
  const pick = (note) => ({ value: "", note, booked: false });

  it("stays on the board struck, never as a radio", () => {
    assert.deepEqual(closedEntry({
      pick: pick(CLOSED), before: popup.value, known: popup,
    }), { ...popup, closed: true, booked: false });
  });

  it("is none without the closed note, a choice before, or its facts", () => {
    assert.equal(closedEntry({ pick: pick(""), before: popup.value,
      known: popup }), null);
    assert.equal(closedEntry({ pick: pick(CLOSED), before: "",
      known: popup }), null);
    assert.equal(closedEntry({ pick: pick(CLOSED), before: popup.value,
      known: null }), null);
  });
});

describe("which pickup a list lands on", () => {
  it("keeps the one chosen while the list has it", () => {
    assert.deepEqual(resolveChoice({ list: LIST, current: "W9MF-261121" }),
      { value: "W9MF-261121", note: "", booked: false });
  });

  it("chooses a draft's or a link's pickup over the one on the page", () => {
    assert.equal(resolveChoice({
      list: LIST, current: "W9MF-261121", want: "H3TQ-261117",
    }).value, "H3TQ-261117");
  });

  it("chooses nothing until the customer does", () => {
    assert.deepEqual(resolveChoice({ list: LIST }),
      { value: "", note: "", booked: false });
  });

  it("says so when the chosen pickup has closed", () => {
    const list = LIST.filter((d) => d.value !== "W9MF-261121");

    assert.deepEqual(resolveChoice({ list, current: "W9MF-261121" }),
      { value: "", note: CLOSED, booked: false });
    assert.equal(CLOSED,
      "That pickup is no longer available. Please choose another.");
  });

  it("names both dates when an old drop site draft moves to the next", () => {
    const list = LIST.slice(1);
    const got = resolveChoice({
      list, want: "VFVQ-261114", series: "VFVQ",
    });

    assert.equal(got.value, "VFVQ-261121");
    assert.equal(got.note, "Your saved pickup on Saturday, November 14 is " +
      "no longer available, so we chose the next one, on Saturday, " +
      "November 21.");
  });

  it("never falls to another place's date", () => {
    const list = LIST.filter((d) => d.series !== "VFVQ");

    assert.deepEqual(resolveChoice({
      list, want: "VFVQ-261114", series: "VFVQ",
    }), { value: "", note: CLOSED, booked: false });
  });

  it("holds the note back for a group's round not yet listed", () => {
    assert.equal(resolveChoice({
      list: LIST, want: "Q2RD-261128", quiet: true,
    }).note, "");
  });

  it("says nothing of a closed pickup when nothing is open", () => {
    assert.equal(resolveChoice({ list: [], current: drop.value }).note, "");
  });

  it("offers the booked pickup As booked once it has gone", () => {
    const booked = bookedEntry({
      fulfilment: { method: "scheduled", date: "2026-11-07" },
      pickup: {
        occurrence: "VFVQ-261107", name: "Drop site", window: "10 – 11 AM",
        place: "Drop site, 46 Institute Lane, North Scituate", series: "VFVQ",
      },
    });

    assert.deepEqual(resolveChoice({
      list: LIST, want: "VFVQ-261107", booked,
    }), { value: "VFVQ-261107", note: "", booked: true });
    assert.deepEqual(withBooked(LIST, booked).map((d) => d.value)
      .slice(0, 2), ["VFVQ-261107", "VFVQ-261114"]);
    assert.equal(booked.label, "Saturday, November 7");
    assert.equal(booked.booked, true);
  });

  it("keeps the booked pickup in date order among the rest", () => {
    const booked = { ...drop21, value: "ZZ9Q-261121", booked: true };

    assert.deepEqual(withBooked(LIST, booked).map((d) => d.value), [
      "VFVQ-261114", "WAC5-261115", "H3TQ-261117", "VFVQ-261121",
      "W9MF-261121", "ZZ9Q-261121", "G7RD-261205",
    ]);
  });

  it("has no booked pickup for an order that is not one", () => {
    assert.equal(bookedEntry({ fulfilment: { method: "delivery" } }), null);
  });

  it("reads an occurrence id's date", () => {
    assert.equal(occurrenceDate("VFVQ-261114"), "2026-11-14");
    assert.equal(occurrenceDate("nonsense"), "");
  });
});

describe("the refresh at the earliest cutoff (date-lists.js tick)", () => {
  afterEach(() => mock.timers.reset());

  it("finds the earliest cutoff in a list", () => {
    assert.equal(earliestCutoff(LIST), Date.parse(drop.cutoff));
    assert.equal(earliestCutoff([{ cutoff: "" }]), null);
    assert.equal(earliestCutoff([]), null);
  });

  it("refreshes the lists once the earliest pickup has closed", () => {
    mock.timers.enable({
      apis: ["setTimeout", "Date"], now: Date.parse("2026-11-13T12:00:00Z"),
    });

    const form = { querySelector: () => null, querySelectorAll: () => [] };
    const lists = new DateLists(form, () => {});

    lists.lists = { scheduled: LIST, delivery: [] };
    lists.refresh = mock.fn(async () => true);
    lists.tick();

    const wait = Date.parse(drop.cutoff) - Date.now();

    mock.timers.tick(wait);
    assert.equal(lists.refresh.mock.callCount(), 0, "not before it closes");
    mock.timers.tick(1000);
    assert.equal(lists.refresh.mock.callCount(), 1);
  });

  it("keeps the entries still open, and those with no cutoff", () => {
    const now = Date.parse(drop.cutoff);

    assert.deepEqual(stillOpen(LIST, now).map((d) => d.value),
      LIST.slice(1).map((d) => d.value), "closes at its cutoff");
    assert.deepEqual(stillOpen([{ cutoff: "" }], now), [{ cutoff: "" }]);
    assert.deepEqual(stillOpen(null, now), []);
  });

  // A group's round that closes with the page open: kept in `extra`,
  // its passed cutoff stayed the earliest and the lists refreshed
  // about once a second (#540 review).
  it("drops a group's round once it closes, so it refreshes once", () => {
    const at = Date.parse("2026-11-13T12:00:00Z");

    mock.timers.enable({ apis: ["setTimeout", "Date"], now: at });

    const form = { querySelector: () => null, querySelectorAll: () => [] };
    const lists = new DateLists(form, () => {});
    const round = { ...popup, occurrence: "R0ND-261113",
      value: "R0ND-261113", cutoff: "2026-11-13T11:59:00.000Z" };
    const server = LIST.slice(1);

    lists.extra = [round];
    lists.refresh = mock.fn(async () => true);
    lists.apply({ now: new Date(at).toISOString(), scheduled: server,
      delivery: [] });

    assert.deepEqual(lists.extra, []);
    assert.ok(!lists.lists.scheduled.some((d) => d.value === round.value));

    mock.timers.tick(60_000);
    assert.equal(lists.refresh.mock.callCount(), 0,
      "no refresh for the round that has closed");
    mock.timers.tick(Date.parse(foster.cutoff) - Date.now() + 1000);
    assert.equal(lists.refresh.mock.callCount(), 1,
      "one at the next pickup's cutoff");
  });

  it("joins only open rounds when a group's code is accepted", () => {
    const at = Date.parse("2026-11-13T12:00:00Z");

    mock.timers.enable({ apis: ["setTimeout", "Date"], now: at });

    const lists = new DateLists({
      querySelector: () => null, querySelectorAll: () => [],
    }, () => {});
    const closed = { ...popup, occurrence: "R0ND-261113",
      cutoff: "2026-11-13T11:59:00.000Z" };

    lists.setExtra([closed, popup]);
    assert.deepEqual(lists.extra, [popup]);
  });
});

describe("the note across a refresh", () => {
  const pick = (value, note = "") => ({ value, note, booked: false });

  it("keeps the closed note while nothing is chosen", () => {
    assert.equal(keptNote({ pick: pick(""), before: "", shown: CLOSED,
      some: true }), CLOSED);
  });

  it("keeps the moved note while its pickup stays chosen", () => {
    const moved = movedNote("VFVQ-261114", drop21);

    assert.equal(keptNote({ pick: pick(drop21.value), before: drop21.value,
      shown: moved, some: true }), moved);
  });

  it("drops it once the choice differs or the list is empty", () => {
    assert.equal(keptNote({ pick: pick(""), before: drop21.value,
      shown: CLOSED, some: true }), "");
    assert.equal(keptNote({ pick: pick(""), before: "", shown: CLOSED,
      some: false }), "");
  });

  it("takes a new note over the one shown", () => {
    assert.equal(keptNote({ pick: pick("", CLOSED), before: drop21.value,
      shown: "Old", some: true }), CLOSED);
  });
});
