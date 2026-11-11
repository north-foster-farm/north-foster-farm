// Clear cart's two presses (#531): the first asks, a second in time
// acts, and waiting puts it back.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import {
  CONFIRM_WAIT, twoStep,
} from "../assets/scripts/order/cart/confirm.mjs";

// A two-step control that writes down what it was told.
const recorded = (opts = {}) => {
  const log = [];
  const control = twoStep({
    onArm: () => log.push("arm"),
    onDisarm: () => log.push("disarm"),
    onConfirm: () => log.push("confirm"),
    ...opts,
  });

  return { control, log };
};

describe("cart/confirm.mjs twoStep", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("asks on the first press and acts on the second", () => {
    const { control, log } = recorded();

    assert.equal(control.press(), false);
    assert.equal(control.armed, true);
    mock.timers.tick(CONFIRM_WAIT - 1);
    assert.equal(control.press(), true);
    assert.equal(control.armed, false);
    assert.deepEqual(log, ["arm", "disarm", "confirm"]);
  });

  it("puts itself back when the wait runs out, and acts on nothing", () => {
    const { control, log } = recorded();

    control.press();
    mock.timers.tick(CONFIRM_WAIT);
    assert.equal(control.armed, false);
    assert.deepEqual(log, ["arm", "disarm"]);

    // The press after the wait asks again.
    assert.equal(control.press(), false);
    assert.deepEqual(log, ["arm", "disarm", "arm"]);
  });

  it("goes back at once on reset, and the next press asks again", () => {
    const { control, log } = recorded();

    control.press();
    control.reset();
    control.reset();
    assert.equal(control.armed, false);
    mock.timers.tick(CONFIRM_WAIT);
    assert.equal(control.press(), false);
    assert.deepEqual(log, ["arm", "disarm", "arm"]);
  });

  it("does nothing on reset while at rest", () => {
    const { control, log } = recorded();

    control.reset();
    assert.deepEqual(log, []);
  });

  it("takes its own wait", () => {
    const { control, log } = recorded({ wait: 100 });

    control.press();
    mock.timers.tick(100);
    assert.equal(control.press(), false);
    assert.deepEqual(log, ["arm", "disarm", "arm"]);
  });

  it("waits a few seconds by default", () => {
    assert.ok(CONFIRM_WAIT >= 3000 && CONFIRM_WAIT <= 6000);
  });
});
