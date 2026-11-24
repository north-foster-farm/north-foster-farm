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

  // The account row's call: in the cart the free delivery badge shows
  // free delivery instead (#717, revised; e2e/perk-label.spec.mjs).
  it("puts the standalone perks on one line", () => {
    assert.deepEqual(perkLines([
      perk("free-delivery"), perk("minimum-waived"),
    ], { dates: true }).map((line) => line.labels || line.text), [
      ["Free delivery", "No delivery minimum"],
    ]);
  });

  // Its tooltip already lists them (#717, revised).
  it("drops a standalone perk its bundle lists", () => {
    assert.deepEqual(perkLines([
      perk("free-delivery"), perk("family"), perk("minimum-waived"),
    ]).map((line) => line.labels || line.text), ["Family pricing"]);
  });

  it("keeps the end dates only when asked", () => {
    const perks = [perk("family", "2027-12-31")];
    const alone = [perk("minimum-waived", "2027-03-03")];

    assert.deepEqual(perkLines(perks).map((l) => l.labels || l.text),
      ["Family pricing"]);
    assert.deepEqual(
      perkLines(perks, { dates: true }).map((l) => l.labels || l.text),
      ["Family pricing through the end of 2027"]
    );
    assert.equal(perkLines(perks, { dates: true })[0].name,
      "Family pricing");
    assert.deepEqual(perkLines(alone).map((l) => l.labels),
      [["No delivery minimum"]]);
    assert.deepEqual(
      perkLines(alone, { dates: true }).map((l) => l.labels),
      [["No delivery minimum through March 3, 2027"]]
    );
  });

  it("shows nothing for no perks or an unknown one", () => {
    assert.deepEqual(perkLines([]), []);
    assert.deepEqual(perkLines(undefined), []);
    assert.deepEqual(perkLines([perk("gold-star")]), []);
  });
});
