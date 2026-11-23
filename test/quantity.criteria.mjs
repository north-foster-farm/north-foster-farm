// Criteria tests for #822, phase 8 of the split of order-form.js
// (docs/refactors/order-form.md, "Phase 8: quantities"), held out of
// `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/quantity.criteria.mjs test/quantity.test.mjs
//
// All four criteria are of the new-module kind: they fail on `next`,
// where form/quantity.mjs does not exist, and pass once the phase
// draws the arithmetic out. Nothing retires.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice; the call shape
// may be adapted, the expected values may not):
//
//   parseQty(text)                 -> 0 to 99
//   stepTo({ was, step, held })    -> the new quantity; held is the
//                                     quantity a paid order holds for
//                                     a row it can only lower, or null
//   qtyState({ qty, typing })      -> "active" or "empty"; typing is
//                                     that the box is being typed in
//   minusLabel(qty)                -> the minus button's name

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  minusLabel, parseQty, qtyState, stepTo,
} from "../assets/scripts/order/form/quantity.mjs";

const MODULE = new URL(
  "../assets/scripts/order/form/quantity.mjs", import.meta.url
);

// Box 1 of #822.
describe("parseQty", () => {
  it("reads the digits of what was typed, between 0 and 99, and 0 for "
    + "none", () => {
    assert.equal(parseQty("3"), 3);
    assert.equal(parseQty("07"), 7);
    assert.equal(parseQty(" 12 "), 12);
    assert.equal(parseQty("1a2"), 12);
    assert.equal(parseQty("-5"), 5);
    assert.equal(parseQty("99"), 99);
    assert.equal(parseQty("100"), 99);
    assert.equal(parseQty("1,000"), 99);
    assert.equal(parseQty("0"), 0);
    assert.equal(parseQty(""), 0);
    assert.equal(parseQty("abc"), 0);
  });
});

// Box 2 of #822.
describe("stepTo", () => {
  it("adds the step and holds the result between 0 and the row's maximum, "
    + "which is 99 unless the row is held", () => {
    assert.equal(stepTo({ was: 0, step: 1, held: null }), 1);
    assert.equal(stepTo({ was: 4, step: -1, held: null }), 3);
    assert.equal(stepTo({ was: 0, step: -1, held: null }), 0);
    assert.equal(stepTo({ was: 98, step: 1, held: null }), 99);
    assert.equal(stepTo({ was: 99, step: 1, held: null }), 99);

    // Held at 2: it can fall, never rise past 2.
    assert.equal(stepTo({ was: 2, step: 1, held: 2 }), 2);
    assert.equal(stepTo({ was: 1, step: 1, held: 2 }), 2);
    assert.equal(stepTo({ was: 2, step: -1, held: 2 }), 1);
  });
});

// Box 3 of #822.
describe("qtyState", () => {
  it("is active above 0 or while the box is being typed in, and empty "
    + "otherwise", () => {
    assert.equal(qtyState({ qty: 1, typing: false }), "active");
    assert.equal(qtyState({ qty: 40, typing: false }), "active");
    assert.equal(qtyState({ qty: 0, typing: true }), "active");
    assert.equal(qtyState({ qty: 3, typing: true }), "active");
    assert.equal(qtyState({ qty: 0, typing: false }), "empty");
  });
});

// Box 4 of #822.
describe("minusLabel", () => {
  it("is \"Remove\" at 1 and \"One fewer\" otherwise", () => {
    assert.equal(minusLabel(1), "Remove");
    for (const qty of [0, 2, 3, 99]) {
      assert.equal(minusLabel(qty), "One fewer", String(qty));
    }
  });
});

describe("design, phase 8", () => {
  it("keeps form/quantity.mjs pure", () => {
    const code = readFileSync(MODULE, "utf8")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    assert.doesNotMatch(code,
      /(?<![.\w])(document|window)\.|\b(querySelector|Element)\b/);
  });
});
