// The cart's one fold (#477, docs/cart.md 4.3 and 4.6): the pill opens
// and closes the floating pane, Escape closes it, an empty cart shows
// only the way and the code, and the first Add of a session opens the
// pane on the new line, closes it after the dwell and pulses the pill;
// a tap keeps it, a later Add shows the strip and pulses once. It sets
// its own sizes, so it runs in the desktop project only.

import {
  FULL_CART, OrderPage, expect, test, unfoldCart,
} from "./support/order.mjs";

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 1024 };

const hidden = (locator) => locator.evaluate((el) => (
  getComputedStyle(el).display === "none"
));

// ?add= settles the cart in the page; a scroll back up lifts it off
// closed. Floats it, open, at the catalog's top.
const floatOpen = async (page, order) => {
  await order.scrollSettled();
  await page.evaluate(() => window.scrollTo(0, 300));
  await order.scrollSettled();
  await expect(order.cart).toHaveAttribute("data-placement", "floating");
  await unfoldCart(order);
};

test.describe("the pill", () => {
  test("closes a phone's sheet to the total row and the foot", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);

    const order = new OrderPage(page);
    const pill = order.cart.locator("[data-cart-toggle]");

    await order.open(FULL_CART);
    await floatOpen(page, order);
    await expect(pill).toHaveAttribute("aria-expanded", "true");
    await expect(pill).toHaveText(/Hide/);

    await pill.click();
    await expect(order.cart).toHaveAttribute("data-fold", "closed");
    await expect(pill).toHaveAttribute("aria-expanded", "false");
    await expect(pill).toHaveText(/Expand/);
    await expect(pill).toBeFocused();
    // The total row and Proceed stay; the lines, the sums, the badges
    // and the shared row go.
    await expect(order.count).toBeVisible();
    await expect(order.total).toBeVisible();
    await expect(order.next).toBeVisible();
    expect(await hidden(order.cart.locator("[data-part='lines']"))).toBe(true);
    expect(await hidden(order.cart.locator("[data-part='sums']"))).toBe(true);
    expect(await hidden(order.cart.locator("[data-part='badges']"))).toBe(true);
    expect(await hidden(order.cart.locator("[data-part='share']"))).toBe(true);

    await pill.click();
    await expect(order.cart).toHaveAttribute("data-fold", "open");
    await expect(order.cart.locator("[data-part='lines']")).toBeVisible();
  });

  test("closes a tablet's panel to its right column", async ({ page }) => {
    await page.setViewportSize(TABLET);

    const order = new OrderPage(page);
    const pill = order.cart.locator("[data-cart-toggle]");

    await order.open(FULL_CART);
    await floatOpen(page, order);
    await pill.click();
    await expect(order.cart).toHaveAttribute("data-fold", "closed");
    expect(await hidden(order.cart.locator("[data-part='lines']"))).toBe(true);
    // The right column stays whole.
    await expect(order.subtotal).toBeVisible();
    await expect(order.cart.locator("[data-part='badges']")).toBeVisible();
    await expect(order.codeOpen).toBeVisible();
    await expect(order.next).toBeVisible();
  });

  test("Escape closes the floating pane and focuses the pill", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);

    const order = new OrderPage(page);
    const pill = order.cart.locator("[data-cart-toggle]");

    await order.open(FULL_CART);
    await floatOpen(page, order);
    await order.cart.locator("[data-remove]").first().focus();
    await page.keyboard.press("Escape");
    await expect(order.cart).toHaveAttribute("data-fold", "closed");
    await expect(pill).toBeFocused();
  });
});

