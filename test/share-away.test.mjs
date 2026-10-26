// When a tap or a focus folds the cart's shared row (#383).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { awayFrom } from "../assets/scripts/order/lib/share-away.mjs";

// A node tree reduced to what awayFrom asks: who contains whom.
const node = (...inside) => {
  const self = {
    kids: inside,
    contains: (other) => other === self || self.kids.some(
      (kid) => kid.contains(other),
    ),
  };

  return self;
};

const pick = node();
const share = Object.assign(node(pick), { dataset: { share: "way" } });
const cart = node(share);
const page = node(cart, node());
const outside = page.kids[1];

describe("awayFrom", () => {
  it("keeps the row for a tap or a focus inside it", () => {
    assert.equal(awayFrom(share, pick), false);
    assert.equal(awayFrom(share, pick, true), false);
  });

  it("folds the row for a tap or a focus outside the cart", () => {
    assert.equal(awayFrom(share, outside), true);
    assert.equal(awayFrom(share, outside, true), true);
  });

  it("folds the row for a tap on the cart around it", () => {
    assert.equal(awayFrom(share, cart), true);
  });

  it("keeps the row when Safari focuses the cart for a tap in it", () => {
    assert.equal(awayFrom(share, cart, true), false);
    assert.equal(awayFrom(share, page, true), false);
  });

  it("has nothing to fold when the row is shut", () => {
    const shut = Object.assign(node(), { dataset: { share: "" } });

    assert.equal(awayFrom(shut, outside), false);
  });
});
