import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { noEmailRefusal } from "../bin/no-email.mjs";
import { buildModel } from "../assets/scripts/order/lib/events.mjs";

describe("--no-email refusals", () => {
  it("refuses the commands that send retention or news email", () => {
    assert.match(noEmailRefusal("jobs", "run"), /transactional/);
    assert.match(noEmailRefusal("audience", "invite"), /confirmation/);
  });

  it("lets the order commands through", () => {
    for (const [group, action] of [
      ["orders", "change"], ["orders", "cancel"], ["orders", "refund"],
      ["address", "approve"], ["breaker", "reset"], ["audience", "sync"],
    ]) {
      assert.equal(noEmailRefusal(group, action), null);
    }
  });
});

describe("a series' opening hour and window", () => {
  const series = (opens, closes) => buildModel([], [{
    code: "AAAA", name: "Market", location: "BBBB", start: "2026-05-03",
    end: "2026-10-31", opens, closes,
  }]).series[0];

  it("reads a 24-hour opening and prints the farm's window", () => {
    assert.equal(series("16:00", "19:00").opensHour, 16);
    assert.equal(series("16:00", "19:00").window, "4:00 – 7:00 PM");
    assert.equal(series("11:00", "13:00").window, "11:00 AM – 1:00 PM");
    assert.equal(series("09:00", "13:00").window, "9:00 AM – 1:00 PM");
    assert.equal(series("12:00", "16:00").window, "12:00 – 4:00 PM");
  });
});
