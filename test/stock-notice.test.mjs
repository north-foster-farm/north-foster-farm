// The notice over the cart when a stock check changed it (#400, item
// 20): a lead-in, then one sentence per change, each the item's full
// name, a colon and what happened, never a semicolon.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { stockNotice } from "../assets/scripts/order/lib/stock-notice.mjs";

const index = indexCatalog(catalog);
const name = (sku) => index.get(sku).lineName;
const BIRD = name("NFF-CHK-WHL-30-34");
const EGGS = name("NFF-CHK-EGG-LG");
const LEAD =
  "Available stock changed for an item in your cart, so we updated it.";

describe("stockNotice", () => {
  it("says nothing when nothing changed", () => {
    assert.equal(stockNotice([]), "");
  });

  it("names a lowered quantity with what is left", () => {
    assert.equal(stockNotice([{ name: BIRD, left: 2 }]), `${LEAD} ${BIRD}:`
      + " only 2 left in stock, so we lowered your quantity.");
  });

  it("says one left the same way", () => {
    assert.equal(stockNotice([{ name: BIRD, left: 1 }]), `${LEAD} ${BIRD}:`
      + " only 1 left in stock, so we lowered your quantity.");
  });

  it("names a line removed, and never says sold", () => {
    const notice = stockNotice([{ name: EGGS }]);

    assert.equal(notice, `${LEAD} ${EGGS}:`
      + " out of stock, so we removed it from your cart.");
    assert.doesNotMatch(notice, /sold/i);
  });

  it("gives each of several changes its own sentence", () => {
    const notice = stockNotice([{ name: BIRD, left: 2 }, { name: EGGS }]);

    assert.equal(notice,
      "Available stock changed for some items in your cart, so we updated"
      + " it."
      + ` ${BIRD}: only 2 left in stock, so we lowered your quantity.`
      + ` ${EGGS}: out of stock, so we removed it from your cart.`);
    assert.doesNotMatch(notice, /;/);
  });

  // The colon reads the same after a name with a comma of its own and
  // after one without (#400), so neither takes a comma after it.
  it("reads the same with or without a comma in the name", () => {
    assert.equal(stockNotice([{ name: BIRD }]), `${LEAD} ${BIRD}:`
      + " out of stock, so we removed it from your cart.");
    assert.equal(stockNotice([{ name: "Sweet Italian Sausage" }]), `${LEAD}`
      + " Sweet Italian Sausage: out of stock, so we removed it from your"
      + " cart.");
    assert.equal(stockNotice([{ name: "Wings", left: 2 }]), `${LEAD}`
      + " Wings: only 2 left in stock, so we lowered your quantity.");
    assert.equal(stockNotice([{ name: "Wings", left: 1 }]), `${LEAD}`
      + " Wings: only 1 left in stock, so we lowered your quantity.");
    assert.doesNotMatch(stockNotice([{ name: BIRD, left: 2 }]), /lbs,/);
  });

  it("uses the item's full name, its weight with a dash", () => {
    assert.match(BIRD, /^Whole Chicken, 3\.0 – 3\.4 lbs$/);
  });
});
