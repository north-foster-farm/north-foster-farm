import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { venmoGate } from "../assets/scripts/order/lib/venmo.mjs";

describe("the Venmo dark launch", () => {
  it("shows the button to everyone when not hidden", () => {
    assert.deepEqual(venmoGate(false, "", false),
      { show: true, remember: false });
    assert.deepEqual(venmoGate(false, "?edit=NFF-1", true),
      { show: true, remember: true });
  });

  it("hides the button from a browser that never opened ?venmo", () => {
    assert.deepEqual(venmoGate(true, "", false),
      { show: false, remember: false });
    assert.deepEqual(venmoGate(true, "?method=onfarm", false),
      { show: false, remember: false });
  });

  it("shows it with ?venmo, and remembers", () => {
    for (const search of ["?venmo", "?venmo=1", "?add=EGG:1&venmo"]) {
      assert.deepEqual(venmoGate(true, search, false),
        { show: true, remember: true }, search);
    }
  });

  it("keeps showing it once remembered, whatever the URL", () => {
    for (const search of ["", "?edit=NFF-2609-NT8R", "?add=EGG:2"]) {
      assert.deepEqual(venmoGate(true, search, true),
        { show: true, remember: true }, search);
    }
  });

  it("forgets with ?venmo=0", () => {
    assert.deepEqual(venmoGate(true, "?venmo=0", true),
      { show: false, remember: false });
  });
});
