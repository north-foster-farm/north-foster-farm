// A sentence that ends on a product's name gets one period, not two
// (#159): a name such as "Wings, 1 lb avg." already ends in one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sentence } from "../assets/scripts/order/lib/sentence.mjs";

describe("sentence", () => {
  it("adds a period where the text has none", () => {
    assert.equal(sentence("Not available: Eggs, Medium"),
      "Not available: Eggs, Medium.");
  });

  it("keeps the one a name ends in", () => {
    assert.equal(sentence("Not available: Wings, 1 lb avg."),
      "Not available: Wings, 1 lb avg.");
  });

  it("leaves a question or an exclamation alone", () => {
    assert.equal(sentence("Still there?"), "Still there?");
    assert.equal(sentence("Added!"), "Added!");
  });
});
