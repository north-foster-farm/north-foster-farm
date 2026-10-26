import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  keyboardInset, moreStop, paneFit, ringsCart, rowsFloor, scrollIntoPane,
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

// The Total tab at 390 by 664: the sums' fold, three rows and their
// rule, 104px; the total row and the foot, 140px; the badges, the way
// and the code, 120px, of which the open code row and the dark rule
// are 44px.
describe("paneFit", () => {
  const parts = { pane: 140, fold: 104, below: 120, keep: 44 };

  it("is not tight while the room holds the floor", () => {
    assert.deepEqual(paneFit(parts, 600), {
      floor: 364, fold: 104, rows: 0, keep: 44, tight: false,
    });
  });

  it("is tight under the keyboard, the sums still whole", () => {
    // 364 visible, less the margin and the top bar.
    assert.deepEqual(paneFit(parts, 292), {
      floor: 364, fold: 104, rows: 0, keep: 44, tight: true,
    });
  });

  it("keeps the sums whole until only they, the pane and the row fit",
    () => {
      assert.deepEqual(paneFit(parts, 288), {
        floor: 364, fold: 104, rows: 0, keep: 44, tight: true,
      });
    });

  it("gives the sums what the pane and the open row leave", () => {
    // 320 by 568, 300px of it keyboard: room for the pane and the row,
    // not for the sums too.
    assert.deepEqual(paneFit(parts, 230), {
      floor: 364, fold: 46, rows: 0, keep: 44, tight: true,
    });
  });

  it("gives the sums nothing where not even the pane and row fit", () => {
    assert.deepEqual(paneFit(parts, 170), {
      floor: 364, fold: 0, rows: 0, keep: 30, tight: true,
    });
    assert.deepEqual(paneFit(parts, 100), {
      floor: 364, fold: 0, rows: 0, keep: 0, tight: true,
    });
  });

  it("keeps nothing back without a kept row", () => {
    assert.deepEqual(paneFit({ ...parts, keep: undefined }, 200), {
      floor: 364, fold: 60, rows: 0, keep: 0, tight: true,
    });
  });

  it("rounds up to whole pixels", () => {
    assert.deepEqual(paneFit({ pane: 140.2, fold: 103.4, below: 0 }, 600), {
      floor: 244, fold: 104, rows: 0, keep: 0, tight: false,
    });
  });
});

// The Items tab under a keyboard 300px tall (#476): the room is the
// visible height less the 16px margin and the 56px top bar. The lines'
// fold is three rows and the "more" strip, 174px, with their rule and
// the spacer, 196px; the rest as on the Total tab above.
describe("paneFit on the lines", () => {
  const parts = { pane: 140, fold: 196, below: 120, keep: 44, rows: 174 };
  const room = (height) => height - 300 - 16 - 56;

  it("keeps three rows at 390 by 844", () => {
    assert.deepEqual(paneFit(parts, room(844)), {
      floor: 456, fold: 196, rows: 174, keep: 44, tight: false,
    });
  });

  it("gives up rows, not the kept row, at 375 by 667", () => {
    const fit = paneFit(parts, room(667));

    assert.deepEqual(fit, {
      floor: 456, fold: 111, rows: 89, keep: 44, tight: true,
    });
    // The pane, the fold and the kept row fill the room, no more: Hide
    // and Proceed to checkout stay inside it.
    assert.equal(parts.pane + fit.fold + fit.keep, room(667));
  });

  it("gives up every row at 320 by 568, never the total row", () => {
    const fit = paneFit(parts, room(568));

    assert.deepEqual(fit, {
      floor: 456, fold: 12, rows: 0, keep: 44, tight: true,
    });
    assert.ok(parts.pane + fit.fold + fit.keep <= room(568));
  });

  it("gives the kept row what the pane leaves where it alone fits", () => {
    assert.deepEqual(paneFit(parts, 160), {
      floor: 456, fold: 0, rows: 0, keep: 20, tight: true,
    });
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
