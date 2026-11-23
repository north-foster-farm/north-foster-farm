// Criteria tests for #860, phase 2 of the split of map/map.js
// (docs/refactors/map.md, "Phase 2: tags, tips and where they stand"),
// held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/map-tags.criteria.mjs test/map-tags.test.mjs
//
// All nine criteria are of the new-module kind: they fail on `next`,
// where map/stand.mjs and map/tag.mjs do not exist, and pass once the
// phase draws the placing and the tag's facts out. Nothing retires:
// zip-check.test.mjs tests a library that does not move.
//
// Contract (the design names the functions and their modules, not
// their arguments; these are the test agent's choice, plain data so
// that both stay pure; the call shape may be adapted, the expected
// values may not). Positions are px from the frame's corner; the
// margin is today's 8 px.
//
//   standAt({ at, box, lift })                        map/stand.mjs
//     at   the point, with the frame's { width, height }
//     box  the element's { w, h }; lift  px above the point
//     ->   { left, top }
//   clearOf({ place, box, zoom })                     map/stand.mjs
//     place { left, top }; zoom  the buttons' { left, right, top,
//     bottom } in the frame
//     ->   { left, top }
//   tipAt({ pointer, box, frame })                    map/stand.mjs
//     pointer { x, y }; frame { width, height }  -> { left, top }
//   inFrame(at)                                       map/stand.mjs
//   toneOf(classes)   a town's class names            map/tag.mjs
//   tagFacts({ town, zip, tone, eggsOnly, fee, extra }) map/tag.mjs
//     -> { town, price, none, eggs, hen, link }: eggs and hen are
//        whether each is offered (not struck), link whether the link
//        to Places shows
//   zipOf(attribute)  the shape's data-zip               map/tag.mjs

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearOf, inFrame, standAt, tipAt,
} from "../assets/scripts/map/stand.mjs";
import { tagFacts, toneOf, zipOf } from "../assets/scripts/map/tag.mjs";
import { assertPure } from "./pure-module.mjs";

const FRAME = { width: 600, height: 400 };
const BOX = { w: 120, h: 50 };

// Box 1 of #860.
describe("standAt", () => {
  it("centers an element over a point, above it by the lift where there is "
    + "room and below it otherwise, never nearer an edge than the margin",
  () => {
    const place = (x, y) => standAt({ at: { x, y, ...FRAME }, box: BOX,
      lift: 38 });

    // Room above: centered, the lift and 6 px above, the box's height up.
    assert.deepEqual(place(300, 200), { left: 240, top: 200 - 38 - 6 - 50 });
    // No room above: below the point, by the margin.
    assert.deepEqual(place(300, 60), { left: 240, top: 68 });
    // Never nearer an edge than the margin.
    assert.equal(place(10, 200).left, 8);
    assert.equal(place(595, 200).left, 600 - 120 - 8);
    assert.equal(place(300, 395).top, 395 - 38 - 6 - 50);
    // Below a point near the top, but never past the foot's margin.
    assert.equal(standAt({ at: { x: 300, y: 60, width: 600, height: 100 },
      box: BOX, lift: 38 }).top, 100 - 50 - 8);
  });
});

const ZOOM = { left: 540, right: 590, top: 10, bottom: 90 };

// Box 2 of #860.
describe("clearOf", () => {
  it("leaves an element that does not cover the zoom buttons where it is, "
    + "moves one that does to their left where there is room, and under "
    + "them otherwise", () => {
    const at = (left, top, box = BOX) => clearOf({ place: { left, top }, box,
      zoom: ZOOM });

    assert.deepEqual(at(100, 20), { left: 100, top: 20 }, "clear of them");
    assert.deepEqual(at(500, 20), { left: 540 - 120 - 6, top: 20 },
      "to their left");
    assert.deepEqual(at(500, 20, { w: 530, h: 50 }),
      { left: 500, top: 90 + 6 }, "no room left: under them");
  });
});

