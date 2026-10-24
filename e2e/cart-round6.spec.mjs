// The mid-size cart, #274 round 6: from 576 to 1199 px the floating cart
// is a panel at the bottom right of the content column, half its width
// shut, with its right column only; Expand widens it leftward to the
// column's full width for the lines, grouped, and the right column
// does not move. It sets its own sizes, so it runs in the desktop
// project only.

import { FULL_CART, OrderPage, expect, test } from "./support/order.mjs";

const WIDTHS = [
  { width: 576, height: 900 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1199, height: 900 },
];

const box = async (locator) => {
  const b = await locator.boundingBox();

  if (!b) throw new Error(`${locator} has no box`);

  return { ...b, right: b.x + b.width, bottom: b.y + b.height };
};

// Floats the cart over the catalog: the top of the page, where its own
// place in the flow is further down.
const float = async (page, order) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await order.scrollSettled();
  await expect(order.cart).toHaveAttribute("data-stuck", "true");
  await expect(order.cart).toHaveAttribute("data-open", "true");
};

// The width eases; wait for it to land.
const eased = (page) => page.waitForTimeout(700);

for (const size of WIDTHS) {
  test.describe(`at ${size.width} px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(size);
    });

    test("shut, the panel is the right half of the column", async ({
      page,
    }) => {
      const order = new OrderPage(page);
      const toggle = order.cart.locator("[data-cart-toggle]");

      await order.open(FULL_CART);
      await float(page, order);
      await expect(order.cart).toHaveAttribute("data-items", "closed");
      await expect(toggle).toHaveText("Expand");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(order.cart.locator("[data-cart-items]")).toBeHidden();

      const form = await box(page.locator("#order-form"));
      const cart = await box(order.cart);

      // At the column's right edge, about half its width (never under
      // 22rem, so the way and the code fit side by side).
      expect(Math.abs(cart.right - form.right)).toBeLessThanOrEqual(1);
      expect(cart.width).toBeGreaterThanOrEqual(
        Math.min(form.width, Math.max(form.width / 2, 352)) - 2
      );
      expect(cart.width).toBeLessThanOrEqual(form.width * 0.66);
      // The catalog stays in view above it.
      expect(cart.y).toBeGreaterThan(size.height * 0.4);
    });

    test("Expand widens it leftward and moves nothing on the right",
      async ({ page }) => {
        const order = new OrderPage(page);
        const toggle = order.cart.locator("[data-cart-toggle]");

        await order.open(FULL_CART);
        await float(page, order);

        const shut = {
          next: await box(order.next),
          total: await box(order.total),
          cart: await box(order.cart),
        };

        await toggle.click();
        await eased(page);
        await expect(order.cart).toHaveAttribute("data-items", "open");
        await expect(toggle).toHaveText("Hide");
        await expect(toggle).toHaveAttribute("aria-expanded", "true");

        const open = {
          next: await box(order.next),
          total: await box(order.total),
          cart: await box(order.cart),
        };
        const form = await box(page.locator("#order-form"));

        // Full width of the column, grown to the left.
        expect(Math.abs(open.cart.x - form.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(open.cart.right - shut.cart.right))
          .toBeLessThanOrEqual(1);
        // The right column stays where it was, to the pixel or two;
        // only the height may change with a longer foot.
        for (const part of ["next", "total"]) {
          expect(Math.abs(open[part].x - shut[part].x)).toBeLessThanOrEqual(2);
          expect(Math.abs(open[part].right - shut[part].right))
            .toBeLessThanOrEqual(2);
        }
        // The lines, grouped, each with a remove, quantity and total.
        await expect(order.cart.locator(".order-cart-group-name").first())
          .toBeVisible();

        const line = order.cart.locator(".order-cart-item").first();

        await expect(line.locator(".order-cart-remove")).toBeVisible();
        await expect(line.locator(".order-cart-item-qty")).toBeVisible();
        await expect(line.locator(".order-cart-item-sub")).toBeVisible();
        // Left of the right column.
        expect((await box(line)).right).toBeLessThanOrEqual(open.total.x);
      });

    test("a long list scrolls inside the left column", async ({ page }) => {
      const order = new OrderPage(page);

      await order.open(FULL_CART);
      await float(page, order);
      await order.cart.locator("[data-cart-toggle]").click();
      await eased(page);

      const list = order.cart.locator("[data-cart-items]");
      const room = await list.evaluate((el) => ({
        scroll: el.scrollHeight, client: el.clientHeight,
      }));

      expect(room.scroll).toBeGreaterThan(room.client);

      const cart = await box(order.cart);

      // About half the screen at most; the catalog shows above it.
      expect(cart.y).toBeGreaterThan(size.height * 0.3);
    });

    test("Expand and Hide: Tab reaches it, the focus stays, "
      + "aria-expanded follows", async ({ page }) => {
      const order = new OrderPage(page);
      const toggle = order.cart.locator("[data-cart-toggle]");

      await order.open(FULL_CART);
      await float(page, order);
      await toggle.focus();
      await expect(toggle).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(toggle).toBeFocused();
      await page.keyboard.press("Space");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toBeFocused();
    });

    test("reduced motion: the panel widens without a transition", async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });

      const order = new OrderPage(page);

      await order.open(FULL_CART);
      await float(page, order);
      expect(await order.cart.evaluate(
        (el) => getComputedStyle(el).transitionProperty
      )).toBe("none");
    });
  });
}

test("below 576 the cart is the sheet it was", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const order = new OrderPage(page);
  const toggle = order.cart.locator("[data-cart-toggle]");

  await order.open(FULL_CART);
  await float(page, order);
  await toggle.click();
  await expect(order.cart).toHaveAttribute("data-open", "false");
  await toggle.click();
  await expect(order.cart).toHaveAttribute("data-open", "true");
});

test("a short viewport keeps the settled cart", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });

  const order = new OrderPage(page);

  await order.open(FULL_CART);
  await page.evaluate(() => window.scrollTo(0, 0));
  await order.scrollSettled();
  await expect(order.cart).toHaveAttribute("data-stuck", "false");
});

// The count and total are a readout in a panel: no role, no focus
// stop, no slide. Expand and Hide are its one control.
for (const size of WIDTHS) {
  test(`at ${size.width} px the count and total are not controls`, async ({
    page,
  }) => {
    await page.setViewportSize(size);

    const order = new OrderPage(page);

    await order.open(FULL_CART);
    await float(page, order);
    await eased(page);

    const parts = order.cart.locator(".order-cart-disclose");

    await expect(parts).toHaveCount(2);
    for (const part of await parts.all()) {
      await expect(part).toBeDisabled();
      await expect(part).toHaveAttribute("role", "presentation");
      await expect(part).not.toHaveAttribute("aria-expanded", /.*/);
      await expect(part).not.toHaveAttribute("tabindex", /.*/);
    }
    await expect(order.cart.getByRole("button", { name: /items$/ }))
      .toHaveCount(0);
    await expect(order.cart.getByRole("button", { name: /^Total/ }))
      .toHaveCount(0);
    await expect(order.cart.locator("[data-cart-count]")).toBeVisible();
    await expect(order.cart.locator("[data-total=total]")).toBeVisible();
    await expect(order.cart.locator("[data-cart-toggle]")).toBeEnabled();
  });
}

// The lines' "N more" pills come back in the panel's items column
// while the list overflows, and follow its scroll.
for (const size of [WIDTHS[1], WIDTHS[2]]) {
  test(`at ${size.width} px a long list shows its "more" pills`, async ({
    page,
  }) => {
    await page.setViewportSize(size);

    const order = new OrderPage(page);

    await order.open({
      eggs: 2, wings: 2, thighs: 2, drums: 1, breasts: 1, sausage: 1,
      necks: 3,
    });
    await float(page, order);
    await order.cart.locator("[data-cart-toggle]").click();
    await eased(page);

    const below = order.cart.locator("[data-cart-more]");
    const above = order.cart.locator("[data-cart-more-top]");

    await expect(below).toBeVisible();
    await expect(below).toHaveText(/^\d+ more ↓$/);
    await expect(above).toBeHidden();
    await order.cart.locator("[data-cart-items]").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(above).toBeVisible();
    await expect(above).toHaveText(/^\d+ more ↑$/);
    await expect(below).toBeHidden();
  });
}

// An Add to a cart that loaded empty shows the panel at once, not the
// total row alone, whose Expand then has no lines to fold, until the
// first scroll (#274, round 6, James's bug). Not the session's first
// Add, which opens the lines on its own.
for (const size of WIDTHS) {
  test(`at ${size.width} px an Add to an empty cart shows the panel`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.addInitScript(() => {
      sessionStorage.setItem("nff-cart-first-add", "1");
    });

    const order = new OrderPage(page);
    const toggle = order.cart.locator("[data-cart-toggle]");

    await order.open();
    await expect(order.cart).toHaveAttribute("data-stuck", "true");
    await page.evaluate(() => {
      for (const b of document.querySelectorAll(".order-qty-add")) {
        if (!b.disabled) {
          b.click();
          break;
        }
      }
    });
    await expect(order.cart).toHaveAttribute("data-open", "true");
    await expect(order.cart).toHaveAttribute("data-items", "closed");
    await expect(toggle).toHaveText("Expand");
    await toggle.click();
    await expect(order.cart).toHaveAttribute("data-items", "open");
    await expect(order.cart.locator("[data-cart-items]")).toBeVisible();
  });
}
