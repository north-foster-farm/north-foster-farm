// The cart's way picker on Safari (#383). Safari does not focus a
// button it taps, so a tap on a pick focused the cart itself
// (tabindex -1), the focus counted as a tap away, the row folded and
// the click landed on the row, not the pick. Chromium focuses the
// button, so the spec plays Safari's part: a mousedown on a button
// focuses the nearest focusable ancestor and the button keeps no focus.

import { FULL_CART, OrderPage, expect, test } from "./support/order.mjs";

const WIDTHS = [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];

const WAYS = [
  { way: "delivery", name: "Delivery" },
  { way: "onfarm", name: "On-farm pickup" },
  { way: "delivery", name: "Delivery" },
];

for (const size of WIDTHS) {
  test.describe(`at ${size.width} px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(size);
    });

    test("each way can be picked from the cart, Safari style",
      async ({ page }) => {
        const order = new OrderPage(page);

        await order.open(FULL_CART);
        await page.evaluate(() => {
          document.addEventListener("mousedown", (e) => {
            const button = e.target.closest("button");

            if (!button) return;
            e.preventDefault();
            button.closest("[tabindex]").focus({ preventScroll: true });
          }, true);
        });

        for (const { way, name } of WAYS) {
          await order.cart.locator("[data-way-toggle]").click();
          await order.cart.locator(`[data-way='${way}']`).click();
          await expect(page.locator(`[name='method'][value='${way}']`))
            .toBeChecked();
          await expect(order.cart.locator("[data-way-name]"))
            .toHaveText(name);
          await expect(order.cart.locator("[data-share]"))
            .toHaveAttribute("data-share", "");
        }
      });
  });
}
