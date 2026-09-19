import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { countdown } from "../assets/scripts/order/date-lists.js";

describe("the delivery countdown", () => {
  it("lists days, hours and minutes with an Oxford comma", () => {
    assert.equal(countdown(2, 5, 12), "2 days, 5 hours, and 12 minutes");
    assert.equal(countdown(1, 1, 1), "1 day, 1 hour, and 1 minute");
  });

  it("keeps a zero hour between days and minutes", () => {
    assert.equal(countdown(3, 0, 40), "3 days, 0 hours, and 40 minutes");
  });

  it("drops the leading zero units", () => {
    assert.equal(countdown(0, 5, 0), "5 hours and 0 minutes");
    assert.equal(countdown(0, 0, 12), "12 minutes");
  });
});
