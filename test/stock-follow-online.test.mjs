// The network coming back is no input (#908, James's rule 4): an idle
// order page stays stopped, an active one checks. order/stock-follow.js
// with a fake Stock and the clock faked.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { StockFollower } from "../assets/scripts/order/stock-follow.js";

describe("StockFollower, back online", () => {
  const saved = {};
  let listeners;
  let refreshed;
  let follower;

  beforeEach(() => {
    const on = (type, fn) => { (listeners[type] ||= []).push(fn); };

    saved.document = globalThis.document;
    saved.window = globalThis.window;
    listeners = {};
    globalThis.document = { visibilityState: "visible", addEventListener: on };
    globalThis.window = { addEventListener: on };
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    refreshed = 0;
    follower = new StockFollower({
      starting: false,
      items: {},
      refresh: async () => {
        refreshed += 1;
        follower.rhythm.asked();

        return {};
      },
      schedule() {},
    });
    follower.listen();
  });

  afterEach(() => {
    mock.timers.reset();
    globalThis.document = saved.document;
    globalThis.window = saved.window;
  });

  const online = () => listeners.online.forEach((fn) => fn());

  it("checks while the page is active", () => {
    online();
    assert.equal(refreshed, 1);
  });

  it("asks nothing once the page has gone idle", () => {
    mock.timers.tick(5 * 60_000);
    online();
    assert.equal(refreshed, 0);
  });
});
