import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { restOf, toPx } from "../assets/scripts/order/cart/view.mjs";

describe("toPx", () => {
  it("reads rem against the root font size", () => {
    assert.equal(toPx("9.25rem", 16), 148);
    assert.equal(toPx(" 15rem ", 20), 300);
  });

  it("reads px and bare numbers as they are", () => {
    assert.equal(toPx("148px"), 148);
    assert.equal(toPx("12"), 12);
    assert.equal(toPx(12), 12);
  });

  it("reads nothing as 0", () => {
    assert.equal(toPx(""), 0);
    assert.equal(toPx(undefined), 0);
    assert.equal(toPx("auto"), 0);
  });
});

describe("restOf", () => {
  it("sums the margin, the toolbar's gap and the keyboard", () => {
    assert.equal(restOf({ margin: 8, gap: 0, kb: 0 }), 8);
    assert.equal(restOf({ margin: 8, gap: 44, kb: 0 }), 52);
    assert.equal(restOf({ margin: 8, gap: 0, kb: 300 }), 308);
  });

  it("defaults to a margin alone", () => {
    assert.equal(restOf({}), 8);
  });
});
