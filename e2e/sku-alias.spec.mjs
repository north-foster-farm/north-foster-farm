// SKUs renamed on 2026-10-21 (#267, docs/sku-map.csv). A past order's
// Reorder link and a saved cart still carry the old ones: the order
// page maps them to the new ones (data/skuAliases.json), names an
// archived one, and never shows a customer a raw SKU. An order holding
// an old SKU can't be changed, only cancelled (test/account.test.mjs
// holds the server's side).

import { CUSTOMER, ORDER, cannedDates } from "./support/canned.mjs";
import { OrderPage, expect, test } from "./support/order.mjs";

const OLD = "NFF-CHK-BRSBL-0000-0125";
const NEW = "NFF-CHK-BRSBL-10-12";
const qty = (page, sku) => page.locator(`[data-qty="${sku}"]`);

test.describe("old SKUs (#267)", () => {
  test("a Reorder link with an old SKU adds the product", async ({ page }) => {
    await page.goto(`/order/?add=${OLD}:2`);

    const notice = page.locator("#order-added");

    await expect(notice)
      .toHaveText("Added to your cart: 2 × Boneless Breasts, 1.0 – 1.2 lbs.");
    await expect(qty(page, NEW)).toHaveValue("2");
    await expect(new OrderPage(page).count).toHaveText("2 items");
  });

  test("an archived one is named, and an unknown one never shown",
    async ({ page }) => {
      await page.goto("/order/?add=NFF-CHK-CRN-0000-0300:1,NFF-CHK-NOPE:1");

      const notice = page.locator("#order-added");

      await expect(notice).toHaveText("No longer available: Cornish " +
        "Hens, under 3.0 lbs. Some items from that order have changed. " +
        "Please add them again.");
      await expect(notice).not.toContainText("NFF-");
    });

  test("a saved cart with an old SKU keeps the line", async ({ page }) => {
    await page.addInitScript(([sku]) => {
      if (sessionStorage.getItem("qa-seeded")) return;
      sessionStorage.setItem("qa-seeded", "1");
      localStorage.setItem("nff-order-draft", JSON.stringify({
        payload: { lines: [{ sku, qty: 3 }] }, savedAt: Date.now(),
      }));
    }, [OLD]);
    await page.goto("/order/");
    await expect(qty(page, NEW)).toHaveValue("3");
  });

  test("an order holding one offers Cancel, not a change",
    async ({ page }) => {
      const held = {
        ...ORDER,
        lines: [{ sku: OLD, label: "Boneless Breasts, 1.0 – 1.2 lbs",
          qty: 2, unitPrice: 15, lineTotal: 30 }],
        canChange: false,
      };

      await page.route("**/api/me", (route) => route.fulfill({
        json: { signedIn: true, customer: CUSTOMER },
      }));
      await page.route("**/api/account/orders", (route) => route.fulfill({
        json: { orders: [held] },
      }));
      await cannedDates(page);
      await page.goto("/account/#orders");

      const card = page.locator(`#order-${ORDER.id}`);

      await expect(card.getByRole("button", { name: "Cancel order" }))
        .toBeVisible();
      await expect(card.getByRole("link", { name: "Change items" }))
        .toHaveCount(0);
      await expect(card.getByRole("button", { name: "Change" }))
        .toHaveCount(0);
    });
});
