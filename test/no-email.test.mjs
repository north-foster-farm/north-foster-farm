import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { noEmailRefusal } from "../bin/no-email.mjs";
import { pickupSites } from "../assets/scripts/order/lib/sites.mjs";

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

describe("a market's opening hour", () => {
  const opens = (when) => pickupSites([{
    name: "Market", when, opens: "2026-05-01", closes: "2026-10-31",
    pickup: { id: "m" },
  }])[0].opensHour;

  it("gives a single PM to the start when it is the earlier hour", () => {
    assert.equal(opens("Sundays, 4:00 – 7:00 PM"), 16);
  });

  it("keeps an AM start that runs past noon", () => {
    assert.equal(opens("Sundays, 11:00 – 1:00 PM"), 11);
    assert.equal(opens("Sundays, 10:00 – 12:00 PM"), 10);
    assert.equal(opens("Sundays, 9:00 AM – 1:00 PM"), 9);
    assert.equal(opens("Sundays, 12:00 – 4:00 PM"), 12);
  });
});
