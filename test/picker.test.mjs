// The pickup-day picker's logic (#540, the design approved on #539):
// lib/picker.mjs, which order/pickup-picker.js draws on the order
// page, in the lapsed dialog and in the account's Change pickup, and
// the refresh date-lists.js sets for the earliest cutoff.

import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { DateLists } from "../assets/scripts/order/date-lists.js";
import {
  CLOSED, addressOf, availability, bookedEntry, chosenText, dayLabel,
  detailsOf, earliestCutoff, insteadText, keptNote, moveText, movedNote,
  nextAtSame, nextTitle, occurrenceDate, onePlace, orderBy, orderByTime,
  pickerWeeks, rangeText, receiptOf, resolveChoice, stillOpen, weekName,
  weekStart, weekTitle, whenText, withBooked,
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
  const weeks = pickerWeeks(LIST);

  it("run Sunday to Saturday", () => {
    assert.equal(weekStart(TODAY), "2026-11-08");
    assert.equal(weekStart("2026-11-08"), "2026-11-08");
    assert.equal(weekStart("2026-11-14"), "2026-11-08");
    assert.deepEqual(weeks[0].days.map((d) => d.weekday),
      ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    assert.equal(weeks[0].end, "2026-11-14");
  });

  it("are only those with a pickup, one row each", () => {
    assert.deepEqual(weeks.map((w) => w.start),
      ["2026-11-08", "2026-11-15", "2026-11-29"]);
  });

  it("mark a week that skips one, as a group's round, as a gap", () => {
    assert.deepEqual(weeks.map((w) => w.gap), [false, false, true]);
    assert.deepEqual(pickerWeeks([drop, drop21]).map((w) => w.gap),
      [false, false]);
  });

  it("reach a group's round up to 60 days out, with one gap", () => {
    const far = { ...drop, value: "G7RD-270109", date: "2027-01-09" };
    const rows = pickerWeeks([drop, drop21, far]);

    assert.deepEqual(rows.map((w) => w.start),
      ["2026-11-08", "2026-11-15", "2027-01-03"]);
    assert.deepEqual(rows.map((w) => w.gap), [false, false, true]);
  });

  it("open only the days that have a pickup; past days are greyed", () => {
    const [now] = weeks;

    assert.deepEqual(now.days.map((d) => d.open),
      [false, false, false, false, false, false, true]);
    assert.equal(now.days[3].date, TODAY);
    assert.equal(now.days[6].number, 14);
  });

  it("keep a day's several pickups in the list's order", () => {
    const sat = weeks[1].days[6];

    assert.deepEqual(sat.entries.map((d) => d.value),
      ["VFVQ-261121", "W9MF-261121"]);
  });

  it("are none for an empty list", () => {
    assert.deepEqual(pickerWeeks([]), []);
  });
});

describe("the strip's words", () => {
  it("title a week this week, next week, or by its dates", () => {
    assert.equal(weekName("2026-11-08", TODAY), "This week");
    assert.equal(weekName("2026-11-15", TODAY), "Next week");
    assert.equal(weekName("2026-11-29", TODAY), "");
    assert.equal(weekTitle("2026-11-15", TODAY), "Next week, November 15 – 21");
    assert.equal(weekTitle("2026-11-08", TODAY, { short: true }),
      "This week, Nov 8 – 14");
    assert.equal(weekTitle("2026-11-29", TODAY), "November 29 – December 5");
    assert.equal(weekTitle("2026-11-29", TODAY, { short: true }),
      "Nov 29 – Dec 5");
  });

  it("say the dash as \"to\"", () => {
    assert.equal(rangeText("2026-11-22", { spoken: true }),
      "November 22 to 28");
  });

  it("count a day's pickups, or show a dash", () => {
    assert.equal(availability(1), "1 pickup");
    assert.equal(availability(2), "2 pickups");
    assert.equal(availability(0), "–");
  });

  it("name each day in full for a screen reader, greyed ones too", () => {
    const [now, next] = pickerWeeks(LIST);

    assert.equal(dayLabel(next.days[6]), "Saturday, November 21, 2 pickups");
    assert.equal(dayLabel(now.days[6]), "Saturday, November 14, 1 pickup");
    assert.equal(dayLabel(next.days[1]), "Monday, November 16, no pickups");
  });

  it("announce a pickup a one-pickup day chose", () => {
    assert.equal(chosenText(drop),
      "Pickup chosen: 10:00 to 11:00 AM, North Scituate, Drop site");
    assert.equal(chosenText(foster),
      "Pickup chosen: 9:00 AM to 1:00 PM, Foster Farmers Market");
  });

  it("have no semicolons or em dashes (#400)", () => {
    const weeks = pickerWeeks(LIST);
    const r = receiptOf(popup, null, ZONE);
    const lines = [
      weekTitle(weeks[2].start, TODAY), dayLabel(weeks[1].days[0]),
      chosenText(popup), CLOSED, movedNote("VFVQ-261114", drop21),
      orderBy(drop.cutoff, ZONE), r.when, r.spoken, r.where, r.orderBy,
      insteadText(drop21), nextTitle(r.name), moveText(drop, drop21),
      moveText(drop21, popup),
    ];

    for (const line of lines) assert.doesNotMatch(line, /[;—]/, line);
  });
});

