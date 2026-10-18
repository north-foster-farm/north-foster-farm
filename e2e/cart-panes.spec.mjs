// The phone cart's panes (#267, orders' 778fd94 to 9c344db): the lines
// and the sums take turns, the whole pane stays within 60% of the
// screen either way, and the shared row's controls are one height
// whichever side shows. What a spec cannot reach is on a real iPhone:
// the keyboard riding the cart up (visualViewport), the notch's safe
// areas and how the glide feels.
// docs/qa-launch.md, OP-28.

import { FULL_CART, OrderPage, expect, test } from "./support/order.mjs";

const PHONE = { width: 390, height: 664 };
const TALL = { width: 390, height: 844 };

test.describe("cart panes on a phone", () => {
  test.use({ viewport: PHONE });

  test("opening the lines folds the sums, and the reverse", async ({
    page,
  }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);

    const cart = order.cart;
    const items = cart.locator("[data-cart-items-toggle]");
    const money = cart.locator("[data-cart-money-toggle]");

    // Start from both folded, then open each in turn.
    for (const toggle of [items, money]) {
      if ((await toggle.getAttribute("aria-expanded")) === "true") {
        await toggle.click();
      }
    }
    await expect(cart).toHaveAttribute("data-items", "closed");
    await expect(cart).toHaveAttribute("data-money", "closed");

    await items.click();
    await expect(cart).toHaveAttribute("data-items", "open");
    await expect(cart).toHaveAttribute("data-money", "closed");

    await money.click();
    await expect(cart).toHaveAttribute("data-money", "open");
    await expect(cart).toHaveAttribute("data-items", "closed");

    await money.click();
    await expect(cart).toHaveAttribute("data-money", "closed");
  });

  // The whole open pane, every row of it, not a part: the lines alone
  // stayed under the cap while the pane took 70% (#267).
  for (const size of [PHONE, TALL]) {
    test(`the open pane fits 60% of a ${size.height}px screen`, async ({
      page,
    }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open(FULL_CART);

      const cart = order.cart;
      const cap = size.height * 0.6 + 1;
      const items = cart.locator("[data-cart-items-toggle]");
      const money = cart.locator("[data-cart-money-toggle]");
      const hide = cart.locator("[data-cart-toggle]");

      if ((await hide.getAttribute("aria-expanded")) !== "true") {
        await hide.click();
      }

      for (const toggle of [items, money]) {
        if ((await toggle.getAttribute("aria-expanded")) !== "true") {
          await toggle.click();
        }
        await page.waitForTimeout(500);

        const b = await cart.boundingBox();

        expect(b).toBeTruthy();
        expect(b.height).toBeLessThanOrEqual(cap);
      }
    });
  }

  test("the shared row's controls are all 36px tall", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);
    await order.next.scrollIntoViewIfNeeded();

    const heights = (selectors) => Promise.all(selectors.map(async (sel) => {
      const el = order.cart.locator(sel).first();

      if (!(await el.isVisible())) return [sel, null];

      return [sel, (await el.boundingBox()).height];
    }));
    const sides = [
      [".order-cart-add-code", ".order-cart-pick"],
      [".order-cart-code-input", ".order-cart-apply"],
    ];

    for (const side of sides) {
      for (const [sel, h] of await heights(side)) {
        if (h !== null) expect(h, sel).toBeCloseTo(36, 0);
      }
    }

    const open = order.cart.locator("[data-code-toggle]");

    if (await open.isVisible()) await open.click();
    await page.waitForTimeout(300);

    for (const side of sides) {
      for (const [sel, h] of await heights(side)) {
        if (h !== null) expect(h, sel).toBeCloseTo(36, 0);
      }
    }
  });
});
