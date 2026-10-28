// Every product in data/catalog.json on the order page, with every
// one pinned at 0 and then 5 on the server for the test's own scope
// (#507), under both Show choices (#501). Each row is shown or hidden,
// labeled or orderable, as its restock type says; the rule, and why it
// is not a table, is in test/catalog-visibility.test.mjs. One page
// load per count.

import { readFileSync } from "node:fs";

import { OrderPage, expect, test } from "./support/order.mjs";

const catalog = JSON.parse(readFileSync(
  new URL("../data/catalog.json", import.meta.url), "utf8"
));
const items = catalog.groups.flatMap((g) => g.items);

// The words a type shows while sold out (order/restock-label.html);
// a type with none has no row then.
const label = (item) => ({
  seasonal: `Back in ${item.restockSeason || "spring"}`,
  soon: "Returning soon",
  hiatus: "On hiatus",
  discontinued: "Not available",
})[item.restock] || "";

// The rule: "orderable", "hidden", or the label of a row shown that
// can't be added. A count sells a product the catalog has in stock;
// one the catalog has out stays out whatever its count (#499), since
// the server's answer says so.
const want = (item, n, only) => {
  if (item.restock === "archived") return "hidden";
  if (n > 0 && item.inStock) return "orderable";

  return only ? "hidden" : label(item) || "hidden";
};

const row = (page, sku) => page.locator(`.order-item[data-sku="${sku}"]`);

// Every product at `n`, an archived one too: the page must hide it
// whatever its count.
const every = (n) => Object.fromEntries(items.map((i) => [i.sku, n]));

const check = async (page, n, only) => {
  for (const item of items) {
    const r = row(page, item.sku);
    const is = want(item, n, only);
    const why = `${item.sku} (${item.restock}) at ${n}`;

    if (is === "hidden") {
      await expect.soft(r, why).toBeHidden();
      continue;
    }
    await expect.soft(r, why).toBeVisible();
    if (is === "orderable") {
      await expect.soft(r.locator(".order-qty-add"), why).toBeVisible();
      await expect.soft(r.locator(".order-qty-add"), why).toBeEnabled();
      await expect.soft(r.locator(".order-qty-out"), why).toBeHidden();
    } else {
      await expect.soft(r.locator(".order-qty-out"), why).toHaveText(is);
      await expect.soft(r.locator(".order-qty-add"), why).toBeHidden();
    }
  }
};

test.describe("every catalog product's visibility (#501)", () => {
  for (const n of [0, 5]) {
    test.describe(`at ${n}`, () => {
      test.use({ stockPins: every(n) });

      test(`every product at ${n}, under In stock and Full catalog`,
        async ({ page }) => {
          const stock = page.waitForResponse("**/api/stock");

          await new OrderPage(page).open();
          await stock;

          const choice = (name) => page.getByRole("radio", { name });

          await expect(choice("In stock")).toBeChecked();
          await check(page, n, true);
          await choice("Full catalog").click();
          await expect(choice("Full catalog")).toBeChecked();
          await check(page, n, false);
        });
    });
  }
});
