import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { expired } from "../assets/scripts/expiry/expiry.js";

const end = "2026-10-18T00:00:00-04:00";

describe("expiry", () => {
  it("keeps a note until its moment", () => {
    assert.equal(expired(end, Date.parse("2026-10-17T23:59:59-04:00")),
      false);
  });

  it("hides it from that moment on", () => {
    assert.equal(expired(end, Date.parse("2026-10-18T00:00:00-04:00")),
      true);
    assert.equal(expired(end, Date.parse("2027-01-01T12:00:00-05:00")),
      true);
  });

  it("keeps a note whose moment cannot be read", () => {
    assert.equal(expired("", 0), false);
    assert.equal(expired("soon", Date.now()), false);
    assert.equal(expired(undefined, Date.now()), false);
  });
});
