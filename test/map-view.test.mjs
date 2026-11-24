// Criteria tests for #859, phase 1 of the split of map/map.js
// (docs/refactors/map.md, "Phase 1: the camera's arithmetic"), held out
// of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/map-view.criteria.mjs test/map-view.test.mjs
//
// All ten criteria are of the new-module kind: they fail on `next`,
// where map/view.mjs does not exist, and pass once the phase draws the
// camera's sums out of wire. Nothing retires: map-fit.test.mjs tests
// fit.mjs, which does not move.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice; the call shape
// may be adapted, the expected values may not). A view is the viewBox,
// { x, y, w, h }, in map units; `size` the whole map's, { W, H }; a
// box the SVG's on screen, { left, top, width, height }, in px.
//
//   clampView(view, size)
//   zoomedAbout(view, factor, point)    point in map units
//   homeView({ size, layer, pins, width })
//     layer  "places" or "delivery"; pins  the showing pins' { x, y };
//     width  the SVG's width on screen
//   atHome(view, home)
//   tweenAt(from, to, t)
//   toMap(view, box, client)   client  { x, y }, as a pointer's
//   onScreen(view, box, point) -> { x, y } from the frame's corner
//   pinScale(view, width)      -> the pins' scale (a number, or its
//                                 text as today)
//   pannedBy(view, drag, width)  drag  { dx, dy }, in px

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  atHome, clampView, homeView, onScreen, pannedBy, pinScale, toMap,
  tweenAt, zoomedAbout,
} from "../assets/scripts/map/view.mjs";
import { assertPure } from "./pure-module.mjs";

const SIZE = { W: 1000, H: 1200 };
const WHOLE = { x: 0, y: 0, w: SIZE.W, h: SIZE.H };
const PIN = 38;
const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;
const assertNear = (actual, expected, message, tolerance) => assert.ok(
  near(actual, expected, tolerance), `${message}: ${actual} != ${expected}`
);

// Box 1 of #859.
describe("clampView", () => {
  it("keeps the width between the whole map's and a fifth of it, the "
    + "height in the map's proportion, and the corner inside the map", () => {
    assert.deepEqual(clampView({ x: -50, y: -50, w: 4000, h: 10 }, SIZE),
      WHOLE);

    const tight = clampView({ x: 100, y: 100, w: 10, h: 10 }, SIZE);

    assert.equal(tight.w, 200, "a fifth");
    assert.equal(tight.h, 240, "in proportion");

    const corner = clampView({ x: 950, y: 1150, w: 500, h: 0 }, SIZE);

    assert.deepEqual(corner, { x: 500, y: 600, w: 500, h: 600 });
    assert.deepEqual(clampView({ x: 100, y: 200, w: 400, h: 0 }, SIZE),
      { x: 100, y: 200, w: 400, h: 480 });
  });
});

// Box 2 of #859.
describe("zoomedAbout", () => {
  it("scales the view by a factor and keeps the given point where it was "
    + "on screen", () => {
    const view = { x: 100, y: 200, w: 400, h: 480 };
    const box = { left: 0, top: 0, width: 800, height: 960 };
    const point = { x: 250, y: 350 };

    for (const factor of [2, 0.5, 1.25]) {
      const next = zoomedAbout(view, factor, point);
      const was = onScreen(view, box, point);
      const now = onScreen(next, box, point);

      assertNear(next.w, view.w / factor, `width at ${factor}`);
      assertNear(next.h, view.h / factor, `height at ${factor}`);
      assertNear(now.x, was.x, `x at ${factor}`);
      assertNear(now.y, was.y, `y at ${factor}`);
    }
  });
});

const places = (pins, width = 800) => homeView({
  size: SIZE, layer: "places", pins, width,
});

// Box 3 of #859.
describe("homeView, the whole map", () => {
  it("is the whole map on Delivery, or with no pin showing", () => {
    const pins = [{ x: 400, y: 500 }, { x: 600, y: 700 }];

    assert.deepEqual(homeView({ size: SIZE, layer: "delivery", pins,
      width: 800 }), WHOLE);
    assert.deepEqual(places([]), WHOLE);
  });
});

