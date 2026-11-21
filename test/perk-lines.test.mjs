// What perkLines gives (#717): the lines a customer's perks show as,
// in the cart note and the account page's "Your pricing" row. The words are
// test/perks.test.mjs's and e2e/perk-label.spec.mjs's; this checks
// how the lines are put together.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { perkLines, perkParts } from "../assets/scripts/order/lib/perks.mjs";

const perk = (type, end = null) => ({ type, start: "2026-11-01", end });

describe("perkLines", () => {
  it("gives a bundle its own line, with its name and parts", () => {
    assert.deepEqual(perkLines([perk("friends")]), [{
      text: "Friends and family pricing",
      name: "Friends and family pricing",
      parts: perkParts("friends"),
    }]);
  });

  it("puts the standalone perks on one line, after the bundles", () => {
    assert.deepEqual(perkLines([
      perk("free-delivery"), perk("family"), perk("minimum-waived"),
    ]).map((line) => line.labels || line.text), [
      "Family pricing", ["Free delivery", "No order minimum"],
    ]);
  });

  it("keeps the end dates only when asked", () => {
    const perks = [perk("family", "2027-12-31"), perk("free-delivery",
      "2027-03-03")];

    assert.deepEqual(perkLines(perks).map((l) => l.labels || l.text),
      ["Family pricing", ["Free delivery"]]);
    assert.deepEqual(
      perkLines(perks, { dates: true }).map((l) => l.labels || l.text),
      ["Family pricing through the end of 2027",
        ["Free delivery through March 3, 2027"]]
    );
    assert.equal(perkLines(perks, { dates: true })[0].name,
      "Family pricing");
  });

  it("shows nothing for no perks or an unknown one", () => {
    assert.deepEqual(perkLines([]), []);
    assert.deepEqual(perkLines(undefined), []);
    assert.deepEqual(perkLines([perk("gold-star")]), []);
  });
});
