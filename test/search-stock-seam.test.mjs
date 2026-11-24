// The site search's one stock seam (#402, assets/scripts/search/
// stock.js): the build's word today, live stock in its place if James
// wants it. The implementer's own test; the criteria are in
// test/search-index.test.mjs and e2e/site-search.spec.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listed, stockOf } from "../assets/scripts/search/stock.js";

const egg = { sku: "E", out: false, restock: "Returning soon" };
const hiatus = { sku: "M", out: true, restock: "On hiatus" };
const hidden = { sku: "H", out: true, restock: "" };

describe("search's stock seam (#402)", () => {
  it("reads the build's stock with no live stock", () => {
    assert.deepEqual(stockOf(egg), { out: false, label: "In stock" });
    assert.deepEqual(stockOf(hiatus), { out: true, label: "On hiatus" });
  });

  it("lets live stock win over the build's", () => {
    assert.deepEqual(stockOf(egg, { E: { inStock: false } }),
      { out: true, label: "Returning soon" });
    assert.deepEqual(stockOf(hiatus, { M: { inStock: true } }),
      { out: false, label: "In stock" });
    assert.equal(stockOf(egg, { other: { inStock: false } }).out, false);
  });

  it("leaves out a product out of stock with no restock label", () => {
    assert.equal(listed(egg), true);
    assert.equal(listed(hiatus), true);
    assert.equal(listed(hidden), false);
    assert.equal(listed(hidden, { H: { inStock: true } }), true);
  });
});
