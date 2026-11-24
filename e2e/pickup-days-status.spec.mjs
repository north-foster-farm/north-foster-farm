// Copy's "Copied" is announced (#703, qa on #720). A focused button's
// new name often goes unread (NVDA doesn't read it), so each pickup
// card carries a visually hidden status (WCAG 2.2, 4.1.3) that Copy
// fills with "Copied" and empties when the button reads Copy again.
// The three homes share the card (partials/order/pickup-days.html),
// so the order page's Pickup days card stands for all of them.

import { OrderPage, expect, test } from "./support/order.mjs";
import { DROP, cannedScheduled, datesWith } from "./support/scheduled.mjs";

test.describe("Copy's Copied is announced (#703)", () => {
  test("a hidden status says Copied, then empties", async ({ page }) => {
    const lists = datesWith([{ place: DROP, days: [3, 10] }]);

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => {} },
      });
    });
    await cannedScheduled(page, lists);
    await new OrderPage(page).open({ eggs: 1 }, { method: "scheduled" });

    const pickup = page.locator("#scheduled-pickups .order-pickup").first();
    const status = pickup.getByRole("status");

    await expect(pickup).toBeVisible();
    await expect(status).toHaveCount(1);
    await expect(status).toHaveClass(/\bvisually-hidden\b/);
    await expect(status).toHaveText("");

    await pickup.getByRole("button", { name: "Copy" }).click();
    await expect(status).toHaveText("Copied");
    await expect(status).toHaveText("", { timeout: 6000 });
    await expect(pickup.getByRole("button", { name: "Copy" }))
      .toBeVisible();
  });
});