// Box 3 of #860.
describe("tipAt", () => {
  it("puts the tip below and right of the pointer, and on the other side "
    + "of it where it would pass the frame's edge", () => {
    const at = (x, y) => tipAt({ pointer: { x, y }, box: BOX, frame: FRAME });

    assert.deepEqual(at(100, 100), { left: 114, top: 114 });
    assert.deepEqual(at(550, 100), { left: 550 - 14 - 120, top: 114 },
      "past the right edge");
    assert.deepEqual(at(100, 380), { left: 114, top: 380 - 14 - 50 },
      "past the foot");
    assert.deepEqual(at(550, 380), { left: 416, top: 316 }, "both");
  });
});

// Box 4 of #860.
describe("inFrame", () => {
  it("is false for a point outside the frame", () => {
    for (const [x, y] of [[-1, 100], [601, 100], [300, -1], [300, 401]]) {
      assert.equal(inFrame({ x, y, ...FRAME }), false, `${x}, ${y}`);
    }
    assert.equal(inFrame({ x: 300, y: 200, ...FRAME }), true);
    assert.equal(inFrame({ x: 0, y: 400, ...FRAME }), true, "on its edge");
  });
});

// Box 5 of #860.
describe("toneOf", () => {
  it("is ok for a town we deliver to, wait for one a little outside, and "
    + "no for the rest", () => {
    assert.equal(toneOf(["map-town", "is-ours"]), "ok");
    assert.equal(toneOf(["map-town", "is-ours", "is-eggs"]), "ok");
    assert.equal(toneOf(["map-town", "is-away"]), "wait");
    assert.equal(toneOf(["map-town"]), "no");
  });
});

const facts = (more) => tagFacts({ town: "Foster", zip: "02825",
  tone: "ok", eggsOnly: false, fee: 5, extra: 3, ...more });

// Box 6 of #860.
describe("tagFacts, the name", () => {
  it("gives the town's name, or its ZIP where it has none", () => {
    assert.equal(facts({}).town, "Foster");
    assert.equal(facts({ town: "" }).town, "02825");
    assert.equal(facts({ town: undefined }).town, "02825");
  });
});

// Box 7 of #860.
describe("tagFacts, the price", () => {
  it("adds the outside-area extra to the fee for a town a little outside, "
    + "and shows no price where we don't deliver", () => {
    assert.equal(facts({}).price, "$5");
    assert.equal(facts({ tone: "wait" }).price, "$8");
    assert.equal(facts({ tone: "no" }).price, "");
    assert.equal(facts({ tone: "no" }).none, true);
    assert.equal(facts({}).none, false);
  });
});

// Box 8 of #860.
describe("tagFacts, what is struck and the link", () => {
  it("strikes the hen where a town takes eggs only, and both where we "
    + "don't deliver, and offers the link to Places only then", () => {
    const pick = ({ eggs, hen, link }) => ({ eggs, hen, link });

    assert.deepEqual(pick(facts({})), { eggs: true, hen: true, link: false });
    assert.deepEqual(pick(facts({ eggsOnly: true })),
      { eggs: true, hen: false, link: false });
    assert.deepEqual(pick(facts({ tone: "wait", eggsOnly: true })),
      { eggs: true, hen: false, link: false });
    assert.deepEqual(pick(facts({ tone: "no" })),
      { eggs: false, hen: false, link: true });
  });
});

// Box 9 of #860.
describe("zipOf", () => {
  it("drops the leading z", () => {
    assert.equal(zipOf("z02825"), "02825");
    assert.equal(zipOf("z06234"), "06234");
  });
});

describe("design, section 2", () => {
  it("keeps map/stand.mjs and map/tag.mjs pure", () => {
    const banned = ["document", "(?<![.\\w])window\\.", "offsetWidth",
      "getBoundingClientRect", "style", "classList", "Element"];

    for (const name of ["stand.mjs", "tag.mjs"]) {
      assertPure(new URL(`../assets/scripts/map/${name}`, import.meta.url),
        { banned });
    }
  });
});
