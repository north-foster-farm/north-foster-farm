// Criteria tests for #863, phase 5 of the split of map/map.js
// (docs/refactors/map.md, "Phase 5: gestures"), held out of `npm test`
// until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/map-gesture.criteria.mjs test/map-gesture.test.mjs
//
// Both criteria are of the new-module kind: they fail on `next`, where
// map/gesture.mjs does not exist, and pass once the phase draws the
// pointers' sums out. Nothing retires.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice; the call shape
// may be adapted, the expected values may not):
//
//   spread(a, b), middle(a, b)   a, b: two pointers' { x, y }, in px
//   isDrag(from, to)             the press's point and the pointer's

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isDrag, middle, spread } from "../assets/scripts/map/gesture.mjs";
import { assertPure } from "./pure-module.mjs";

// Box 1 of #863.
describe("spread and middle", () => {
  it("give the distance between two pointers, and the point halfway",
    () => {
      assert.equal(spread({ x: 0, y: 0 }, { x: 30, y: 40 }), 50);
      assert.equal(spread({ x: 10, y: 10 }, { x: 10, y: 10 }), 0);
      assert.equal(spread({ x: 30, y: 40 }, { x: 0, y: 0 }), 50, "either way");
      assert.deepEqual(middle({ x: 0, y: 0 }, { x: 30, y: 40 }),
        { x: 15, y: 20 });
      assert.deepEqual(middle({ x: -10, y: 5 }, { x: 10, y: 15 }),
        { x: 0, y: 10 });
    });
});

// Box 2 of #863.
describe("isDrag", () => {
  it("is false under 6 px of movement and true from there", () => {
    const from = { x: 100, y: 100 };

    assert.equal(isDrag(from, { x: 100, y: 100 }), false);
    assert.equal(isDrag(from, { x: 105, y: 100 }), false);
    assert.equal(isDrag(from, { x: 103, y: 104 }), false, "5 px");
    assert.equal(isDrag(from, { x: 106, y: 100 }), true, "6 px");
    assert.equal(isDrag(from, { x: 100, y: 94 }), true);
    assert.equal(isDrag(from, { x: 104, y: 105 }), true, "6.4 px on a slant");
  });
});

describe("design, section 2", () => {
  it("keeps map/gesture.mjs pure", () => {
    assertPure(new URL("../assets/scripts/map/gesture.mjs", import.meta.url),
      { banned: ["document", "(?<![.\\w])window\\.", "Element",
        "setPointerCapture"] });
  });
});
