// Criteria tests for #817, phase 3 of the split of order-form.js
// (docs/refactors/order-form.md, "Phase 3: links into the page"),
// held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/add-query.criteria.mjs test/add-query.test.mjs
//
// All six criteria are of the new-module kind: they fail on `next`,
// where form/add-query.mjs does not exist, and pass once the phase
// draws the parsing and the notice out of addFromQuery. Nothing
// retires.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice, plain data so
// that the module stays pure; the call shape may be adapted, the
// expected values may not). The words are today's, byte for byte.
//
//   parseAdd(raw)
//     raw  ?add='s value, "SKU:qty,SKU:qty"
//     ->   [{ sku, qty }], in order, each SKU as given (the aliases
//          are the caller's)
//
//   addNotice({ added, missing, unknown })
//     added    [{ qty, name }], the lines added
//     missing  the names of the products that are not available
//     unknown  the SKUs given that the catalog does not know
//     ->       { text, tone, hidden }: tone "success" or "warning"

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  addNotice, parseAdd,
} from "../assets/scripts/order/form/add-query.mjs";

const MODULE = new URL(
  "../assets/scripts/order/form/add-query.mjs", import.meta.url
);
const CHANGED = "Some items from that order have changed. Please add "
  + "them again.";
const nothing = { added: [], missing: [], unknown: [] };

// Box 1 of #817.
describe("parseAdd", () => {
  it("gives A twice and B once for \"A:2,B\"", () => {
    assert.deepEqual(parseAdd("A:2,B"), [
      { sku: "A", qty: 2 }, { sku: "B", qty: 1 },
    ]);
  });
});

// Box 2 of #817.
describe("parseAdd, quantities", () => {
  it("reads a quantity that is missing, zero or not a number as 1, and one "
    + "over 99 as 99", () => {
    const qty = (raw) => parseAdd(raw)[0].qty;

    assert.equal(qty("A"), 1, "missing");
    assert.equal(qty("A:"), 1, "empty");
    assert.equal(qty("A:0"), 1, "zero");
    assert.equal(qty("A:two"), 1, "not a number");
    assert.equal(qty("A:99"), 99);
    assert.equal(qty("A:100"), 99, "over 99");
    assert.equal(qty("A:5000"), 99, "far over 99");
    assert.equal(qty("A:7"), 7);
  });
});

// Box 3 of #817.
describe("addNotice, added", () => {
  it("with items added says \"Added to your cart:\" and each as "
    + "`2 × Name`, in the success tone", () => {
    const one = addNotice({
      ...nothing, added: [{ qty: 2, name: "Large eggs" }],
    });

    assert.equal(one.text, "Added to your cart: 2 × Large eggs.");
    assert.equal(one.tone, "success");
    assert.equal(one.hidden, false);

    const two = addNotice({
      ...nothing,
      added: [{ qty: 2, name: "Large eggs" }, { qty: 1, name: "Wings" }],
    });

    assert.equal(two.text, "Added to your cart: 2 × Large eggs, 1 × Wings.");

    // Some added and some not: still the success tone.
    const mixed = addNotice({
      ...nothing, added: [{ qty: 1, name: "Wings" }], missing: ["Tenders"],
    });

    assert.equal(mixed.tone, "success");
    assert.match(mixed.text, /^Added to your cart: 1 × Wings\./);
  });
});

// Box 4 of #817.
describe("addNotice, not available", () => {
  it("with none added and some unavailable says \"Not available:\" and "
    + "their names, in the warning tone", () => {
    const notice = addNotice({ ...nothing, missing: ["Tenders", "Wings"] });

    assert.equal(notice.text, "Not available: Tenders, Wings.");
    assert.equal(notice.tone, "warning");
    assert.equal(notice.hidden, false);
  });
});

// Box 5 of #817.
describe("addNotice, unknown", () => {
  it("adds the sentence about items that have changed for an unknown SKU, "
    + "and names no SKU", () => {
    const alone = addNotice({ ...nothing, unknown: ["NFF-OLD-SKU-1"] });

    assert.equal(alone.text, CHANGED);
    assert.equal(alone.hidden, false);

    const after = addNotice({
      added: [{ qty: 2, name: "Large eggs" }], missing: ["Tenders"],
      unknown: ["NFF-OLD-SKU-1", "ZZZ"],
    });

    assert.equal(after.text, "Added to your cart: 2 × Large eggs. "
      + `Not available: Tenders. ${CHANGED}`);
    for (const sku of ["NFF-OLD-SKU-1", "ZZZ"]) {
      assert.ok(!after.text.includes(sku), sku);
    }
  });
});

// Box 6 of #817.
describe("addNotice, nothing to say", () => {
  it("hides the notice with nothing to say", () => {
    const notice = addNotice(nothing);

    assert.equal(notice.hidden, true);
    assert.equal(notice.text, "");
  });
});

describe("design, phase 3", () => {
  it("keeps form/add-query.mjs pure", () => {
    const code = readFileSync(MODULE, "utf8")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    assert.doesNotMatch(code,
      /\b(document|window|location|querySelector|Element)\b/);
    for (const [, from] of code.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      assert.match(from, /\.mjs$/, `add-query.mjs imports ${from}`);
    }
  });
});
