import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  keepOffset, savedOffset,
} from "../assets/scripts/staging/offset.js";

describe("the staging clock offset kept in the browser", () => {
  it("keeps a set offset, forward or back", () => {
    assert.equal(keepOffset(172800000), "172800000");
    assert.equal(keepOffset(-3600000), "-3600000");
  });

  it("clears at offset 0 or anything unreadable", () => {
    assert.equal(keepOffset(0), null);
    assert.equal(keepOffset(NaN), null);
    assert.equal(keepOffset(undefined), null);
  });

  it("reads it back, and reads nothing as the real time", () => {
    assert.equal(savedOffset("172800000"), 172800000);
    assert.equal(savedOffset("-3600000"), -3600000);
    assert.equal(savedOffset(null), 0);
    assert.equal(savedOffset(""), 0);
    assert.equal(savedOffset("soon"), 0);
  });
});
