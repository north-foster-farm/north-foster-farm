import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import { packLabel } from "../assets/scripts/order/lib/catalog.mjs";

// Pack labels are capitalized where they show, never in the catalog
// (#278).
describe("packLabel", () => {
  it("capitalizes a letter first", () => {
    assert.equal(packLabel("up to 1.9 lbs"), "Up to 1.9 lbs");
    assert.equal(packLabel("under 3.0 lbs"), "Under 3.0 lbs");
  });

  it("leaves a figure first, and a capital, as they are", () => {
    assert.equal(packLabel("1.5 lbs and up"), "1.5 lbs and up");
    assert.equal(packLabel("2.0 – 2.4 lbs"), "2.0 – 2.4 lbs");
    assert.equal(packLabel("Large"), "Large");
  });

  it("changes nothing but the first letter of any catalog label", () => {
    for (const group of catalog.groups) {
      for (const { label } of group.items) {
        const shown = packLabel(label);

        assert.equal(shown.slice(1), label.slice(1));
        assert.equal(shown.toLowerCase(), label.toLowerCase());
      }
    }
  });
});
