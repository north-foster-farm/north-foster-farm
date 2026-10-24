// The cart's open discount row under the iOS keyboard (#389). The
// keyboard shrinks the visual viewport and fires no window resize, so
// the pane's floor was never measured against the smaller room: the
// parts under the total row did not scroll and the row, Hide and
// Proceed to checkout ran past the pane's foot. The spec plays the keyboard's
// part with a stand-in visual viewport that shrinks on cue.

import { FULL_CART, OrderPage, expect, test } from "./support/order.mjs";

// Three phones, and one width of the panel (576 to 1199).
const WIDTHS = [
  { width: 320, height: 664 },
  { width: 375, height: 667 },
  { width: 390, height: 664 },
  { width: 768, height: 664 },
];

const INNER = ".order-cart-after > .order-cart-inner";

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
        window.__visualScroll = () => fake.dispatchEvent(new Event("scroll"));
      });
    });

    test("the open row, Hide and Proceed to checkout stay inside the pane",
      async ({ page }) => {
        const order = new OrderPage(page);

        await order.open(FULL_CART);

        // The pane's shape before the row opens is the one it returns to.
        const baseline = await order.cart.evaluate(
          (el) => el.hasAttribute("data-tight")
        );

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
        expect(await order.cart.evaluate(
          (el) => el.hasAttribute("data-tight")
        )).toBe(baseline);
      });

    test("a scroll after the row is open is not pulled back",
      async ({ page }) => {
        const order = new OrderPage(page);

        await order.open(FULL_CART);
        await order.cart.locator("[data-code-toggle]").click();
        await page.evaluate(() => window.__keyboard(300));

        const inner = order.cart.locator(INNER);
        const scrolls = await inner.evaluate(
          (el) => el.scrollHeight > el.clientHeight
        );

        // Not tight here (a roomier pane): nothing scrolls to test.
        test.skip(!scrolls, "the pane holds the row without scrolling");

        await inner.evaluate((el) => { el.scrollTop = 0; });
        await page.evaluate(() => window.__visualScroll());
        await page.evaluate(() => window.__keyboard(300));
        expect(await inner.evaluate((el) => el.scrollTop)).toBe(0);
      });
  });
}
