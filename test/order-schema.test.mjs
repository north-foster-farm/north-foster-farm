import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { withStock } from "../assets/scripts/order/schema.js";

const graph = () => JSON.parse(readFileSync(
  new URL("fixtures/schema/order.json", import.meta.url), "utf8"));
const offer = (data, sku) => data["@graph"]
  .find((n) => n.sku === sku).offers.availability;

const EGGS = "NFF-CHK-EGG-LG";
const GONE = "NFF-CHK-THGBN-20-99";

describe("the order page's Product markup follows /api/stock (#191)", () => {
  it("sets an Offer from the stock the page heard of", () => {
    const data = graph();

    assert.equal(offer(data, EGGS), "https://schema.org/InStock");

    const next = withStock(data, { [EGGS]: { inStock: false } });

    assert.equal(offer(next, EGGS), "https://schema.org/OutOfStock");
    assert.equal(offer(withStock(next, { [EGGS]: { inStock: true } }),
      EGGS), "https://schema.org/InStock");
  });

  it("leaves a discontinued item discontinued", () => {
    const data = graph();

    assert.equal(offer(data, GONE), "https://schema.org/Discontinued");
    assert.equal(withStock(data, { [GONE]: { inStock: true } }), null);
  });

  it("says nothing changed when stock agrees with the markup", () => {
    assert.equal(withStock(graph(), { [EGGS]: { inStock: true } }), null);
    assert.equal(withStock(graph(), {}), null);
  });
});