test("empty, the pane shows the way and the code only", async ({ page }) => {
  await page.setViewportSize(PHONE);

  const order = new OrderPage(page);

  await order.open();
  await expect(order.cart).toHaveAttribute("data-empty", "");
  await page.evaluate(() => window.scrollTo(0, 300));
  await expect(order.cart).toHaveAttribute("data-placement", "floating");
  // A floating empty cart is closed; opening it shows the shared row
  // and no lines, sums or badges.
  await expect(order.cart).toHaveAttribute("data-fold", "closed");
  await order.cart.locator("[data-cart-toggle]").click();
  await expect(order.cart).toHaveAttribute("data-fold", "open");
  await expect(order.codeOpen).toBeVisible();
  await expect(order.cart.locator("[data-way-toggle]")).toBeVisible();
  expect(await hidden(order.cart.locator("[data-part='lines']"))).toBe(true);
  expect(await hidden(order.cart.locator("[data-part='sums']"))).toBe(true);
  expect(await hidden(order.cart.locator("[data-part='badges']"))).toBe(true);
  await expect(order.count).toHaveText("0 items");
  await expect(order.next).toBeDisabled();
});

test.describe("the first Add of a session", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.addInitScript(() => {
      try {
        sessionStorage.removeItem("nff-cart-first-add");
      } catch {
        // Blocked storage: the page counts the first Add itself.
      }
    });
  });

  test("opens the pane on the line, closes it and pulses the pill",
    async ({ page }) => {
      const order = new OrderPage(page);
      const pill = order.cart.locator("[data-cart-toggle]");

      await order.open();
      const row = await order.showRow("wings");

      await expect(order.cart).toHaveAttribute("data-placement", "floating");
      await row.locator(".order-qty-add").click();
      await expect(order.cart).toHaveAttribute("data-fold", "open");
      await expect(order.cart.locator("[data-remove]")).toBeVisible();
      // The pane shuts on its own after the dwell and the pill pulses.
      await expect(order.cart).toHaveAttribute("data-fold", "closed", {
        timeout: 6_000,
      });
      await expect(pill).toHaveAttribute("data-pulse", "teach");
      await expect(pill).not.toHaveAttribute("data-pulse", /./, {
        timeout: 6_000,
      });
    });

  test("a tap in the pane keeps it open", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open();
    const row = await order.showRow("wings");

    await row.locator(".order-qty-add").click();
    await expect(order.cart).toHaveAttribute("data-fold", "open");
    await order.cart.locator("[data-cart-count]").click();
    await page.waitForTimeout(4_500);
    await expect(order.cart).toHaveAttribute("data-fold", "open");
  });

  test("a later Add leaves the pane closed and shows the strip", async ({
    page,
  }) => {
    const order = new OrderPage(page);
    const pill = order.cart.locator("[data-cart-toggle]");
    const strip = order.cart.locator("[data-cart-added-box]");

    await order.open();
    let row = await order.showRow("wings");

    await row.locator(".order-qty-add").click();
    await expect(order.cart).toHaveAttribute("data-fold", "closed", {
      timeout: 6_000,
    });
    await expect(pill).not.toHaveAttribute("data-pulse", /./, {
      timeout: 6_000,
    });

    row = await order.showRow("eggs");
    await row.locator(".order-qty-add").click();
    await expect(order.cart).toHaveAttribute("data-fold", "closed");
    await expect(strip).toHaveAttribute("data-show", "");
    await expect(strip.locator("[data-cart-added]")).toHaveText(/Added: Eggs/);
    await expect(pill).toHaveAttribute("data-pulse", "once");
    await expect(order.cart.locator("[data-cart-live]"))
      .toHaveText(/Added Eggs.* to cart/);
    await expect(strip).not.toHaveAttribute("data-show", "", {
      timeout: 5_000,
    });
  });
});

test("with reduced motion the fold moves without easing", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: PHONE, reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const order = new OrderPage(page);
  const pill = order.cart.locator("[data-cart-toggle]");

  await order.open(FULL_CART);
  await floatOpen(page, order);
  await pill.click();
  await expect(order.cart).toHaveAttribute("data-fold", "closed");
  expect(await order.cart.evaluate((el) => el.getAnimations().length)).toBe(0);
  await context.close();
});
