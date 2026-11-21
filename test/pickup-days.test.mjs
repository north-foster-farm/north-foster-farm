// Criteria tests for #703: pickup days grouped by date, with Copy and
// Map. Written before the change from the issue's spec, James's
// mockups and his decisions of 2026-11-21; one test per criterion,
// named for it. Held out of `npm test` by its name until the change
// lands; the implementer turns it on with
//
//   git mv test/pickup-days.criteria.mjs test/pickup-days.test.mjs
//
// The browser's side (indent, address shape, line height, the buttons,
// the three homes) is e2e/pickup-days.criteria.mjs.
//
// The contract, in assets/scripts/order/lib/scheduled.mjs:
//
// - pickupDays(choices, place) groups a list of scheduled choices
//   (scheduledChoices) by date: [{ date, heading, pickups }], dates in
//   order, `heading` the entry's own label ("Saturday, November 21"),
//   `pickups` the date's entries as pickupCard gives them, in the
//   list's order. `place` takes a location code and returns the
//   location (data/locations.json) or nothing.
// - pickupCard(entry, loc) is one pickup's card:
//   { value, name, time, place, street, city, copy, map }
//   - value: the occurrence id, the radio's value;
//   - name: the subtitle, pickupName(town, name), "North Scituate ·
//     Drop site";
//   - time: the window, "10:00 – 11:00 AM";
//   - place: the location's name when it is not its street, "Shady
//     Acres Diner", else "";
//   - street: the street, and its second line after a comma when it
//     has one, "1 Rocky Point Avenue, Gate B";
//   - city: "North Scituate, RI 02857";
//   - copy: what Copy puts on the clipboard, the street address as one
//     line without the place name, "46 Institute Lane, North
//     Scituate, RI 02857";
//   - map: where Map goes, the home page's map at that location's card
//     on the Places tab, "/#place-<slug>": the location's `slug`, or
//     its name as Hugo's urlize writes it, which is how
//     layouts/partials/map.html names each pin (data-map-slug).
//   A location it does not know gives "" for place, street, city and
//   copy.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as scheduled from "../assets/scripts/order/lib/scheduled.mjs";

const LOCATIONS = JSON.parse(readFileSync(
  new URL("../data/locations.json", import.meta.url), "utf8"
)).locations;
const byCode = (code) => LOCATIONS.find((l) => l.code === code) || null;

// The contract's functions, or a failure that names the one missing.
const fn = (name) => {
  assert.equal(typeof scheduled[name], "function",
    `lib/scheduled.mjs exports ${name} (#703)`);

  return scheduled[name];
};

// Entries of /api/dates' `scheduled`, as the order page's lists hold
// them. The drop site at 46 Institute Lane (G4C6), whose name is its
// street; the Foster market at Shady Acres Diner (D8RW), whose is not.
const DROP = {
  series: "VFVQ", name: "Drop site", location: "G4C6",
  town: "North Scituate", window: "10:00 – 11:00 AM",
};
const FOSTER = {
  series: "WAC5", name: "Foster Farmers’ Market", location: "D8RW",
  town: "Foster", window: "9:00 AM – 1:00 PM",
};
const LABEL = new Intl.DateTimeFormat("en-US", {
  weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
});
const on = (place, date) => ({
  ...place,
  occurrence: `${place.series}-${date.slice(2).replaceAll("-", "")}`,
  date,
  label: LABEL.format(new Date(`${date}T12:00:00Z`)),
});
const choices = (...entries) => scheduled.scheduledChoices(entries);
const card = (entry) => fn("pickupCard")(
  scheduled.scheduledChoice(entry), byCode(entry.location)
);

describe("#703 pickup days, their parts", () => {
  it("pickups are grouped under a heading showing the day and date; " +
    "several pickups on one date sit together under that one heading",
  () => {
    // Out of order on purpose: a group's rounds join the list after.
    const list = choices(
      on(DROP, "2026-11-28"), on(DROP, "2026-11-21"),
      on(FOSTER, "2026-11-21"), on(FOSTER, "2026-11-22"),
    );
    const days = fn("pickupDays")(list, byCode);

    assert.deepEqual(days.map((d) => [d.date, d.heading]), [
      ["2026-11-21", "Saturday, November 21"],
      ["2026-11-22", "Sunday, November 22"],
      ["2026-11-28", "Saturday, November 28"],
    ], "one heading per date, the day and date, dates in order");
    assert.deepEqual(days.map((d) => d.pickups.map((p) => p.value)), [
      ["VFVQ-261121", "WAC5-261121"],
      ["WAC5-261122"],
      ["VFVQ-261128"],
    ], "every pickup under its date's heading, in the list's order");
    assert.deepEqual(days[0].pickups.map((p) => [p.name, p.time]), [
      ["North Scituate · Drop site", "10:00 – 11:00 AM"],
      ["Foster Farmers’ Market", "9:00 AM – 1:00 PM"],
    ]);
    assert.deepEqual(fn("pickupDays")([], byCode), []);
  });

  it("on narrow displays the address is street on the first line and " +
    "city, state and zip on the second", () => {
    const drop = card(on(DROP, "2026-11-21"));

    assert.equal(drop.street, "46 Institute Lane");
    assert.equal(drop.city, "North Scituate, RI 02857");

    const foster = card(on(FOSTER, "2026-11-22"));

    assert.equal(foster.street, "164 Danielson Pike");
    assert.equal(foster.city, "Foster, RI 02825");

    // A second street line stays on the street's line.
    const gate = fn("pickupCard")(scheduled.scheduledChoice(on(
      DROP, "2026-11-21"
    )), {
      code: "ZZ9Z", name: "Rocky Point Park", street: "1 Rocky Point Avenue",
      street2: "Gate B", city: "Warwick", state: "RI", zip: "02889",
    });

    assert.equal(gate.street, "1 Rocky Point Avenue, Gate B");
    assert.equal(gate.city, "Warwick, RI 02889");
  });

  it("a location with a place name shows it on the first line, above " +
    "the street", () => {
    assert.equal(card(on(FOSTER, "2026-11-22")).place, "Shady Acres Diner");
    assert.equal(card(on(DROP, "2026-11-21")).place, "",
      "a location named for its street has no place name");

    const jungle = fn("pickupCard")(scheduled.scheduledChoice(on(
      { ...FOSTER, location: "P7KX", town: "Pawtucket" }, "2026-11-21"
    )), byCode("P7KX"));

    assert.equal(jungle.place, "Inside of Jordan's Jungle");
    assert.equal(jungle.street, "545 Pawtucket Ave");
    assert.equal(jungle.city, "Pawtucket, RI 02860");
  });

  it("Copy copies the street address as one line, without the place " +
    "name", () => {
    assert.equal(card(on(DROP, "2026-11-21")).copy,
      "46 Institute Lane, North Scituate, RI 02857");
    assert.equal(card(on(FOSTER, "2026-11-22")).copy,
      "164 Danielson Pike, Foster, RI 02825");
  });

  it("Map opens the location on the Places tab of the home page's map",
    () => {
      // Named by its name, as Hugo's urlize writes it.
      assert.equal(card(on(DROP, "2026-11-21")).map,
        "/#place-46-institute-lane");
      assert.equal(card(on(FOSTER, "2026-11-22")).map,
        "/#place-shady-acres-diner");

      // Named by its own slug (#581).
      const jungle = fn("pickupCard")(scheduled.scheduledChoice(on(
        { ...FOSTER, location: "P7KX" }, "2026-11-21"
      )), byCode("P7KX"));

      assert.equal(jungle.map, "/#place-jordans-jungle");
    });
});
