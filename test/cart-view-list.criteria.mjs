// Criteria tests for #845, phase 3 of the split of cart/view.mjs
// (docs/refactors/cart-view.md, "Phase 3: the list, the cues, the
// lesson, the focus"), held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/cart-view-list.criteria.mjs test/cart-view-list.test.mjs
//
// All three criteria are of the new-module kind: they fail on `next`,
// where none of the functions exists, and pass once the phase draws
// them out. Nothing retires: the tests that import view.mjs keep
// importing it, and no expectation of theirs changes.
//
// Contract (the design names the functions and their modules, not
// their arguments; these are the test agent's choice, plain data so
// that both modules stay pure; the call shape may be adapted, the
// expected values may not):
//
//   glideSpan(px)                           view/more.mjs
//     px  how far the list glides, in px
//     ->  the glide's length in ms
//
//   glideAt({ from, to, t })                view/more.mjs
//     from, to  the scroll top at the start and at the end
//     t         the time gone, 0 to 1
//     ->        the scroll top at t
//
//   focusRoom({ floating, paneTop, barFoot, screen })   view/plan.mjs
//     floating  the pane's placement is floating
//     paneTop   the pane's top on the screen, in px
//     barFoot   the top bar's bottom edge on the screen, in px
//     screen    the screen's height (innerHeight), in px
//     ->        { floor, ceiling }: the band a focused control is
//               kept within (other keys allowed)
//
// The test of purity comes from the design's module table (section
// 2: both modules are listed as pure), not from a box.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { glideAt, glideSpan } from "../assets/scripts/order/cart/view/more.mjs";
import { focusRoom } from "../assets/scripts/order/cart/view/plan.mjs";
import { assertPure } from "./pure-module.mjs";

const VIEW = new URL("../assets/scripts/order/cart/view/", import.meta.url);
const near = (actual, expected, message) => assert.ok(
  Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`
);

// Box 1 of #845.
describe("glideSpan", () => {
  it("is 160 ms plus 0.8 ms for each pixel, and never over 420", () => {
    near(glideSpan(0), 160, "no distance");
    near(glideSpan(1), 160.8, "one pixel");
    near(glideSpan(100), 240, "100 px");
    near(glideSpan(250), 360, "250 px");
    near(glideSpan(325), 420, "325 px, at the cap");
    near(glideSpan(326), 420, "past the cap");
    near(glideSpan(5000), 420, "far past the cap");
  });
});

// Box 2 of #845.
describe("glideAt", () => {
  it("is the start at 0, the end at 1, and eases out between them on a "
    + "cubic curve", () => {
    const outCubic = (t) => 1 - (1 - t) ** 3;

    for (const [from, to] of [[0, 300], [120, 40]]) {
      near(glideAt({ from, to, t: 0 }), from, `${from} to ${to} at 0`);
      near(glideAt({ from, to, t: 1 }), to, `${from} to ${to} at 1`);
      for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        near(
          glideAt({ from, to, t }), from + (to - from) * outCubic(t),
          `${from} to ${to} at ${t}`
        );
      }
    }

    // Easing out: past the halfway mark by half the time, going
    // either way.
    assert.ok(glideAt({ from: 0, to: 300, t: 0.5 }) > 150);
    assert.ok(glideAt({ from: 120, to: 40, t: 0.5 }) < 80);
  });
});

// Box 3 of #845.
describe("focusRoom", () => {
  it("gives the pane's top as the floor while the floating pane covers "
    + "the foot, and the screen's foot otherwise, with the top bar's "
    + "foot as the ceiling", () => {
    const screen = 800;
    const barFoot = 56;

    // Floating at the foot: the pane's top is the floor.
    const riding = focusRoom({ floating: true, paneTop: 640, barFoot, screen });

    assert.equal(riding.floor, 640);
    assert.equal(riding.ceiling, barFoot);

    // Settled: the screen's foot.
    const settled = focusRoom({
      floating: false, paneTop: 640, barFoot, screen,
    });

    assert.equal(settled.floor, screen);
    assert.equal(settled.ceiling, barFoot);

    // Floating, but the page has scrolled past it: above the bar's
    // foot, it covers nothing at the foot.
    const past = focusRoom({ floating: true, paneTop: 20, barFoot, screen });

    assert.equal(past.floor, screen);
    assert.equal(past.ceiling, barFoot);

    // The ceiling follows the bar.
    assert.equal(
      focusRoom({ floating: true, paneTop: 640, barFoot: 120, screen })
        .ceiling,
      120
    );
  });
});

describe("design, section 2", () => {
  it("keeps view/more.mjs and view/plan.mjs pure", () => {
    const banned = [
      "document", "window", "getComputedStyle", "matchMedia",
      "requestAnimationFrame", "cancelAnimationFrame", "performance",
      "ResizeObserver", "Element", "Node",
    ];

    for (const name of ["more.mjs", "plan.mjs"]) {
      assertPure(new URL(name, VIEW), { banned, door: /\/view\.mjs$/ });
    }
  });
});
