// Criteria tests for #816, phase 2 of the split of order-form.js
// (docs/refactors/order-form.md, "Phase 2: phone and contact row"),
// held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/phone-mask.criteria.mjs test/phone-mask.test.mjs
//
// All five criteria are of the new-module kind: they fail on `next`,
// where form/phone.mjs does not exist, and pass once the phase draws
// the mask out of formatPhone. Nothing retires.
//
// Contract: the design names it, `maskPhone(raw, deleting)` in
// assets/scripts/order/form/phone.mjs. `raw` is the field's value as
// typed, `deleting` that the input was a deletion; it returns the
// value the field shows. The numbers are made up (555), never the
// farm's.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { maskPhone } from "../assets/scripts/order/form/phone.mjs";

const MODULE = new URL(
  "../assets/scripts/order/form/phone.mjs", import.meta.url
);

// Box 1 of #816.
describe("maskPhone, the shape", () => {
  it("reads up to three digits as (401, four to six as (401) 555, seven to "
    + "ten as (401) 555-1234, and no digits as an empty string", () => {
    const cases = [
      ["", ""],
      ["4", "(4"],
      ["40", "(40"],
      ["401", "(401"],
      ["4015", "(401) 5"],
      ["40155", "(401) 55"],
      ["401555", "(401) 555"],
      ["4015551", "(401) 555-1"],
      ["401555123", "(401) 555-123"],
      ["4015551234", "(401) 555-1234"],
    ];

    for (const [raw, shown] of cases) {
      assert.equal(maskPhone(raw, false), shown, JSON.stringify(raw));
    }
  });
});

// Box 2 of #816.
describe("maskPhone, a leading 1", () => {
  it("drops the 1 from eleven digits that begin with it", () => {
    assert.equal(maskPhone("14015551234", false), "(401) 555-1234");
    assert.equal(maskPhone("+1 (401) 555-1234", false), "(401) 555-1234");
    assert.equal(maskPhone("1-401-555-1234", false), "(401) 555-1234");
    // A 1 that leads fewer digits is a digit like any other.
    assert.equal(maskPhone("1401", false), "(140) 1");
  });
});

// Box 3 of #816.
describe("maskPhone, past ten", () => {
  it("drops digits past the tenth", () => {
    assert.equal(maskPhone("40155512349", false), "(401) 555-1234");
    assert.equal(maskPhone("401555123499", false), "(401) 555-1234");
    assert.equal(maskPhone("(401) 555-12345678", false), "(401) 555-1234");
  });
});

// Box 4 of #816.
describe("maskPhone, not digits", () => {
  it("ignores every character that is not a digit", () => {
    assert.equal(maskPhone("401.555.1234", false), "(401) 555-1234");
    assert.equal(maskPhone("tel: 401 555 1234 ", false), "(401) 555-1234");
    assert.equal(maskPhone("(401) 555-1234", false), "(401) 555-1234");
    assert.equal(maskPhone("abc", false), "");
    assert.equal(maskPhone("() -", false), "");
  });
});

// Box 5 of #816.
describe("maskPhone, deleting", () => {
  it("while deleting, makes a value that ends on a bracket, space or dash "
    + "lose the digit before it", () => {
    // Backspace over the dash's own digit boundary.
    assert.equal(maskPhone("(401) 555-", true), "(401) 55");
    assert.equal(maskPhone("(401) ", true), "(40");
    assert.equal(maskPhone("(401)", true), "(40");
    assert.equal(maskPhone("(", true), "");

    // Ending on a digit, a deletion loses nothing more.
    assert.equal(maskPhone("(401) 55", true), "(401) 55");
    assert.equal(maskPhone("(401", true), "(401");

    // Not deleting, the same values keep their digits.
    assert.equal(maskPhone("(401) 555-", false), "(401) 555");
    assert.equal(maskPhone("(401) ", false), "(401");
  });
});

describe("design, phase 2", () => {
  it("keeps form/phone.mjs pure", () => {
    const code = readFileSync(MODULE, "utf8")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    assert.doesNotMatch(code,
      /\b(document|window|querySelector|addEventListener|Element)\b/);
    for (const [, from] of code.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      assert.match(from, /\.mjs$/, `phone.mjs imports ${from}`);
    }
  });
});