// Box 4 of #859.
describe("homeView, the pins", () => {
  it("holds every showing pin with a pin's height of room around it, "
    + "centered on them and raised by half a pin, on Places", () => {
    const pins = [{ x: 300, y: 400 }, { x: 700, y: 650 }, { x: 450, y: 800 }];
    const width = 800;
    const view = places(pins, width);
    const box = { left: 0, top: 0, width, height: width * SIZE.H / SIZE.W };
    const units = view.w / width;

    assert.ok(view.w > SIZE.W / 4 && view.w < SIZE.W, `zoom ${view.w}`);
    assertNear(view.x + view.w / 2, (300 + 700) / 2, "centered across");
    assertNear(view.y + view.h / 2, (400 + 800) / 2 - PIN / 2 * units,
      "centered and raised by half a pin");
    for (const pin of pins) {
      const at = onScreen(view, box, pin);

      // The pin stands above its point: its top is a pin higher.
      assert.ok(at.x >= PIN && at.x <= box.width - PIN, `x of ${pin.x}`);
      assert.ok(at.y - PIN >= PIN - 0.5 && at.y <= box.height - PIN + 0.5,
        `y of ${pin.y}`);
    }
  });
});

// Box 5 of #859.
describe("homeView, one pin", () => {
  it("shows one pin alone at a quarter of the map's width and no closer",
    () => {
      assertNear(places([{ x: 500, y: 600 }]).w, SIZE.W / 4, "one pin");
      assertNear(places([{ x: 500, y: 600 }, { x: 505, y: 602 }]).w,
        SIZE.W / 4, "two pins that nearly meet");
    });
});

// Box 6 of #859.
describe("atHome", () => {
  it("is true within half a unit of the home view's width and corner", () => {
    const home = { x: 100, y: 200, w: 400, h: 480 };

    assert.equal(atHome(home, home), true);
    assert.equal(atHome({ ...home, x: 100.4, y: 199.6, w: 400.4 }, home),
      true);
    for (const key of ["x", "y", "w"]) {
      assert.equal(atHome({ ...home, [key]: home[key] + 0.6 }, home), false,
        key);
    }
  });
});

// Box 7 of #859.
describe("tweenAt", () => {
  it("is the start at 0, the end at 1, and eases out between", () => {
    const from = { x: 0, y: 0, w: 1000, h: 1200 };
    const to = { x: 200, y: 300, w: 400, h: 480 };

    assert.deepEqual(tweenAt(from, to, 0), from);
    assert.deepEqual(tweenAt(from, to, 1), to);

    const half = tweenAt(from, to, 0.5);

    assert.ok(half.x > 100, `past halfway at half time: ${half.x}`);
    assertNear(half.x, 200 * (1 - 0.5 ** 3), "an ease out on a cubic");
    assertNear(half.w, 1000 - 600 * (1 - 0.5 ** 3), "every edge alike");
  });
});

// Box 8 of #859.
describe("toMap and onScreen", () => {
  it("are each other's inverse for a point in the frame", () => {
    const view = { x: 120, y: 340, w: 400, h: 480 };
    const box = { left: 30, top: 90, width: 800, height: 960 };

    for (const point of [{ x: 120, y: 340 }, { x: 333.3, y: 500 },
      { x: 520, y: 820 }]) {
      const at = onScreen(view, box, point);
      const back = toMap(view, box, { x: box.left + at.x, y: box.top + at.y });

      assertNear(back.x, point.x, "x");
      assertNear(back.y, point.y, "y");
    }
  });
});

// Box 9 of #859.
describe("pinScale", () => {
  it("keeps a pin 38 px tall at any zoom and any width", () => {
    // The pin is drawn 45 units tall.
    for (const w of [1000, 500, 200]) {
      for (const width of [320, 800, 1400]) {
        const s = Number(pinScale({ x: 0, y: 0, w, h: w * 1.2 }, width));
        const px = 45 * s * width / w;

        assertNear(px, PIN, `w ${w}, width ${width}`, 0.05);
      }
    }
  });
});

// Box 10 of #859.
describe("pannedBy", () => {
  it("moves the view against the drag, by the drag's pixels in map "
    + "units", () => {
    const view = { x: 300, y: 400, w: 400, h: 480 };

    assert.deepEqual(pannedBy(view, { dx: 80, dy: -40 }, 800),
      { x: 300 - 40, y: 400 + 20, w: 400, h: 480 });
    assert.deepEqual(pannedBy(view, { dx: 0, dy: 0 }, 800), view);
  });
});

describe("design, section 2", () => {
  it("keeps map/view.mjs pure", () => {
    assertPure(new URL("../assets/scripts/map/view.mjs", import.meta.url), {
      banned: ["document", "(?<![.\\w])window\\.", "getBoundingClientRect",
        "requestAnimationFrame", "matchMedia", "Element"],
    });
  });
});
