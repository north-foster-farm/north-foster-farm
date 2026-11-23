// Criteria test for #908 (Order page: follow stock within seconds while
// a customer is browsing), box 6: search and the order page agree. The
// other tested boxes are unit tests, test/stock-follow.criteria.mjs;
// this one needs search running in the page. The clock is faked.
//
// Provisional, as James has not yet picked among the issue's choices:
// the chosen time is the proposal's 15 seconds (EVERY). The test opens
// search on the order page while an item is in stock, then the item
// sells out; within EVERY, plus a second's slack, the order page shows
// it out and search, opened again, shows it out too.
//
// Held out of every run by its name until the change lands: renamed to
// stock-follow.spec.mjs and added to e2e/dispatch.json beside
// search-stock.spec.mjs.
//
// The seam, as search-stock.spec.mjs's: the field is a combobox named
// "Search" in a `role="search"` landmark, opened below 992 px by the
// banner's "Search" button; a product option carries `data-sku`, and
// `data-stock="out"` while out; the landmark says `data-stock="ready"`
// once live stock is applied. An order row is `.order-item[data-sku]`,
// marked `data-out` while out.

import { readFileSync } from "node:fs";

import { expect, SKU, test } from "./support/order.mjs";

const EVERY = 15_000;
const SLACK = 1_000;

const catalog = JSON.parse(readFileSync(
  new URL("../data/catalog.json", import.meta.url), "utf8"
));
const THIGHS = SKU.thighs;
const name = catalog.groups.flatMap((g) => g.items)
  .find((i) => i.sku === THIGHS).name;

test.afterEach(({ page }) => page.unrouteAll({ behavior: "ignoreErrors" }));

// Search opened as a customer opens it, the query typed and live stock
// in. -> the field, and the product option for THIGHS.
const search = async (page) => {
  const field = page.getByRole("combobox", { name: /search/i });
  const region = page.getByRole("search").filter({ has: field });

  if (page.viewportSize().width >= 992) {
    await field.click();
  } else {
    await page.getByRole("banner")
      .getByRole("button", { name: /search/i }).click();
  }
  await field.fill(name);
  await expect(region).toHaveAttribute("data-stock", "ready");

  return {
    field,
    option: region.getByRole("option")
      .and(page.locator(`[data-sku="${THIGHS}"]`)),
  };
};

test("Search and the order page agree: neither shows an item in stock "
  + "that the other shows out, beyond the chosen time", async ({ page }) => {
  let over = {};

  await page.clock.install();
  await page.route("**/api/stock", async (route) => {
    const res = await route.fetch();
    const body = await res.json();

    Object.assign(body.items, over);
    await route.fulfill({ response: res, json: body });
  });
  await page.goto("/order/");

  const row = page.locator(`.order-item[data-sku="${THIGHS}"]`);

  await expect(row).not.toHaveAttribute("data-out");

  const first = await search(page);

  await expect(first.option).toBeVisible();
  await expect(first.option).not.toHaveAttribute("data-stock", "out");
  await first.field.press("Escape");

  over = { [THIGHS]: { inStock: false, available: 0 } };
  await page.clock.fastForward(EVERY + SLACK);

  await expect(row, "the order page shows it out")
    .toHaveAttribute("data-out", "", { timeout: 5_000 });

  const again = await search(page);

  await expect(again.option, "search shows it out")
    .toHaveAttribute("data-stock", "out");
});
