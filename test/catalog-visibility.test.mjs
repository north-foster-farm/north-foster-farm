// Every product in data/catalog.json, at a count of 0 and above it,
// under In stock and Full catalog, shown or hidden as its restock type
// says (#501). It checks the rule, not a table, so a product added
// later is covered without editing this (James, #303 6454589969 and
// 6457154118): a restock type describes only the sold-out state, so no
// type hides stock but `archived`.
//
//   count  type                                   In stock  Full catalog
//   > 0    any but archived                       orderable orderable
//   > 0    archived                               hidden    hidden
//   0      soon, seasonal, hiatus, discontinued   hidden    label only
//   0      hidden, archived                       hidden    hidden
//
// Two layers give the result: the server's availability(), then the
// order page's row rule (order/restock.js) over a row as
// order/row.html writes it and order/stock.js marks it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { showRows } from "../assets/scripts/order/restock.js";
import { availability, hiddenBy } from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const items = [...indexCatalog(catalog).values()];

// The types the table names: those with a label while sold out, and
// those with none.
const LABELED = ["soon", "seasonal", "hiatus", "discontinued"];
const UNLABELED = ["hidden", "archived"];

// Flagged `inStock: false` with stock in Square, a product stays off
// the page and the farm is told every day (#499, hiddenBy). James
// ruled these correct as they are, with no stock (#303 6454589969).
// Any other product flagged out fails below, for him to rule on.
const FLAGGED_OUT = ["NFF-CHK-EGG-MD", "NFF-CHK-EGG-SM", "NFF-CHK-SAUSWT"];

// The words the restock label partial gives a type, as the build puts
// them in the row's data-restock-label; "" for a type with none.
const PARTIAL = readFileSync(new URL(
  "../layouts/partials/order/restock-label.html", import.meta.url
), "utf8");
const WORDS = Object.fromEntries([...PARTIAL.matchAll(
  /eq \. "(\w+)" \}\}\s*\{\{ \$label = ([^\n]*?) \}\}/g
)].map(([, type, value]) => [type, value]));
const label = (item) => {
  const value = WORDS[item.restock];

  if (!value) return "";
  if (value.startsWith("printf")) {
    return `Back in ${item.restockSeason || "spring"}`;
  }

  return JSON.parse(value);
};

// What the page shows of an item at `n` packs: per Show choice,
// whether its row shows, can be added, and its label while out.
const page = async (n) => {
  const counts = Object.fromEntries(items.map((i) => [i.sku, n]));
  const state = await availability(testStores(), { counts });
  const out = {};

  for (const item of items) {
    const inStock = state[item.sku].inStock;
    const attrs = new Set([
      ...(item.restock === "archived" ? ["data-archived"] : []),
      ...(inStock ? [] : ["data-out"]),
    ]);
    const row = {
      dataset: { restockLabel: label(item) },
      hidden: false,
      hasAttribute: (name) => attrs.has(name),
    };
    const form = {
      querySelectorAll: (s) => (s === ".order-item" ? [row] : []),
    };
    const seen = (only) => {
      showRows(form, only);

      return row.hidden ? "hidden"
        : inStock ? "orderable" : row.dataset.restockLabel;
    };

    out[item.sku] = { stock: seen(true), full: seen(false) };
  }

  return out;
};

// The table's answer for an item at `n` packs.
const rule = (item, n) => {
  if (item.restock === "archived") return { stock: "hidden", full: "hidden" };
  if (n > 0) return { stock: "orderable", full: "orderable" };
  if (LABELED.includes(item.restock)) {
    return { stock: "hidden", full: label(item) };
  }

  return { stock: "hidden", full: "hidden" };
};

describe("every catalog product's visibility (#501)", () => {
  it("has a restock type the table names", () => {
    for (const item of items) {
      assert.ok([...LABELED, ...UNLABELED].includes(item.restock),
        `${item.sku}: ${item.restock}`);
    }
  });

  it("gives every labeled type its words", () => {
    for (const item of items.filter((i) => LABELED.includes(i.restock))) {
      assert.ok(label(item), item.sku);
    }
  });

  it("flags out only what James ruled on, each reported with stock",
    () => {
      const out = items.filter((i) => !i.inStock && i.restock !== "archived");

      assert.deepEqual(out.map((i) => i.sku).sort(), [...FLAGGED_OUT].sort());
      for (const item of out) {
        assert.equal(hiddenBy(item), "inStock false", item.sku);
      }
    });

  for (const n of [0, 3]) {
    it(`follows the rule at a count of ${n}`, async () => {
      const seen = await page(n);

      for (const item of items) {
        // Flagged out, stock can't sell it (above); it shows as at 0.
        const want = FLAGGED_OUT.includes(item.sku)
          ? rule(item, 0) : rule(item, n);

        assert.deepEqual(seen[item.sku], want,
          `${item.sku} (${item.restock}) at ${n}`);
      }
    });
  }
});
