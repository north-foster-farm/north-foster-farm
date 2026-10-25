// The notice over the cart when a stock check changed it (#400, item
// 20): a lead-in, then one sentence per change, never a semicolon.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { stockNotice } from "../assets/scripts/order/lib/stock-notice.mjs";

const index = indexCatalog(catalog);
const name = (sku) => index.get(sku).lineName;
const BIRD = name("NFF-CHK-WHL-30-34");
const EGGS = name("NFF-CHK-EGG-LG");

describe("stockNotice", () => {
  it("says nothing when nothing changed", () => {
    assert.equal(stockNotice([]), "");
  });

  it("names a lowered quantity with what is left", () => {
    assert.equal(stockNotice([{ name: BIRD, left: 2 }]),
      "Available stock changed for an item in your cart, so we updated it."
      + ` Only 2 of ${BIRD}, are in stock, so we lowered your quantity.`);
  });

  it("takes the singular for one left", () => {
    assert.equal(stockNotice([{ name: BIRD, left: 1 }]),
      "Available stock changed for an item in your cart, so we updated it."
      + ` Only 1 of ${BIRD}, is in stock, so we lowered your quantity.`);
  });

  it("names a line removed, and never says sold", () => {
    const notice = stockNotice([{ name: EGGS }]);

    assert.equal(notice,
      "Available stock changed for an item in your cart, so we updated it."
      + ` ${EGGS}, is out of stock, so we removed it from your cart.`);
    assert.doesNotMatch(notice, /sold/i);
  });

  it("gives each of several changes its own sentence", () => {
    const notice = stockNotice([{ name: BIRD, left: 2 }, { name: EGGS }]);

    assert.equal(notice,
      "Available stock changed for some items in your cart, so we updated"
      + " it."
      + ` Only 2 of ${BIRD}, are in stock, so we lowered your quantity.`
      + ` ${EGGS}, is out of stock, so we removed it from your cart.`);
    assert.doesNotMatch(notice, /;/);
  });

  // The comma after a name closes one inside it (#400): "Whole Chicken,
  // 3.0 – 3.4 lbs, is". A name with none takes none.
  it("closes a name's comma, and adds none to a name without one", () => {
    const LEAD =
      "Available stock changed for an item in your cart, so we updated it.";

    assert.equal(stockNotice([{ name: BIRD }]), `${LEAD} ${BIRD},`
      + " is out of stock, so we removed it from your cart.");
    assert.equal(stockNotice([{ name: "Sweet Italian Sausage" }]), `${LEAD}`
      + " Sweet Italian Sausage is out of stock, so we removed it from your"
      + " cart.");
    assert.equal(stockNotice([{ name: "Wings", left: 2 }]), `${LEAD}`
      + " Only 2 of Wings are in stock, so we lowered your quantity.");
    assert.equal(stockNotice([{ name: "Wings", left: 1 }]), `${LEAD}`
      + " Only 1 of Wings is in stock, so we lowered your quantity.");
  });

  it("uses the item's full name", () => {
    assert.match(BIRD, /^Whole Chicken, 3\.0 . 3\.4 lbs$/);
  });
});
