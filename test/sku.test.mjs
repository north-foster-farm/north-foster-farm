// SKUs (#267, #287): one sold by weight carries its tier's bounds in
// tenths of a pound, two digits each, inclusive ("1.0 – 1.2 lbs" is
// -10-12, "1.7 lbs and up" is -17-99); eggs and sausage carry none.
// docs/sku-map.csv lists every renamed SKU with its new one and the
// date. From 1 January 2027 a SKU never changes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import aliases from "../data/skuAliases.json" with { type: "json" };
import {
  archived, current, currentLines, indexCatalog, shownLines,
} from "../assets/scripts/order/lib/catalog.mjs";

const items = [...indexCatalog(catalog).values()];
const map = readFileSync(new URL("../docs/sku-map.csv", import.meta.url),
  "utf8").trim().split("\n");

// Feet keep their old SKU until this week's weights set their tiers
// (6305037316).
const PENDING = new Set(["NFF-CHK-FET-0075-0125"]);

// An item's tier as its row shows it, without the product's name.
const tier = (item) => item.row.replace(/^[^,]+, /, "");
const tenths = (n) => n.replace(".", "");

describe("the catalog", () => {
  it("carries its version and date (6305650920)", () => {
    assert.match(catalog.version, /^\d{4}-v\d+$/);
    assert.match(catalog.date, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("SKUs", () => {
  it("are unique", () => {
    const skus = items.map((i) => i.sku);

    assert.equal(new Set(skus).size, skus.length);
  });

  it("carry the bounds their tier names", () => {
    for (const item of items) {
      if (archived(item) || PENDING.has(item.sku)) continue;

      const range = tier(item).match(/^(\d\.\d) – (\d\.\d) lbs$/);
      const up = tier(item).match(/^(\d\.\d) lbs and up$/);
      const bounds = item.sku.match(/-(\d\d)-(\d\d)$/);

      if (range) {
        assert.deepEqual(bounds && bounds.slice(1),
          [tenths(range[1]), tenths(range[2])], item.sku);
      } else if (up) {
        assert.deepEqual(bounds && bounds.slice(1), [tenths(up[1]), "99"],
          item.sku);
      } else {
        assert.equal(bounds, null, `${item.sku} has no weight tier`);
        assert.doesNotMatch(item.sku, /\d{4}/, item.sku);
      }
    }
  });
});

describe("docs/sku-map.csv", () => {
  const rows = map.slice(1).map((line) => line.split(","));

  it("has its header and three fields a row, dated", () => {
    assert.equal(map[0], "old_sku,new_sku,date");
    for (const row of rows) {
      assert.equal(row.length, 3, row.join(","));
      assert.match(row[2], /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("points every old SKU at one in the catalog, and none back", () => {
    const skus = new Set(items.map((i) => i.sku));

    for (const [from, to] of rows) {
      assert.ok(!skus.has(from), `${from} is still in the catalog`);
      assert.ok(skus.has(to), `${to} is not in the catalog`);
    }
    assert.equal(new Set(rows.map((r) => r[1])).size, rows.length);
  });
});

// The order page maps old SKUs from Reorder links and saved carts
// through a copy of the map it can read (data/skuAliases.json).
describe("data/skuAliases.json", () => {
  it("is docs/sku-map.csv, old to new", () => {
    assert.deepEqual(aliases, Object.fromEntries(map.slice(1)
      .map((line) => line.split(",").slice(0, 2))));
  });

  it("turns an old SKU into its new one and leaves the rest", () => {
    assert.equal(current("NFF-CHK-BRSBL-0000-0125", aliases),
      "NFF-CHK-BRSBL-10-12");
    assert.equal(current("NFF-CHK-EGG-LG", aliases), "NFF-CHK-EGG-LG");
    assert.equal(current("toString", aliases), "toString");
  });
});

describe("shownLines (#322)", () => {
  const known = new Set(["NEW", "OTHER"]);
  const names = { OLD: "NEW" };

  it("renames, merges and drops what the catalog can't show", () => {
    const lines = [
      { sku: "OLD", qty: 1 }, { sku: "NEW", qty: 2 },
      { sku: "GONE", qty: 4 }, { sku: "OTHER", qty: 0 },
      { sku: "OTHER", qty: "x" }, null,
    ];

    assert.deepEqual(shownLines(lines, names, known),
      [{ sku: "NEW", qty: 3 }]);
  });

  it("keeps the lines it hides when it only brings SKUs up to date", () => {
    assert.deepEqual(currentLines([
      { sku: "OLD", qty: 1 }, { sku: "GONE", qty: 4 },
      { sku: "NEW", qty: 2 },
    ], names), [
      { sku: "NEW", qty: 3 }, { sku: "GONE", qty: 4 },
    ]);
  });

  it("copes with no lines", () => {
    assert.deepEqual(shownLines(undefined, names, known), []);
  });
});
