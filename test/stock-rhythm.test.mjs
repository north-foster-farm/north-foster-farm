// The order page's stock rhythm (#908): one 15-second floor, and five
// minutes without input to idle. lib/stock-rhythm.mjs, with its clock
// handed in.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FLOOR_MS, IDLE_MS, StockRhythm,
} from "../assets/scripts/order/lib/stock-rhythm.mjs";

const at = () => {
  const clock = { t: 0 };

  return { clock, rhythm: new StockRhythm(() => clock.t) };
};

describe("StockRhythm", () => {
  it("holds a check's answer for the floor, then lets the next go", () => {
    const { clock, rhythm } = at();

    assert.equal(rhythm.fresh, false, "nothing asked yet");
    rhythm.asked();
    clock.t = FLOOR_MS - 1;
    assert.equal(rhythm.fresh, true);
    clock.t = FLOOR_MS;
    assert.equal(rhythm.fresh, false);
  });

  it("goes idle five minutes after the last input, and says so once", () => {
    const { clock, rhythm } = at();

    clock.t = IDLE_MS - 1;
    assert.equal(rhythm.idle, false);
    assert.equal(rhythm.input(), false, "not idle at this input");
    clock.t += IDLE_MS;
    assert.equal(rhythm.idle, true);
    assert.equal(rhythm.input(), true, "this input ends the idle");
    assert.equal(rhythm.idle, false);
  });
});
