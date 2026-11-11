import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  moreShown, restOf, toPx,
} from "../assets/scripts/order/cart/view.mjs";

// The arrows show wherever any of the list lies past an edge, a line
// half under the fade included, and never carry a count (#560).
describe("moreShown", () => {
  it("shows only the down arrow at the top of a long list", () => {
    assert.deepEqual(
      moreShown({ top: 0, height: 200, full: 500 }),
      { up: false, down: true }
    );
  });

  it("shows both in the middle", () => {
    assert.deepEqual(
      moreShown({ top: 120, height: 200, full: 500 }),
      { up: true, down: true }
    );
  });

  it("shows only the up arrow at the end", () => {
    assert.deepEqual(
      moreShown({ top: 300, height: 200, full: 500 }),
      { up: true, down: false }
    );
  });

  it("shows the down arrow for a line only partly hidden", () => {
    assert.equal(moreShown({ top: 0, height: 200, full: 210 }).down, true);
  });

  it("shows neither when the list fits, a pixel of rounding allowed",
    () => {
      assert.deepEqual(
        moreShown({ top: 0, height: 200, full: 200.5 }),
        { up: false, down: false }
      );
    });
});

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
