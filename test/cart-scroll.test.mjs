import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearBy, keyboardInset, moreStop, ringsCart, visibleArea,
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

// A 900px screen under a 48px top bar, as the keyboard walk's at 390
// (#549).
describe("clearBy", () => {
  const band = { floor: 900, ceiling: 48 };

  it("lifts a control below the screen's foot clear of it", () => {
    // The sign-in link the walk found at 950..969 of 900.
    assert.equal(clearBy({ top: 950, bottom: 969 }, band), 81);
  });

  it("lifts a control under the floating pane clear of its top", () => {
    assert.equal(clearBy({ top: 600, bottom: 640 }, { ...band, floor: 620 }),
      32);
  });

  it("never lifts a control under the top bar", () => {
    // 100px of band for a 40px control: it goes no higher than the
    // bar's foot and the gap.
    assert.equal(clearBy({ top: 100, bottom: 140 }, { floor: 150, ceiling: 0 }),
      2);
  });

  it("stops at the top bar's foot when the foot alone would lift more",
    () => {
      // A 40px band: the foot would lift it 3px, the bar's foot and gap
      // allow 1 (#549 qa).
      assert.equal(clearBy({ top: 13, bottom: 31 }, { floor: 40, ceiling: 0 }),
        1);
    });

  it("leaves a control already clear", () => {
    assert.equal(clearBy({ top: 400, bottom: 440 }, band), 0);
    assert.equal(clearBy({ top: 20, bottom: 40 }, band), 0);
  });

  it("leaves a control taller than half the band", () => {
    assert.equal(clearBy({ top: 500, bottom: 1000 }, band), 0);
  });
});
