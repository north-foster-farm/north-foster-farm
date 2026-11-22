// Criteria tests for #846, phase 4 of the split of cart/view.mjs
// (docs/refactors/cart-view.md, "Phase 4: the sheet's motion"), held
// out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/cart-view-motion.criteria.mjs \
//     test/cart-view-motion.test.mjs
//
// All five criteria are of the new-module kind: they fail on `next`,
// where none of the functions exists, and pass once the phase draws
// them out of moveParts. Nothing retires: cart-view.test.mjs keeps
// importing view.mjs, and no expectation of its changes. The box on
// moveParts' order of reads and writes is not a (test) box; only the
// cart-motion spec, in Actions, covers it.
//
// Contract (the design names the functions and their module,
// view/plan.mjs, not their arguments; these are the test agent's
// choice, plain data so that the module stays pure; the call shape
// may be adapted, the expected values may not). A size is sizeOf's
// shape, { shown, size }; a pill is pillOf's, { shown, transform,
// right }.
//
//   movePlan(parts)
//     parts  [{ el, connected, was, now, heldWas, heldNow }]: each
//            part with whether it is still in the page, its size
//            before and after, and its inner scroller's height
//            before and after (0 for none)
//     ->     the parts that move, in order, each carrying its own
//            `el` and `heldAt`, the height its scroller is held at
//            (other keys allowed)
//
//   pillMoves(was, now)            -> whether Clear cart moves
//   lifting({ floatingWas, floating })
//                                  -> whether the pane lifts off
//   holds({ kb, top, left, height, full })
//     kb      the keyboard's inset (--cart-kb), in px
//     top     the body's scrollTop now
//     left    the scrollTop the hold last left it at
//     height  the body's clientHeight
//     full    the body's scrollHeight
//     ->      whether the body is still held at its end
//
// The test of purity comes from the design's module table (section
// 2: plan.mjs is listed as pure), not from a box.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  holds, lifting, movePlan, pillMoves,
} from "../assets/scripts/order/cart/view/plan.mjs";
import { assertPure } from "./pure-module.mjs";

const PLAN = new URL(
  "../assets/scripts/order/cart/view/plan.mjs", import.meta.url
);
const shown = (size) => ({ shown: true, size });
const gone = { shown: false, size: 0 };
const part = (el, was, now, more = {}) => ({
  el, connected: true, was, now, heldWas: 0, heldNow: 0, ...more,
});

// Box 1 of #846.
describe("movePlan", () => {
  it("keeps the parts that are still in the page and whose size changes "
    + "by half a pixel or more, and drops the rest", () => {
    const plan = movePlan([
      part("grows", shown(40), shown(80)),
      part("still", shown(40), shown(40)),
      part("comes", gone, shown(60)),
      part("rounding", shown(40), shown(40.4)),
      part("goes", shown(60), gone),
      part("half", shown(40), shown(40.5)),
      part("removed", shown(40), shown(80), { connected: false }),
      part("absent", gone, gone),
      part("shrinks", shown(80), shown(79.5)),
    ]);

    assert.deepEqual(
      plan.map((p) => p.el), ["grows", "comes", "goes", "half", "shrinks"]
    );
    assert.deepEqual(movePlan([part("still", shown(40), shown(40))]), []);
  });
});

// Box 2 of #846.
describe("movePlan's held scroller", () => {
  it("holds each kept part's inner scroller at the larger of its two "
    + "heights", () => {
    const plan = movePlan([
      part("opens", shown(40), shown(300), { heldWas: 120, heldNow: 260 }),
      part("closes", shown(300), shown(40), { heldWas: 260, heldNow: 90 }),
      part("goes", shown(300), gone, { heldWas: 260, heldNow: 0 }),
      part("none", shown(40), shown(80)),
      part("still", shown(40), shown(40), { heldWas: 100, heldNow: 200 }),
    ]);

    assert.deepEqual(
      plan.map(({ el, heldAt }) => [el, heldAt]),
      [["opens", 260], ["closes", 260], ["goes", 260], ["none", 0]]
    );
  });
});

// Box 3 of #846.
describe("pillMoves", () => {
  it("is true when Clear cart comes or goes, and when it stays but its "
    + "place changes", () => {
    const at = (transform, right) => ({
      shown: true, display: "flex", transform, right,
    });
    const away = { shown: false };
    const here = at("none", "16px");

    assert.equal(pillMoves(away, here), true, "comes");
    assert.equal(pillMoves(here, away), true, "goes");
    assert.equal(
      pillMoves(here, at("matrix(1, 0, 0, 1, 0, -24)", "16px")), true,
      "moves by its transform"
    );
    assert.equal(pillMoves(here, at("none", "48px")), true, "moves across");
    assert.equal(pillMoves(here, at("none", "16px")), false, "stays put");
    assert.equal(pillMoves(away, away), false, "never shown");
  });
});

// Box 4 of #846.
describe("lifting", () => {
  it("is true only for a pane that floats after the change and did not "
    + "before", () => {
    assert.equal(lifting({ floatingWas: false, floating: true }), true);
    assert.equal(lifting({ floatingWas: true, floating: true }), false);
    assert.equal(lifting({ floatingWas: true, floating: false }), false);
    assert.equal(lifting({ floatingWas: false, floating: false }), false);
  });
});

// Box 5 of #846.
describe("holds", () => {
  it("is false under the keyboard, false once the body has been scrolled "
    + "from where the hold left it and is not at its end, and true "
    + "otherwise", () => {
    // A body of 600 px seen through 200: its end is a scrollTop of 400.
    const body = { kb: 0, height: 200, full: 600 };

    assert.equal(holds({ ...body, top: 400, left: 400 }), true, "held");
    assert.equal(holds({ ...body, top: 150, left: 150 }), true, "unscrolled");
    assert.equal(
      holds({ ...body, kb: 300, top: 400, left: 400 }), false,
      "under the keyboard"
    );
    assert.equal(
      holds({ ...body, kb: 300, top: 150, left: 150 }), false,
      "under the keyboard, unscrolled"
    );
    assert.equal(
      holds({ ...body, top: 0, left: 400 }), false, "scrolled to the top"
    );
    assert.equal(
      holds({ ...body, top: 250, left: 100 }), false, "scrolled, not to its end"
    );
    assert.equal(
      holds({ ...body, top: 400, left: 100 }), true, "scrolled to its end"
    );
  });
});

describe("design, section 2", () => {
  it("keeps view/plan.mjs pure", () => {
    const banned = [
      "document", "window", "getComputedStyle", "matchMedia",
      "requestAnimationFrame", "cancelAnimationFrame", "performance",
      "ResizeObserver", "Element", "Node",
    ];

    assertPure(PLAN, { banned, door: /\/view\.mjs$/ });
  });
});
