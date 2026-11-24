// Criteria tests for #844, phase 2 of the split of cart/view.mjs
// (docs/refactors/cart-view.md, "Phase 2: the watchers of the
// viewport"), held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/cart-view-viewport.criteria.mjs \
//     test/cart-view-viewport.test.mjs
//
// Both criteria are of the new-module kind: they fail on `next`,
// where neither function exists, and pass once the phase draws them
// out. Nothing retires: the tests that import view.mjs keep importing
// it, and no expectation of theirs changes.
//
// Contract (the design names the functions and their modules, not
// their arguments; these are the test agent's choice, plain data so
// that both stay pure; the call shape may be adapted, the expected
// values may not):
//
//   closedHeight({ seen, css, font })      view/plan.mjs
//     seen  the pane's height as last measured floating and closed,
//           in px; 0 (or absent) when none has been measured, as
//           after a width change
//     css   the stylesheet's --cart-closed-h, as getComputedStyle
//           gives it ("4.5rem", "72px")
//     font  the root font size in px, for rem
//     ->    the closed height in px
//
//   scrollKey({ key, field, control })     view/own-scroll.mjs
//     key      the KeyboardEvent's key
//     field    true when the target is a field that takes text
//     control  true when the target is in a button or a link
//     ->       whether the key scrolls the page
//
// The test of purity comes from the design's module table (section
// 2: both modules are listed as pure), not from a box.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertPure } from "./pure-module.mjs";

import { closedHeight } from "../assets/scripts/order/cart/view/plan.mjs";
import {
  scrollKey,
} from "../assets/scripts/order/cart/view/own-scroll.mjs";

const VIEW = new URL("../assets/scripts/order/cart/view/", import.meta.url);

// Box 1 of #844.
describe("closedHeight", () => {
  it("is the pane's height as last measured floating and closed, and "
    + "the stylesheet's --cart-closed-h in pixels until one has been "
    + "measured", () => {
    // Measured: the measurement wins, above or below the constant.
    assert.equal(closedHeight({ seen: 88, css: "4.5rem", font: 16 }), 88);
    assert.equal(closedHeight({ seen: 61.5, css: "4.5rem", font: 16 }), 61.5);

    // None measured yet: the constant, in pixels at the root font.
    assert.equal(closedHeight({ seen: 0, css: "4.5rem", font: 16 }), 72);
    assert.equal(closedHeight({ seen: 0, css: "4.5rem", font: 20 }), 90);
    assert.equal(closedHeight({ seen: 0, css: "72px", font: 16 }), 72);
    assert.equal(closedHeight({ css: "4rem", font: 16 }), 64);
  });
});

// Box 2 of #844.
describe("scrollKey", () => {
  it("is true for the arrow keys, Page Up, Page Down, Home, End and "
    + "Space, false in a field that takes text, and false for Space on "
    + "a button or a link", () => {
    const page = { field: false, control: false };
    const scrolling = [
      "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " ",
    ];

    for (const key of scrolling) {
      assert.equal(scrollKey({ ...page, key }), true, `key ${key}`);
    }
    for (const key of ["Tab", "Enter", "a", "Escape"]) {
      assert.equal(scrollKey({ ...page, key }), false, `key ${key}`);
    }

    // In a field that takes text, no key scrolls the page.
    for (const key of scrolling) {
      assert.equal(
        scrollKey({ key, field: true, control: false }), false,
        `key ${key} in a field`
      );
    }

    // Space presses a button or follows a link; the others still
    // scroll from there.
    assert.equal(scrollKey({ key: " ", field: false, control: true }), false);
    assert.equal(
      scrollKey({ key: "PageDown", field: false, control: true }), true
    );
  });
});

describe("design, section 2", () => {
  it("keeps view/plan.mjs and view/own-scroll.mjs pure", () => {
    const banned = [
      "document", "window", "getComputedStyle", "matchMedia",
      "requestAnimationFrame", "cancelAnimationFrame", "performance",
      "ResizeObserver", "Element", "Node",
    ];

    for (const name of ["plan.mjs", "own-scroll.mjs"]) {
      assertPure(new URL(name, VIEW), { banned, door: /\/view\.mjs$/ });
    }
  });
});
