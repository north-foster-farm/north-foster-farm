// The cart's count and total share the top Show control's design (#392):
// the same track and fill, bigger and wider than it, short of the pane,
// and the amounts stay whole at 320. Written, not run on the runner.

import { FULL_CART, OrderPage, expect, test } from "./support/order.mjs";

const SIZES = [
  { width: 320, height: 700 },
  { width: 390, height: 800 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];

for (const size of SIZES) {
  test.describe(`at ${size.width} px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(size);
    });

    test("the cart's control wears the Show control's design", async ({
      page,
    }) => {
      const order = new OrderPage(page);

      await order.open(FULL_CART);

      const seg = order.cart.locator("[data-cart-seg]");
      const top = page.locator(".order-filter-seg");
      const style = (loc, prop) =>
        loc.evaluate((el, p) => getComputedStyle(el)[p], prop);

      // At 1280 the cart is a column and the control is plain text.
      if (size.width >= 1200) {
        await expect(seg).toHaveAttribute("data-plain", "");

        return;
      }

      for (const prop of ["backgroundColor", "boxShadow", "borderRadius"]) {
        expect(await style(seg, prop)).toBe(await style(top, prop));
      }

      const cart = await seg.boundingBox();
      const show = await top.boundingBox();
      const pane = await order.cart.boundingBox();

      expect(cart.height).toBeGreaterThan(show.height);
      expect(cart.width).toBeGreaterThan(show.width);
      expect(cart.width).toBeLessThanOrEqual(pane.width);
      expect(cart.width).toBeLessThanOrEqual(320 + 1);
    });

    test("the amount and the count are not clipped", async ({ page }) => {
      const order = new OrderPage(page);

      await order.open(FULL_CART);

      for (const part of ["items", "money"]) {
        const button = order.cart.locator(`[data-cart-${part}-toggle]`);
        const clipped = await button.evaluate(
          (el) => el.scrollWidth > el.clientWidth
        );

        expect(clipped).toBe(false);
      }
    });
  });
}

test.describe("the toggle still toggles on a phone", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
  });

  test("the tabs flip the view; a panel's readout does not", async ({
    page,
  }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);

    const money = order.cart.locator("[data-cart-money-toggle]");

    await money.click();
    await expect(money).toHaveAttribute("aria-expanded", "true");
    await money.focus();
    await expect(money).toBeFocused();

    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(order.cart.locator("[data-cart-seg]")).toHaveAttribute(
      "data-plain",
      ""
    );
    await expect(money).toBeDisabled();
  });

  test("the keyboard's focus ring still shows", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);

    const money = order.cart.locator("[data-cart-money-toggle]");

    await page.keyboard.press("Tab");
    await money.focus();
    await expect(money).toHaveCSS("outline-style", "solid");
    await expect(money).toHaveCSS("outline-width", "2px");
  });
});

test.describe("on a short viewport", () => {
  test("the toggle still flips the view", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 420 });

    const order = new OrderPage(page);

    await order.open(FULL_CART);

    const seg = order.cart.locator("[data-cart-seg]");

    if ((await seg.getAttribute("data-plain")) !== null) {
      return;
    }

    const money = order.cart.locator("[data-cart-money-toggle]");

    await money.click();
    await expect(money).toHaveAttribute("aria-expanded", "true");
  });
});

test.describe("a tablet's readout", () => {
  test("keeps the look and ignores taps", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });

    const order = new OrderPage(page);

    await order.open(FULL_CART);

    const seg = order.cart.locator("[data-cart-seg]");
    const top = page.locator(".order-filter-seg");

    await expect(seg).toHaveCSS("pointer-events", "none");
    await expect(seg).toHaveCSS(
      "background-color",
      await top.evaluate((el) => getComputedStyle(el).backgroundColor)
    );
    await expect(
      order.cart.locator("[data-cart-money-toggle]")
    ).toBeDisabled();
  });
});
