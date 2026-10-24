import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  keyboardInset, moreStop, ringsCart, rowsFloor, scrollIntoPane,
  visibleArea,
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

describe("scrollIntoPane", () => {
  it("is the gap between the row's foot and the pane's", () => {
    assert.equal(scrollIntoPane({ bottom: 411 }, { bottom: 356 }), 55);
  });

  it("rounds to a whole pixel", () => {
    assert.equal(scrollIntoPane({ bottom: 400.6 }, { bottom: 356 }), 45);
  });

  it("is nothing for a row already inside", () => {
    assert.equal(scrollIntoPane({ bottom: 300 }, { bottom: 356 }), 0);
    assert.equal(scrollIntoPane({ bottom: 356 }, { bottom: 356 }), 0);
  });
});

describe("visibleArea", () => {
  it("is the visual viewport's height, with no gap, when it fills", () => {
    assert.deepEqual(
      visibleArea(844, { offsetTop: 0, height: 844 }),
      { height: 844, gap: 0 }
    );
  });

  it("reads a toolbar under the visual viewport as a gap", () => {
    assert.deepEqual(
      visibleArea(844, { offsetTop: 0, height: 780 }),
      { height: 780, gap: 64 }
    );
    assert.deepEqual(
      visibleArea(844, { offsetTop: 20, height: 760 }),
      { height: 760, gap: 64 }
    );
  });

  it("leaves a keyboard's gap to keyboardInset", () => {
    assert.deepEqual(
      visibleArea(844, { offsetTop: 0, height: 520 }),
      { height: 520, gap: 0 }
    );
  });

  it("falls back to the layout height without a visual viewport", () => {
    assert.deepEqual(visibleArea(700, null), { height: 700, gap: 0 });
  });
});

describe("rowsFloor", () => {
  const list = Array.from({ length: 6 }, (_, i) => ({
    top: i * 30, bottom: i * 30 + 26,
  }));

  it("is three rows, the padding and the pills' strip", () => {
    assert.equal(rowsFloor(list, 180, 8, 28), 94 + 28);
  });

  it("is the whole list when it holds three rows or fewer", () => {
    assert.equal(rowsFloor(list.slice(0, 3), 86, 8, 28), 86);
    assert.equal(rowsFloor(list.slice(0, 1), 26, 8, 28), 26);
  });

  it("is nothing for an empty list", () => {
    assert.equal(rowsFloor([], 0, 8, 28), 0);
  });
});

describe("ringsCart", () => {
  it("always rings the xl column, on screen or not", () => {
    assert.equal(ringsCart(true, { top: 16, bottom: 600 }, 800), true);
    assert.equal(ringsCart(true, { top: -900, bottom: -300 }, 800), true);
  });

  it("rings a cart wholly in view below xl", () => {
    assert.equal(ringsCart(false, { top: 500, bottom: 788 }, 800), true);
    assert.equal(ringsCart(false, { top: -0.5, bottom: 800.5 }, 800),
      true);
  });

  it("rings a cart that fills the screen below xl", () => {
    assert.equal(ringsCart(false, { top: -200, bottom: 1400 }, 800), true);
  });

  it("does not ring a cart off screen or half in view below xl", () => {
    assert.equal(ringsCart(false, { top: 1200, bottom: 1600 }, 800),
      false);
    assert.equal(ringsCart(false, { top: 600, bottom: 1000 }, 800), false);
    assert.equal(ringsCart(false, { top: -300, bottom: 200 }, 800), false);
  });

  it("does not ring a cart with no height", () => {
    assert.equal(ringsCart(false, { top: 0, bottom: 0 }, 800), false);
  });
});
