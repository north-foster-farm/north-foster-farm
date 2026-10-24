// The cart's open discount row under the iOS keyboard (#389). The
// keyboard shrinks the visual viewport and fires no window resize, so
// the pane's floor was never measured against the smaller room: the
// parts under the total row did not scroll and the row, Hide and
// Check out ran past the pane's foot. The spec plays the keyboard's
// part with a stand-in visual viewport that shrinks on cue.

import { FULL_CART, OrderPage, expect, test } from "./support/order.mjs";

const WIDTHS = [
  { width: 320, height: 664 },
  { width: 375, height: 667 },
  { width: 390, height: 664 },
];

for (const size of WIDTHS) {
  test.describe(`at ${size.width} px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(size);
      await page.addInitScript(() => {
        const real = window.visualViewport;
        const fake = new EventTarget();

        fake.kb = 0;
        Object.defineProperties(fake, {
          height: { get: () => real.height - fake.kb },
          width: { get: () => real.width },
          offsetTop: { get: () => real.offsetTop },
          offsetLeft: { get: () => 0 },
          scale: { get: () => 1 },
          pageTop: { get: () => real.pageTop },
          pageLeft: { get: () => 0 },
        });
        Object.defineProperty(window, "visualViewport", { get: () => fake });
        window.__keyboard = (n) => {
          fake.kb = n;
          fake.dispatchEvent(new Event("resize"));
        };
      });
    });

    test("the open row, Hide and Check out stay inside the pane",
      async ({ page }) => {
        const order = new OrderPage(page);

        await order.open(FULL_CART);
        await order.cart.locator("[data-code-toggle]").click();
        await page.evaluate(() => window.__keyboard(300));

        const pane = await order.cart.boundingBox();
        const inside = async (selector) => {
          const box = await order.cart.locator(selector).boundingBox();

          expect(box.y).toBeGreaterThanOrEqual(pane.y);
          expect(box.y + box.height).toBeLessThanOrEqual(
            pane.y + pane.height + 1
          );
        };

        await expect(order.cart.locator("[data-code-apply]")).toBeVisible();
        await inside("[data-field='code']");
        await inside("[data-code-apply]");
        await inside("[data-cart-toggle]");
        await inside("[data-checkout]");

        // Folded again, the pane returns to its usual shape.
        await page.evaluate(() => window.__keyboard(0));
        await page.keyboard.press("Escape");
        await expect(order.cart.locator("[data-share]"))
          .toHaveAttribute("data-share", "");
        await expect(order.cart).not.toHaveAttribute("data-tight", "");
      });
  });
}
