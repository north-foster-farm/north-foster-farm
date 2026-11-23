// Criteria tests for #851, phase 1 of the split of cart/cart.js
// (docs/refactors/cart.md, "Phase 1: the small decisions"), held out
// of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/cart-decisions.criteria.mjs test/cart-decisions.test.mjs
//
// All six criteria are of the new-module kind: they fail on `next`,
// where why.mjs and joke.mjs do not exist, and pass once the phase
// draws them out. Nothing retires.
//
// Contract (the design names the functions and their modules, not
// their arguments; these are the test agent's choice, plain data so
// that both modules stay pure; the call shape may be adapted, the
// expected values may not). The words are today's, byte for byte.
//
//   whyOf(summary, { method, locked, down })      cart/why.mjs
//     summary  summary.mjs's: `count`, `eligible`, `minimumTip`
//     method   the way the page holds
//     locked   the stock gate is shut
//     down     stock could not be checked
//     ->       { reason, text }, reason "empty", "locked" or
//              "minimum", or null when Proceed may go on
//
//   jokeAmount(ms)                                cart/joke.mjs
//     ms  the time since the joke began
//     ->  the discount in whole cents
//
//   jokeLabel()                                   cart/joke.mjs
//     ->  the joke row's label, as the cart shows it
//
// The test of purity comes from the design's module table (section
// 2: both modules are listed as pure), not from a box.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  JOKE_CODE, JOKE_PER_MINUTE, jokeAmount, jokeLabel,
} from "../assets/scripts/order/cart/joke.mjs";
import { whyOf } from "../assets/scripts/order/cart/why.mjs";

const CART = new URL("../assets/scripts/order/cart/", import.meta.url);

const EMPTY = "Your cart is empty. Add something to check out.";
const CHECKING = "We're still checking what's in stock. Please try "
  + "again in a moment.";
const UNAVAILABLE = "Ordering isn't available right now. We can't check "
  + "what's in stock, so we're not taking orders yet.";
const TIP = "Add a little more to reach the delivery minimum.";

const cart = (more = {}) => ({
  count: 3, eligible: true, minimumTip: "", ...more,
});
const short = cart({ eligible: false, minimumTip: TIP });
const facts = (more = {}) => ({
  method: "onfarm", locked: false, down: false, ...more,
});

// Box 1 of #851.
describe("whyOf, empty", () => {
  it("is the empty reason for an empty cart", () => {
    assert.deepEqual(whyOf(cart({ count: 0 }), facts()),
      { reason: "empty", text: EMPTY });
  });
});

// Box 2 of #851.
describe("whyOf, locked", () => {
  it("is the locked reason for a cart with items while stock is unknown, "
    + "in the checking words, or the unavailable words when stock could "
    + "not be checked", () => {
    assert.deepEqual(whyOf(cart(), facts({ locked: true })),
      { reason: "locked", text: CHECKING });
    assert.deepEqual(whyOf(cart(), facts({ locked: true, down: true })),
      { reason: "locked", text: UNAVAILABLE });
  });
});

// Box 3 of #851.
describe("whyOf, minimum", () => {
  it("is the minimum reason for a delivery under the minimum, with the "
    + "summary's own tip", () => {
    assert.deepEqual(whyOf(short, facts({ method: "delivery" })),
      { reason: "minimum", text: TIP });

    const other = "Another tip, the summary's own.";

    assert.deepEqual(
      whyOf({ ...short, minimumTip: other }, facts({ method: "delivery" })),
      { reason: "minimum", text: other }
    );
  });
});

// Box 4 of #851.
describe("whyOf, otherwise and the order", () => {
  it("is null otherwise; empty comes before locked, and locked before the "
    + "minimum", () => {
    // Nothing stands in the way.
    assert.equal(whyOf(cart(), facts()), null);
    assert.equal(whyOf(cart(), facts({ method: "delivery" })), null);
    // Under the minimum, but not a delivery: no minimum applies.
    for (const method of ["onfarm", "scheduled"]) {
      assert.equal(whyOf(short, facts({ method })), null, method);
    }

    // Empty before locked.
    assert.equal(
      whyOf(cart({ count: 0 }), facts({ locked: true, down: true })).reason,
      "empty"
    );
    // Locked before the minimum.
    assert.equal(
      whyOf(short, facts({ method: "delivery", locked: true })).reason,
      "locked"
    );
    // Empty before both.
    assert.equal(
      whyOf(
        { ...short, count: 0 }, facts({ method: "delivery", locked: true })
      ).reason,
      "empty"
    );
  });
});

// Box 5 of #851.
describe("jokeAmount", () => {
  it("is the whole cents earned at the joke's rate for the time passed, "
    + "and 0 at the start", () => {
    // The rate is today's: $40 a minute.
    assert.equal(JOKE_PER_MINUTE, 4000);

    assert.equal(jokeAmount(0), 0);
    assert.equal(jokeAmount(60_000), 4000);
    assert.equal(jokeAmount(90_000), 6000);
    assert.equal(jokeAmount(15), 1);
    // Whole cents, never rounded up: 66.67 earned is 66.
    assert.equal(jokeAmount(1000), 66);
    assert.equal(jokeAmount(14), 0);
    assert.ok(Number.isInteger(jokeAmount(12_345)));
  });
});

// Box 6 of #851.
describe("jokeLabel", () => {
  it("names the code and its rate a minute", () => {
    assert.equal(JOKE_CODE, "EGGBOI");
    assert.equal(jokeLabel(), "Discount (EGGBOI, $40/min)");
  });
});

describe("design, section 2", () => {
  it("keeps cart/why.mjs and cart/joke.mjs pure", () => {
    const dom = new RegExp(`\\b(${[
      "document", "window", "getComputedStyle", "matchMedia",
      "requestAnimationFrame", "setInterval", "setTimeout", "Date",
      "performance", "Element", "Node",
    ].join("|")})\\b`);

    for (const name of ["why.mjs", "joke.mjs"]) {
      const code = readFileSync(new URL(name, CART), "utf8")
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");

      assert.doesNotMatch(code, dom, `${name} reaches the DOM or a clock`);
      for (const [, from] of code.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        assert.match(from, /\.mjs$/, `${name} imports ${from}`);
      }
    }
  });
});
