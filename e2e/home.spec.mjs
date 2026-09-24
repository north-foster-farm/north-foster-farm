// The home page as the home lane lands it. docs/qa-launch.md, "The
// autumn refresh".

import { expect, test } from "./support/order.mjs";

const INVOICE_ERA = /invoice|payment link|pay to confirm/i;

test.describe("home", () => {
  // James's wording, 2026-09-24 (#150).
  test("How to buy walks four steps without the invoice era",
    async ({ page }) => {
      await page.goto("/");

      const how = page.locator("#how-to-buy");
      const steps = how.locator(".how-step");

      await expect(how.locator(".home-title"))
        .toHaveText("From our pasture to your table");
      await expect(how.locator(".how-step-title")).toHaveText([
        "Step 1: Shop one page",
        "Step 2: Choose your day",
        "Step 3: Make a change",
        "Step 4: Pick up or delivery",
      ]);
      await expect(steps).toHaveCount(4);
      for (const step of await steps.all()) {
        await expect(step.locator(".home-icon svg")).toBeVisible();
      }
      expect(await how.innerText()).not.toMatch(INVOICE_ERA);

      await how.getByRole("link", { name: "Shop all products" }).click();
      await expect(page).toHaveURL(/\/order\/$/);
    });
});
