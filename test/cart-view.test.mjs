import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OWN_MS, moreShown, moveFrames, moves, ownScroll, restOf, toPx,
} from "../assets/scripts/order/cart/view.mjs";

// Whose scroll it is (#559): a finger down, or one within OWN_MS of
// the person's last input or of the last scroll that was theirs.
describe("ownScroll", () => {
  const at = { input: -Infinity, last: -Infinity, touching: false };

  it("counts a scroll under a finger", () => {
    assert.equal(ownScroll({ ...at, now: 5000, touching: true }), true);
  });

  it("counts one just after a wheel or a key", () => {
    assert.equal(ownScroll({ ...at, now: 1100, input: 1000 }), true);
    assert.equal(ownScroll({ ...at, now: 1000 + OWN_MS, input: 1000 }), false);
  });

  it("counts the momentum that follows, frame after frame", () => {
    assert.equal(ownScroll({ ...at, now: 3000, input: 0, last: 2984 }), true);
  });

  it("does not count a scroll the page makes on its own", () => {
    assert.equal(ownScroll({ ...at, now: 9000, input: 0, last: 100 }), false);
  });
});

// The sheet's parts ease between their two sizes (#559).
describe("moves", () => {
  it("moves a part that changes size, comes or goes", () => {
    const shown = (size) => ({ shown: true, size });
    const gone = { shown: false, size: 0 };

    assert.equal(moves(shown(40), shown(80)), true);
    assert.equal(moves(gone, shown(80)), true);
    assert.equal(moves(shown(80), gone), true);
  });

  it("leaves a part that keeps its size, or half a pixel of rounding", () => {
    assert.equal(moves({ shown: true, size: 40 }, { shown: true, size: 40.3 }),
      false);
    assert.equal(moves({ shown: false, size: 0 }, { shown: false, size: 0 }),
      false);
  });
});

describe("moveFrames", () => {
  const part = (size) => ({
    shown: true,
    size,
    room: {
      paddingTop: "8px", paddingBottom: "8px", borderTopWidth: "1px",
      borderBottomWidth: "0px", marginTop: "4px", marginBottom: "0px",
    },
  });
  const button = (size) => ({
    shown: true,
    size,
    gap: 12,
    room: {
      paddingLeft: "14px", paddingRight: "14px", borderLeftWidth: "1px",
      borderRightWidth: "1px", marginRight: "0px",
    },
  });
  const shown = part;
  const gone = { shown: false, size: 0 };

  it("eases a body part's height, with no floor or cap in the way", () => {
    assert.deepEqual(moveFrames(false, shown(40), shown(90)), [
      { height: "40px", minHeight: "0px", maxHeight: "none" },
      { height: "90px", minHeight: "0px", maxHeight: "none" },
    ]);
  });

  it("fades a part that goes as it shrinks to nothing", () => {
    const [from, to] = moveFrames(false, shown(60), gone);

    assert.equal(from.opacity, 1);
    assert.equal(to.opacity, 0);
    assert.equal(to.height, "0px");
  });

  // #559: the padding of the parts that went dropped in the last frame
  // of a minimize, about 40px at once.
  it("takes a part's padding, borders and margins with it", () => {
    const [from, to] = moveFrames(false, part(60), gone);

    assert.equal(from.paddingTop, "8px");
    assert.equal(from.borderTopWidth, "1px");
    assert.equal(from.marginTop, "4px");
    for (const name of Object.keys(part(0).room)) {
      assert.equal(to[name], "0px", name);
    }
  });

  it("brings them in with a part that comes", () => {
    const [from, to] = moveFrames(false, gone, part(60));

    assert.equal(from.paddingBottom, "0px");
    assert.equal(to.paddingBottom, "8px");
    assert.equal(to.marginTop, "4px");
  });

  it("grows a foot button in from no width and no padding", () => {
    const [from, to] = moveFrames(true, gone, button(100));

    assert.equal(from.flexBasis, "0px");
    assert.equal(from.paddingLeft, "0px");
    assert.equal(from.opacity, 0);
    assert.equal(to.flexBasis, "100px");
    assert.equal(to.paddingRight, "14px");
    assert.equal(to.flexGrow, 0);
  });

  it("takes the foot's gap beside a button that goes", () => {
    const [from, to] = moveFrames(true, button(100), gone);

    assert.equal(from.marginRight, "0px");
    assert.equal(to.marginRight, "-12px");
    assert.equal(to.borderLeftWidth, "0px");
  });

  it("moves Proceed to checkout's width alone when it stays", () => {
    const [from, to] = moveFrames(true, shown(150), shown(260));

    assert.equal(from.flexBasis, "150px");
    assert.equal(to.flexBasis, "260px");
    assert.equal("opacity" in to, false);
    assert.equal("paddingLeft" in to, false);
  });
});

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

  // Safari on iOS can rest a list at a fractional scrollTop with
  // nothing above it.
  it("shows no up arrow for a list resting a fraction of a pixel down",
    () => {
      assert.equal(moreShown({ top: 0.5, height: 200, full: 500 }).up, false);
      assert.equal(moreShown({ top: 1, height: 200, full: 500 }).up, false);
      assert.equal(moreShown({ top: 2, height: 200, full: 500 }).up, true);
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
