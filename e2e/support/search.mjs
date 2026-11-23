// The header's site search as a customer opens it (#402): from the
// banner's magnifier, at every width (#913).

import { expect } from "@playwright/test";

// The field: a combobox whose accessible name holds "Search".
export const searchField = (page) => page.getByRole("combobox",
  { name: /search/i });

// Opens search, types the query and waits for live stock, applied.
// -> the product option for `sku`, which may be absent.
export const findInSearch = async (page, query, sku) => {
  const field = searchField(page);
  const region = page.getByRole("search").filter({ has: field });

  await page.getByRole("banner")
    .getByRole("button", { name: /^(open |close )?search$/i }).click();
  await expect(field).toBeFocused();
  await field.fill(query);
  // The panel shows once the index is in and the query rendered, with
  // results or with none: a hidden product out of stock may leave none.
  await expect(region).toHaveAttribute("data-stock", "ready");
  await expect(region.locator("[data-find-panel]")).toBeVisible();

  return region.getByRole("option")
    .and(page.locator(`[data-sku="${sku}"]`));
};
