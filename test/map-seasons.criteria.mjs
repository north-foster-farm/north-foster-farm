// Criteria tests for #861, phase 3 of the split of map/map.js
// (docs/refactors/map.md, "Phase 3: seasons, numbers and the order"),
// held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/map-seasons.criteria.mjs test/map-seasons.test.mjs
//
// All six criteria are of the new-module kind: they fail on `next`,
// where map/seasons.mjs does not exist, and pass once the phase draws
// today, expire's test, number's and arrange's order, and the hash's
// reading out. Nothing retires.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice, plain data so
// that the module stays pure; the call shape may be adapted, the
// expected values may not):
//
//   dayOf(date)            -> "YYYY-MM-DD" on the visitor's clock
//   gone(until, today)     until: an element's data-until, or nothing
//   numbersOf(rows)        rows: [{ key, hidden }], in the list's order
//                          -> key -> its number (a Map or an object)
//   arranged(items, events)
//     items   the list's places, as built: [{ location }], the farm's
//             with no location
//     events  /api/events' events: [{ location }], in date order
//     ->      the items, sorted
//   hashTarget(hash, hasLayers)
//     hash  location.hash, decoded; hasLayers  the map has its tabs
//     ->    { slug } (null slug for plain Places), or nothing

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  arranged, dayOf, gone, hashTarget, numbersOf,
} from "../assets/scripts/map/seasons.mjs";
import { assertPure } from "./pure-module.mjs";

const nothing = (x) => [null, undefined, false].includes(x);
const entries = (numbers) => (numbers instanceof Map
  ? Object.fromEntries(numbers) : numbers);

// Box 1 of #861.
describe("dayOf", () => {
  it("is the date on the visitor's clock as YYYY-MM-DD", () => {
    assert.equal(dayOf(new Date(2026, 11, 5, 23, 30)), "2026-12-05");
    assert.equal(dayOf(new Date(2026, 0, 9, 0, 5)), "2026-01-09");
  });
});

// Box 2 of #861.
describe("gone", () => {
  it("is true for a day before today, false for today, and false with no "
    + "day", () => {
    assert.equal(gone("2026-12-04", "2026-12-05"), true);
    assert.equal(gone("2026-12-05", "2026-12-05"), false);
    assert.equal(gone("2026-12-06", "2026-12-05"), false);
    for (const none of [undefined, ""]) {
      assert.ok(!gone(none, "2026-12-05"), JSON.stringify(none));
    }
  });
});

// Box 3 of #861.
describe("numbersOf", () => {
  it("numbers the showing rows from 1 in the list's order, leaving no gap "
    + "for one that is hidden", () => {
    const rows = [{ key: "farm", hidden: false }, { key: "drop", hidden: true },
      { key: "market", hidden: false }, { key: "fair", hidden: false }];
    const numbers = entries(numbersOf(rows));

    assert.deepEqual(numbers, { farm: 1, market: 2, fair: 3 });
    assert.ok(!("drop" in numbers));
  });
});

// Box 4 of #861.
describe("arranged", () => {
  it("puts the farm first, then the locations in the order /api/events "
    + "names them, then the rest as built", () => {
    const items = [{ location: "A" }, { location: "B" }, {},
      { location: "C" }, { location: "D" }];
    const events = [{ location: "C" }, { location: "A" }, { location: "C" }];

    assert.deepEqual(arranged(items, events).map((i) => i.location || "farm"),
      ["farm", "C", "A", "B", "D"]);
  });
});

// Box 5 of #861.
describe("arranged, a tie", () => {
  it("keeps the built order of two locations the events do not tell "
    + "apart", () => {
    const items = [{ location: "B" }, { location: "A" }, { location: "C" }];

    assert.deepEqual(arranged(items, []).map((i) => i.location),
      ["B", "A", "C"]);
    assert.deepEqual(arranged(items, [{ location: "C" }])
      .map((i) => i.location), ["C", "B", "A"]);
  });
});

// Box 6 of #861.
describe("hashTarget", () => {
  it("opens Places for #places and #places-scheduled, a place's card for "
    + "#place- and its slug, and nothing for any other hash or on a map "
    + "with no layers", () => {
    assert.deepEqual(hashTarget("places", true), { slug: null });
    assert.deepEqual(hashTarget("places-scheduled", true), { slug: null });
    assert.deepEqual(hashTarget("place-foster-market", true),
      { slug: "place-foster-market" });
    for (const hash of ["", "delivery", "check-zip", "plac"]) {
      assert.ok(nothing(hashTarget(hash, true)), hash);
    }
    assert.ok(nothing(hashTarget("places", false)), "no layers");
    assert.ok(nothing(hashTarget("place-foster-market", false)));
  });
});

describe("design, section 2", () => {
  it("keeps map/seasons.mjs pure", () => {
    assertPure(new URL("../assets/scripts/map/seasons.mjs", import.meta.url),
      { banned: ["document", "(?<![.\\w])window\\.", "location\\.",
        "querySelector", "Element", "fetch"] });
  });
});
