// Criteria tests for #856, phase 6 of the split of cart/cart.js
// (docs/refactors/cart.md, "Phase 6: folding"), held out of `npm
// test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/cart-fold.criteria.mjs test/cart-fold.test.mjs
//
// All five criteria are of the new-module kind: they fail on `next`,
// where pillWord and escape.mjs do not exist, and pass once the phase
// draws them out. Nothing retires.
//
// Contract (the design names the functions and their modules, not
// their arguments; these are the test agent's choice, plain data so
// that both modules stay pure; the call shape may be adapted, the
// expected values may not):
//
//   pillWord(state)                              cart/plan.mjs
//     state  a state.mjs record
//     ->     the pill's word, or nothing (null, undefined or "")
//
//   escapeStep({ tipOpen, clearAsking, share, state })
//                                                cart/escape.mjs
//     tipOpen      a badge tooltip or Proceed's is open
//     clearAsking  Clear cart is asking for its second press
//     share        state.mjs's `share`: "", "way" or "code"
//     state        the state.mjs record
//     ->           which part acts: "tips", "clear", "row", "fold",
//                  or null when Escape is not the cart's
//
// The test of purity comes from the design's module table (section
// 2: both modules are listed as pure), not from a box.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { escapeStep } from "../assets/scripts/order/cart/escape.mjs";
import { pillWord } from "../assets/scripts/order/cart/plan.mjs";
import * as state from "../assets/scripts/order/cart/state.mjs";

const CART = new URL("../assets/scripts/order/cart/", import.meta.url);
const nothing = (word) => [null, undefined, ""].includes(word);

const pane = (more = {}) => ({ ...state.initial(), empty: false, ...more });
const open = pane({ placement: "floating", fold: "open" });
const closed = pane({ placement: "floating", fold: "closed" });
const settled = pane({ placement: "inline", fold: "open" });
const column = pane({ placement: "column", fold: "open" });
const quiet = { tipOpen: false, clearAsking: false, share: "" };

// Box 1 of #856.
describe("pillWord", () => {
  it("is \"Hide\" for an open floating pane and \"Expand\" for a closed "
    + "one, and nothing for a pane that does not float", () => {
    assert.equal(pillWord(open), "Hide");
    assert.equal(pillWord(closed), "Expand");
    for (const s of [settled, column, pane({ placement: "inline" })]) {
      assert.ok(nothing(pillWord(s)), `${s.placement}: ${pillWord(s)}`);
    }
  });
});

// Box 2 of #856.
describe("escapeStep, tooltips", () => {
  it("is the tooltips when one is open", () => {
    for (const s of [open, closed, settled]) {
      assert.equal(escapeStep({ ...quiet, tipOpen: true, state: s }), "tips");
    }
    assert.equal(escapeStep({
      tipOpen: true, clearAsking: true, share: "code",
      state: { ...open, share: "code" },
    }), "tips");
  });
});

// Box 3 of #856.
describe("escapeStep, Clear cart", () => {
  it("with none open is Clear cart while it is asking", () => {
    assert.equal(escapeStep({ ...quiet, clearAsking: true, state: open }),
      "clear");
    assert.equal(escapeStep({
      ...quiet, clearAsking: true, share: "way",
      state: { ...open, share: "way" },
    }), "clear");
  });
});

// Box 4 of #856.
describe("escapeStep, the shared row", () => {
  it("then is the shared row while a side is open", () => {
    for (const share of ["way", "code"]) {
      assert.equal(escapeStep({
        ...quiet, share, state: { ...open, share },
      }), "row", share);
      assert.equal(escapeStep({
        ...quiet, share, state: { ...settled, share },
      }), "row", `${share}, settled`);
    }
  });
});

// Box 5 of #856.
describe("escapeStep, the fold", () => {
  it("then is the fold, when state.escape handles the key, and nothing "
    + "otherwise", () => {
    assert.equal(state.escape(open).handled, true);
    assert.equal(escapeStep({ ...quiet, state: open }), "fold");

    for (const s of [closed, settled, column]) {
      assert.equal(state.escape(s).handled, false);
      assert.ok(nothing(escapeStep({ ...quiet, state: s })), s.placement);
    }
  });
});

describe("design, section 2", () => {
  it("keeps cart/escape.mjs and cart/plan.mjs pure", () => {
    const dom = new RegExp(`\\b(${[
      "document", "window", "getComputedStyle", "matchMedia",
      "requestAnimationFrame", "performance", "Element", "Node",
    ].join("|")})\\b`);

    for (const name of ["escape.mjs", "plan.mjs"]) {
      const code = readFileSync(new URL(name, CART), "utf8")
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");

      assert.doesNotMatch(code, dom, `${name} reaches the DOM`);
      for (const [, from] of code.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        assert.match(from, /\.mjs$/, `${name} imports ${from}`);
      }
    }
  });
});
