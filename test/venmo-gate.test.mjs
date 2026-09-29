import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { venmoGate } from "../assets/scripts/order/lib/venmo.mjs";

describe("the Venmo dark launch", () => {
  it("enables the button for everyone when not hidden", () => {
    assert.deepEqual(venmoGate(false, "", false),
      { enabled: true, remember: false });
    assert.deepEqual(venmoGate(false, "?edit=NFF-1", true),
      { enabled: true, remember: true });
  });

  it("disables the button in a browser that never opened ?venmo", () => {
    assert.deepEqual(venmoGate(true, "", false),
      { enabled: false, remember: false });
    assert.deepEqual(venmoGate(true, "?method=onfarm", false),
      { enabled: false, remember: false });
  });

  it("enables it with ?venmo, and remembers", () => {
    for (const search of ["?venmo", "?venmo=1", "?add=EGG:1&venmo"]) {
      assert.deepEqual(venmoGate(true, search, false),
        { enabled: true, remember: true }, search);
    }
  });

  it("keeps it enabled once remembered, whatever the URL", () => {
    for (const search of ["", "?edit=NFF-2609-NT8R", "?add=EGG:2"]) {
      assert.deepEqual(venmoGate(true, search, true),
        { enabled: true, remember: true }, search);
    }
  });

  it("forgets with ?venmo=0", () => {
    assert.deepEqual(venmoGate(true, "?venmo=0", true),
      { enabled: false, remember: false });
  });
});