describe("the chosen card's details", () => {
  it("names the place and gives the order-by time in the farm's zone", () => {
    assert.equal(orderBy(drop.cutoff, ZONE),
      "Order by Friday, November 13, 11:59 PM");
    assert.equal(orderBy("", ZONE), "");
  });

  it("takes the address from the location when the page has it", () => {
    const loc = {
      name: "North Scituate Community House", street: "46 Institute Lane",
      city: "North Scituate", state: "RI", zip: "02857",
      town: "North Scituate",
    };

    assert.deepEqual(detailsOf(drop, loc, ZONE), {
      name: "North Scituate · Drop site",
      address: [
        "North Scituate Community House", "46 Institute Lane",
        "North Scituate, RI 02857",
      ],
      orderBy: "Order by Friday, November 13, 11:59 PM",
    });
  });

  it("falls back to the entry's own short address, then its place", () => {
    assert.deepEqual(addressOf(drop, null),
      ["46 Institute Lane", "North Scituate"]);
    assert.deepEqual(addressOf({
      name: "Drop site", place: "Drop site, 46 Institute Lane, North Scituate",
    }, null), ["46 Institute Lane", "North Scituate"]);
  });

  it("leaves the place off the cards when there is only one", () => {
    assert.equal(onePlace([drop, drop21]), true);
    assert.equal(onePlace(LIST), false);
  });
});

describe("the settled receipt (#574)", () => {
  const loc = {
    name: "Jordan's Jungle", street: "545 Pawtucket Ave", city: "Pawtucket",
    state: "RI", zip: "02860", town: "Pawtucket",
  };

  it("says the chosen pickup's day, hours, place and order-by time", () => {
    assert.deepEqual(receiptOf(popup, loc, ZONE), {
      when: "Saturday, November 21, 12:00 – 5:00 PM",
      spoken: "Saturday, November 21, 12:00 to 5:00 PM",
      name: "Pawtucket · Thanksgiving Prep",
      where: "Pawtucket · Thanksgiving Prep, Jordan's Jungle, " +
        "545 Pawtucket Ave, Pawtucket, RI 02860",
      orderBy: "Friday, November 20, 11:59 PM",
    });
  });

  it("gives the order-by time without its words, or none", () => {
    assert.equal(orderByTime(drop.cutoff, ZONE),
      "Friday, November 13, 11:59 PM");
    assert.equal(orderByTime("", ZONE), "");
    assert.equal(receiptOf({ ...drop, cutoff: "" }, null, ZONE).orderBy, "");
  });

  it("says an As booked pickup with no hours left by its day alone", () => {
    assert.equal(whenText({ date: "2026-11-17", label: "", window: "" }),
      "Tuesday, November 17");
  });
});

describe("the same place's next date (#574)", () => {
  it("is the next of the gone pickup's series the list still has", () => {
    const fresh = LIST.filter((d) => d.value !== drop.value);

    assert.equal(nextAtSame(fresh, drop), drop21);
    assert.equal(insteadText(drop21), "Choose Saturday, November 21 instead");
    assert.equal(nextTitle("Pawtucket Farmers Market"),
      "Next at Pawtucket Farmers Market");
  });

  it("is none for a place with no other date, or no pickup", () => {
    assert.equal(nextAtSame(LIST, popup), null);
    assert.equal(nextAtSame(LIST, null), null);
    assert.equal(nextAtSame(LIST, { value: "X", date: "2026-11-14" }), null);
  });

  it("never offers the pickup that lapsed itself", () => {
    assert.equal(nextAtSame([drop, drop21], drop), drop21);
    assert.equal(nextAtSame([drop], drop), null);
  });
});

describe("the account's from-to line (#574)", () => {
  it("names both days once the choice differs from the booking", () => {
    assert.equal(moveText(drop, drop21), "Moves your pickup from " +
      "Saturday, November 14 to Saturday, November 21.");
  });

  it("names both places on one day", () => {
    assert.equal(moveText(drop21, popup), "Moves your pickup on Saturday, " +
      "November 21 from North Scituate · Drop site to Pawtucket · " +
      "Thanksgiving Prep.");
  });

  it("says nothing while the booking stands, or nothing is chosen", () => {
    assert.equal(moveText(drop, drop), "");
    assert.equal(moveText(drop, null), "");
    assert.equal(moveText(null, drop), "");
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
