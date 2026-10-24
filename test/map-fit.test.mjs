// Framing a picked town on the map (#409).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clearance, fit } from "../assets/scripts/map/fit.mjs";

const FRAME = { left: 0, top: 0, right: 390, bottom: 300 };
const SIZE = { width: 390, height: 300 };
const BASE = { top: 76, right: 38, bottom: 38, left: 38 };
const WHOLE = { w: 1000, h: 770 };

// Where the box lands on screen, in pixels, for a view.
const screen = (view, box) => ({
  left: (box.x - view.x) / view.w * SIZE.width,
  right: (box.x + box.width - view.x) / view.w * SIZE.width,
  top: (box.y - view.y) / view.h * SIZE.height,
  bottom: (box.y + box.height - view.y) / view.h * SIZE.height,
});

describe("clearance", () => {
  it("keeps the base on every side with nothing over the map", () => {
    assert.deepEqual(clearance(FRAME, [], BASE), BASE);
  });

  it("adds a margin past a cover on the right", () => {
    const zoom = { left: 338, top: 12, right: 378, bottom: 140 };
    const room = clearance(FRAME, [zoom], BASE);

    assert.equal(room.right, 390 - 338 + 38);
    assert.equal(room.left, 38);
    assert.equal(room.top, 76);
  });

  it("reads a wide cover by its edge", () => {
    const top = { left: 8, top: 8, right: 380, bottom: 40 };
    const bottom = { left: 8, top: 240, right: 380, bottom: 292 };

    assert.equal(clearance(FRAME, [top], BASE).top, 40 + 76);
    assert.equal(clearance(FRAME, [bottom], BASE).bottom, 300 - 240 + 38);
  });

  it("ignores a cover outside the frame", () => {
    const below = { left: 0, top: 320, right: 390, bottom: 400 };

    assert.deepEqual(clearance(FRAME, [below], BASE), BASE);
  });

  it("never takes more than 45% of a side", () => {
    const wall = { left: 0, top: 0, right: 300, bottom: 120 };
    const side = { left: 20, top: 0, right: 190, bottom: 300 };

    assert.equal(clearance(FRAME, [wall], BASE).top, 300 * 0.45);
    assert.equal(clearance(FRAME, [side], BASE).left, 390 * 0.45);
  });
});

describe("fit", () => {
  it("holds the box inside the room on a narrow frame", () => {
    const box = { x: 300, y: 200, width: 120, height: 60 };
    const view = fit(box, SIZE, BASE, WHOLE, 4);
    const at = screen(view, box);

    assert.ok(at.left >= BASE.left - 1e-6);
    assert.ok(at.right <= SIZE.width - BASE.right + 1e-6);
    assert.ok(at.top >= BASE.top - 1e-6);
    assert.ok(at.bottom <= SIZE.height - BASE.bottom + 1e-6);
  });

  it("is limited by the tighter axis", () => {
    const tall = { x: 100, y: 100, width: 40, height: 200 };
    const view = fit(tall, SIZE, BASE, WHOLE, 4);
    const at = screen(view, tall);

    assert.ok(Math.abs(at.top - BASE.top) < 1e-6);
    assert.ok(Math.abs(SIZE.height - BASE.bottom - at.bottom) < 1e-6);
  });

  it("keeps the frame's shape", () => {
    const view = fit({ x: 0, y: 0, width: 80, height: 50 }, SIZE, BASE,
      WHOLE, 4);

    assert.ok(Math.abs(view.w / view.h - SIZE.width / SIZE.height) < 1e-9);
  });

  it("leaves more room on the side a cover takes", () => {
    const box = { x: 400, y: 300, width: 100, height: 80 };
    const room = { ...BASE, right: 90 };
    const view = fit(box, SIZE, room, WHOLE, 4);

    assert.ok(screen(view, box).right <= SIZE.width - 90 + 1e-6);
  });

  it("stops at the nearest zoom for a small town", () => {
    const view = fit({ x: 500, y: 400, width: 2, height: 2 }, SIZE, BASE,
      WHOLE, 4);

    assert.equal(view.w, WHOLE.w / 4);
  });
});
