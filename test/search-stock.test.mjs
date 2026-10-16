import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX, room, soldOut } from "../assets/scripts/search/stock.js";

const SKU = "NFF-CHK-EGG-LG";
const live = (inStock, available) => ({ [SKU]: { inStock, available } });

describe("search stock", () => {
  it("offers everything until stock answers", () => {
    assert.equal(soldOut(null, SKU), false);
    assert.equal(room(null, SKU, 0), MAX);
    assert.equal(room(null, SKU, 3), MAX - 3);
  });

  it("offers nothing of what is sold out", () => {
    assert.equal(soldOut(live(false, null), SKU), true);
    assert.equal(room(live(false, 5), SKU, 0), 0);
  });

  it("caps the room at what is left, less what is in the cart", () => {
    assert.equal(room(live(true, null), SKU, 0), MAX);
    assert.equal(room(live(true, 4), SKU, 0), 4);
    assert.equal(room(live(true, 4), SKU, 3), 1);
    assert.equal(room(live(true, 4), SKU, 6), 0);
    assert.equal(room(live(true, 500), SKU, 0), MAX);
  });

  it("treats a product stock doesn't list as unknown", () => {
    assert.equal(soldOut({}, SKU), false);
    assert.equal(room({}, SKU, 0), MAX);
  });
});
