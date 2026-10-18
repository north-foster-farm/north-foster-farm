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

  test("the count and the total are tabs that take turns", async ({
    page,
  }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);

    const cart = order.cart;
    const items = cart.getByRole("tab", { name: /items?$/ });
    const money = cart.getByRole("tab", { name: /^Total/ });

    await expect(cart.getByRole("tablist", { name: "Cart view" }))
      .toBeVisible();
    await expect(items).toHaveAttribute("aria-selected", "true");
    await expect(money).toHaveAttribute("aria-selected", "false");
    await expect(cart).toHaveAttribute("data-items", "open");
    await expect(cart).toHaveAttribute("data-money", "closed");

    await money.click();
    await expect(money).toHaveAttribute("aria-selected", "true");
    await expect(items).toHaveAttribute("aria-selected", "false");
    await expect(cart).toHaveAttribute("data-money", "open");
    await expect(cart).toHaveAttribute("data-items", "closed");

    // One side is always showing: a second tap on it changes nothing.
    await money.click();
    await expect(cart).toHaveAttribute("data-money", "open");

    // Arrows move the pick and the focus; only the pick is a tab stop.
    await money.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(items).toBeFocused();
    await expect(items).toHaveAttribute("aria-selected", "true");
    await expect(items).toHaveAttribute("tabindex", "0");
    await expect(money).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("End");
    await expect(money).toBeFocused();
    await expect(cart).toHaveAttribute("data-money", "open");
  });

  test("the fill slides under the side that shows", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);

    const cart = order.cart;
    const fill = cart.locator(".order-cart-seg-fill");
    const seg = cart.locator("[data-cart-seg]");
    const half = async () => {
      const f = await fill.boundingBox();
      const t = await seg.boundingBox();

      return { left: f.x - t.x, width: f.width, track: t.width };
    };

    const left = await half();

    expect(left.left).toBeCloseTo(0, 0);
    expect(left.width).toBeCloseTo(left.track / 2, 0);

    await cart.getByRole("tab", { name: /^Total/ }).click();
    await page.waitForTimeout(600);

    const right = await half();

    expect(right.left).toBeCloseTo(right.track / 2, 0);
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
        await toggle.click();
        await page.waitForTimeout(500);

        const b = await cart.boundingBox();

        expect(b).toBeTruthy();
        expect(b.height).toBeLessThanOrEqual(cap);
      }
    });
  }

  test("the more pills never sit over a heading or a line", async ({
    page,
  }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);

    const cart = order.cart;
    const list = cart.locator("[data-cart-items]");
    const down = cart.locator("[data-cart-more]");
    const up = cart.locator("[data-cart-more-top]");

    const apart = async (pill) => {
      const l = await list.boundingBox();
      const p = await pill.boundingBox();

      expect(p.y).toBeGreaterThanOrEqual(l.y + l.height - 1);
    };

    await expect(down).toBeVisible();
    await apart(down);

    await list.evaluate((el) => { el.scrollTop = 140; });
    await expect(up).toBeVisible();
    await apart(up);
    await apart(down);
  });

  test("the badges show only for a delivery, on two lines", async ({
    page,
  }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);

    const badges = order.cart.locator(".order-badges");

    await expect(badges).toBeHidden();

    await order.method("scituate");
    await expect(badges).toBeHidden();

    await order.method("delivery");
    await expect(badges).toBeVisible();

    // Two lines of 0.7rem text, not a run that wraps three or four.
    const b = await badges.boundingBox();

    expect(b.height).toBeLessThan(2.5 * 0.7 * 16 * 1.4);
  });

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
