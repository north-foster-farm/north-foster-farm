// Criteria tests for #402 (Header search: a plain site search in place
// of the palette) on live stock. James, 2026-11-21: search shows live
// stock, fetched when search opens, as the palette did (#267, #492).
// These are restock.spec.mjs's two search tests, "stock wins in search
// too" and the search half of "a hidden product shows only while in
// stock", rewritten for the new search; what each checks is unchanged.
// Held out of every run by its name until the change lands: renamed to
// search-stock.spec.mjs, it runs in the desktop and phone projects.
//
// The seam, what the tests rely on, beside site-search.criteria.mjs's:
// - The field is a combobox whose accessible name holds "Search", in a
//   `role="search"` landmark; below 992 px the banner's button whose
//   name holds "Search" opens it.
// - Each product option carries `data-sku`, and `data-stock="out"`
//   while it is out of stock.
// - The search landmark gets `data-stock="ready"` once live stock has
//   been applied, or has failed.
// The second line's wording is a draft for James, so the tests read
// only the price's "$" and the catalog's own restock label.

import { readFileSync } from "node:fs";

import { SUITE_STOCK, expect, test } from "./support/order.mjs";
import { findInSearch } from "./support/search.mjs";
import { PLENTY } from "./support/stock.mjs";
import { stubStock } from "./support/stock-stub.mjs";

const catalog = JSON.parse(readFileSync(
  new URL("../data/catalog.json", import.meta.url), "utf8"
));
const items = catalog.groups.flatMap((g) => g.items);
const named = (sku) => items.find((i) => i.sku === sku).name;

// Sweet Italian Sausage, out in the catalog, "On hiatus".
const HIATUS = "NFF-CHK-SAUSWT";
// A tier hidden while empty (#492), flagged in stock so that the
// count decides.
const HIDDEN = "NFF-CHK-WHL-50-59";

const plenty = (skus) => Object.fromEntries(skus.map((s) => [s, PLENTY]));

test.use({
  stockPins: {
    ...SUITE_STOCK,
    ...plenty(items.filter((i) => i.restock === "hidden").map((i) => i.sku)),
  },
});

// A stub never outlives its test.
test.afterEach(({ page }) => page.unrouteAll({
  behavior: "ignoreErrors",
}));

// The stub (support/stock-stub.mjs) lays answers over the server's:
// it never counts a product the catalog has out, so only a stub can.
// Search opened as a customer opens it (support/search.mjs).
const find = findInSearch;

test("stock wins in search too", async ({ page }) => {
  await stubStock(page, { [HIATUS]: { inStock: true, available: 4 } });
  await page.goto("/about/");

  const sweet = await find(page, "sweet", HIATUS);

  await expect(sweet).toBeVisible();
  await expect(sweet).not.toHaveAttribute("data-stock", "out");
  await expect(sweet).toContainText("$");
  await expect(sweet).not.toContainText("On hiatus");
});

// #492: a boundary tier only shows while Square counts some.
test("a hidden product shows in search only while in stock", async ({
  page, stock,
}) => {
  const query = named(HIDDEN);

  await stock.pin({ [HIDDEN]: 0 });
  await page.goto("/about/");
  await expect(await find(page, query, HIDDEN)).toHaveCount(0);

  await stock.pin({ [HIDDEN]: 4 });
  await page.goto("/about/");

  const hidden = await find(page, query, HIDDEN);

  await expect(hidden).toHaveCount(1);
  await expect(hidden).not.toHaveAttribute("data-stock", "out");
});
