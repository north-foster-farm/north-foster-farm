// The cart as a screen reader and a keyboard meet it (#477, docs/cart.md
// 4.7): named by its heading; the pill the one disclosure, with the
// state it controls; the count and total text; hidden parts out of the
// tab order; the shared row's buttons saying what is open; the live
// regions polite; the rings inside the body whole. Runs in the phone
// and desktop projects, and in WebKit as the iphone project.

import {
  FULL_CART, OrderPage, expect, foldCart, test, unfoldCart,
} from "./support/order.mjs";

const PHONE = { width: 390, height: 844 };

// ?add= settles the cart in the page; a scroll back up lifts it off
// closed. Floats it, closed, at the catalog's top.
const float = async (page, order) => {
  await order.scrollSettled();
  await page.evaluate(() => window.scrollTo(0, 300));
  await order.scrollSettled();
  await expect(order.cart).toHaveAttribute("data-placement", "floating");
};

test("the pane is named by its heading and its controls say their state",
  async ({ page }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);
    await expect(order.cart).toHaveAttribute("aria-labelledby",
      "order-cart-heading");
    await expect(order.cart).toHaveAttribute("tabindex", "-1");

    const pill = order.cart.locator("[data-cart-toggle]");

    await expect(pill).toHaveAttribute("aria-controls", "order-cart-body");
    // The count and the total are text, not controls.
    expect(await order.count.evaluate((el) => el.tagName)).not.toBe("BUTTON");
    expect(await order.total.evaluate((el) => el.closest("button"))).toBeNull();
    // The live regions.
    await expect(order.cart.locator("[data-cart-live]"))
      .toHaveAttribute("role", "status");
    await expect(order.nudge).toHaveAttribute("aria-live", "polite");
    await expect(order.codeNote).toHaveAttribute("aria-live", "polite");
  });

test("the shared row's buttons say which side is open", async ({ page }) => {
  const order = new OrderPage(page);
  const way = order.cart.locator("[data-way-toggle]");

  await order.open(FULL_CART);
  await expect(way).toHaveAttribute("aria-expanded", "false");
  await expect(order.codeOpen).toHaveAttribute("aria-expanded", "false");

  await order.codeOpen.click();
  await expect(order.cart).toHaveAttribute("data-share", "code");
  await expect(order.codeOpen).toHaveAttribute("aria-expanded", "true");
  await expect(order.codeInput).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(order.cart).toHaveAttribute("data-share", "");
  await expect(order.codeOpen).toBeFocused();

  await way.click();
  await expect(order.cart).toHaveAttribute("data-share", "way");
  await expect(way).toHaveAttribute("aria-expanded", "true");
  await expect(order.cart.locator("[data-way][aria-pressed='true']"))
    .toBeFocused();
});

test.describe("on a phone", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
  });

  test("a closed sheet keeps only the foot in the tab order", async ({
    page,
  }) => {
    const order = new OrderPage(page);
    const pill = order.cart.locator("[data-cart-toggle]");

    await order.open(FULL_CART);
    await float(page, order);
    await foldCart(page, order.cart);
    await expect(pill).toHaveAttribute("aria-expanded", "false");

    // Every focusable control inside the pane that can take focus now.
    const reachable = await order.cart.evaluate((el) => Array.from(
      el.querySelectorAll("button, input, [tabindex]:not([tabindex='-1'])")
    ).filter((c) => c.offsetParent !== null && !c.disabled)
      .map((c) => c.getAttribute("data-cart-toggle") !== null ? "pill"
        : c.getAttribute("data-checkout") !== null ? "next"
          : c.className));

    expect(reachable).toEqual(["pill", "next"]);
    await pill.focus();
    await page.keyboard.press("Tab");
    await expect(order.next).toBeFocused();
  });

  test("the rings inside the body are drawn inside", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);
    await float(page, order);
    await unfoldCart(order);
    await order.codeOpen.click();
    await order.codeInput.focus();
    expect(await order.codeInput.evaluate((el) => (
      getComputedStyle(el).boxShadow
    ))).toContain("inset");
    await page.keyboard.press("Tab");
    await expect(order.codeApply).toBeFocused();
    expect(await order.codeApply.evaluate((el) => (
      getComputedStyle(el).boxShadow
    ))).toContain("inset");
  });

  test("a control focused under the floating pane is scrolled clear",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open(FULL_CART);
      await order.scrollSettled();
      await page.evaluate(() => window.scrollTo(0, 0));
      await order.scrollSettled();
      await expect(order.cart).toHaveAttribute("data-placement", "floating");

      // A row under the pane: focus its Add (hidden from the
      // accessibility tree, so by class) and it comes up clear.
      const add = order.item("drums").locator(".order-qty-add");

      await order.item("drums").evaluate((el) => {
        el.scrollIntoView({ block: "end", behavior: "instant" });
      });
      await add.focus();
      await page.waitForTimeout(100);

      const row = await add.evaluate((el) => el.getBoundingClientRect().bottom);
      const pane = await order.cart.evaluate((el) => (
        el.getBoundingClientRect().top
      ));

      expect(row).toBeLessThanOrEqual(pane + 1);
    });
});
