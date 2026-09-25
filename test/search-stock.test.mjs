import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX, fitQty, room, soldOut, stockText,
} from "../assets/scripts/search/stock.js";

const SKU = "NFF-CHK-EGG-LG";
const live = (inStock, available) => ({ [SKU]: { inStock, available } });

describe("search stock", () => {
  it("offers everything until stock answers", () => {
    assert.equal(soldOut(null, SKU), false);
    assert.equal(room(null, SKU, 0), MAX);
    assert.equal(room(null, SKU, 3), MAX - 3);
    assert.equal(stockText(null, SKU), "In stock");
  });

  it("offers nothing of what is sold out", () => {
    assert.equal(soldOut(live(false, null), SKU), true);
    assert.equal(room(live(false, 5), SKU, 0), 0);
    assert.equal(stockText(live(false, null), SKU), "Sold out");
  });

  it("caps the room at what is left, less what is in the cart", () => {
    assert.equal(room(live(true, null), SKU, 0), MAX);
    assert.equal(room(live(true, 4), SKU, 0), 4);
    assert.equal(room(live(true, 4), SKU, 3), 1);
    assert.equal(room(live(true, 4), SKU, 6), 0);
    assert.equal(room(live(true, 500), SKU, 0), MAX);
  });

  it("says how many are left from ten down", () => {
    assert.equal(stockText(live(true, 11), SKU), "In stock");
    assert.equal(stockText(live(true, 10), SKU), "Only 10 left");
    assert.equal(stockText(live(true, null), SKU), "In stock");
  });

  it("treats a product stock doesn't list as unknown", () => {
    assert.equal(soldOut({}, SKU), false);
    assert.equal(room({}, SKU, 0), MAX);
  });

  // #162: stock arriving keeps the quantity chosen unless there is no
  // longer room for it.
  it("keeps the quantity chosen, lowered only to the room", () => {
    assert.equal(fitQty(2, MAX), 2);
    assert.equal(fitQty(5, 3), 3);
    assert.equal(fitQty(2, 0), 1);
    assert.equal(fitQty(0, MAX), 1);
    assert.equal(fitQty(150, MAX), MAX);
  });
});
