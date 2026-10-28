// A paid order that holds an archived variation (#267, 6305650920):
// changing it shows the line under "Not available", where it
// can fall but never rise, rather than dropping it and refunding it on
// save. The server holds the same rule (test/edit.test.mjs). The
// account is canned, so this runs on a local build.

import { CUSTOMER, ORDER, cannedDates } from "./support/canned.mjs";
import { SUITE_STOCK, expect, test } from "./support/order.mjs";

const HEN = "NFF-CHK-CRN-0000-0300";

// The hen pinned at none (#507): an archived line is never sold
// whatever the count, and the spec reads no count it didn't set.
test.use({ stockPins: { ...SUITE_STOCK, [HEN]: 0 } });
const HELD = {
  ...ORDER,
  lines: [...ORDER.lines, {
    sku: HEN, label: "Cornish Hens, under 3.0 lbs", qty: 1,
    unitPrice: 20, lineTotal: 20,
  }],
  totals: { ...ORDER.totals, subtotal: 3400, total: 3400 },
};

const row = (page) => page.locator(`.order-item[data-sku="${HEN}"]`);

test.describe("an archived line in a paid order (#267)", () => {
  test("is hidden on a new order, with no sidebar link", async ({ page }) => {
    // Listen before the page loads: on a quick server the stock has
    // answered before goto returns.
    const stock = page.waitForResponse("**/api/stock");

    await page.goto("/order/");
    await stock;
    await page.getByRole("radio", { name: "Full catalog" }).click();
    await expect(row(page)).toBeHidden();
    await expect(page.locator("#cat-archived")).toBeHidden();
    await expect(page.locator("#order-nav a[href='#cat-archived']"))
      .toHaveCount(0);
  });

  test("shows while changing the order, and can fall but never rise",
    async ({ page }) => {
      await page.route("**/api/me", (route) => route.fulfill({
        json: { signedIn: true, customer: CUSTOMER },
      }));
      await page.route("**/api/account/orders", (route) => route.fulfill({
        json: { orders: [HELD] },
      }));
      await cannedDates(page);

      const stock = page.waitForResponse("**/api/stock");

      await page.goto(`/order/?edit=${ORDER.id}`);
      await stock;

      const r = row(page);
      const qty = r.locator("[data-qty]");

      await expect(page.locator("#cat-archived")).toBeVisible();
      await expect(page.locator("#cat-archived-h"))
        .toHaveText("Not available");
      await expect(r).toBeVisible();
      await expect(r.locator("label"))
        .toHaveText("Cornish Hens, under 3.0 lbs");
      await expect(r.locator(".order-item-stock"))
        .toHaveText("Not available");
      await expect(qty).toHaveValue("1");

      // By keyboard: on a phone the open cart covers the row.
      await r.getByRole("button", { name: "One more" }).press("Enter");
      await expect(qty).toHaveValue("1");

      await r.getByRole("button", { name: "Remove" }).press("Enter");
      await expect(qty).toHaveValue("0");
      await expect(r).toBeVisible();
    });
});
