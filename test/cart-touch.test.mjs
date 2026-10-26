import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TAP_SLOP, strayed, touchKind,
} from "../assets/scripts/order/lib/cart-touch.mjs";

const at = { x: 100, y: 200 };

describe("strayed", () => {
  it("is nothing where the touch landed", () => {
    assert.equal(strayed(at, at), 0);
  });

  it("measures the straight line from where it landed", () => {
    assert.equal(strayed(at, { x: 103, y: 204 }), 5);
  });

  it("keeps the farthest so far when the finger comes back", () => {
    const far = strayed(at, { x: 100, y: 260 });

    assert.equal(strayed(at, { x: 100, y: 201 }, far), 60);
  });
});

describe("touchKind", () => {
  it("takes a touch that hardly moved for a tap", () => {
    assert.equal(touchKind({ far: 0 }), "tap");
    assert.equal(touchKind({ far: TAP_SLOP }), "tap");
    assert.equal(touchKind(), "tap");
  });

  it("takes one that strayed past the slop for a scroll", () => {
    assert.equal(touchKind({ far: TAP_SLOP + 1 }), "scroll");
    assert.equal(touchKind({ far: 300 }), "scroll");
  });

  it("takes one the browser cancelled for a scroll, however short", () => {
    assert.equal(touchKind({ cancelled: true, far: 0 }), "scroll");
  });

  it("takes a slop of its own", () => {
    assert.equal(touchKind({ far: 15 }, 20), "tap");
    assert.equal(touchKind({ far: 25 }, 20), "scroll");
  });
});
