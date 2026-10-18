import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  keyboardInset, moreStop,
} from "../assets/scripts/order/lib/cart-scroll.mjs";

// Ten rows of 40px, 100px of view in a 400px list.
const rows = Array.from({ length: 10 }, (_, i) => ({
  top: i * 40, bottom: i * 40 + 40,
}));
const view = (top) => ({ top, height: 100, full: 400 });

describe("moreStop", () => {
  it("takes the first row not fully in view to the top edge", () => {
    assert.equal(moreStop(rows, view(0), 1), 80);
    assert.equal(moreStop(rows, view(20), 1), 120);
  });

  it("stops at the end of the list", () => {
    assert.equal(moreStop(rows, view(280), 1), 300);
    assert.equal(moreStop(rows, view(300), 1), 300);
  });

  it("goes up to the earliest row within four fifths of a screen", () => {
    assert.equal(moreStop(rows, view(200), -1), 120);
    assert.equal(moreStop(rows, view(125), -1), 80);
  });

  it("stops at the top of the list", () => {
    assert.equal(moreStop(rows, view(40), -1), 0);
    assert.equal(moreStop(rows, view(0), -1), 0);
  });

  it("stays put when no row is hidden that way", () => {
    assert.equal(moreStop(rows.slice(0, 2), view(0), 1), 0);
  });
});

describe("keyboardInset", () => {
  it("is the gap under the visual viewport", () => {
    assert.equal(keyboardInset(844, { offsetTop: 0, height: 500 }), 344);
  });

  it("counts a visual viewport the page has panned", () => {
    assert.equal(keyboardInset(844, { offsetTop: 100, height: 400 }), 344);
  });

  it("is none for a toolbar's worth or no visual viewport", () => {
    assert.equal(keyboardInset(844, { offsetTop: 0, height: 790 }), 0);
    assert.equal(keyboardInset(844, null), 0);
  });
});
