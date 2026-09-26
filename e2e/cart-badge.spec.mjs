// AR-29 (#166): the header carries the cart's count, in the row and
// in the phone menu, hidden when the cart is empty. The count is the
// order page's own, read from the saved draft elsewhere, and it
// follows search's Add to cart and other tabs at once.
// docs/qa-launch.md, "The autumn refresh".
//
// #173: off the order page the row's count sits on the cart half of
// the Order button, which shows only while the cart holds something
// and opens a mini cart with the way to checkout; on the order page
// it stays on Order.

import { OrderPage, expect, test } from "./support/order.mjs";

const rowBadge = (page) => page
  .locator("header .site-actions [data-cart-badge]");
const cartHalf = (page) => page.locator("[data-cart-toggle]");
const menuBadge = (page) => page
  .locator("#site-menu .site-nav-link [data-cart-badge]");

test.describe("cart count on the Order link (#166)", () => {
  test("an empty cart shows no count", async ({ page }) => {
    await page.goto("/");

    for (const badge of await page.locator("[data-cart-badge]").all()) {
      await expect(badge).toBeHidden();
    }
    await expect(page.locator("a.site-order")).not.toHaveAttribute(
      "aria-label", /./
    );
  });

  test("the order page's count shows on every page, in the menu too",
    async ({ page, isMobile }) => {
      const order = new OrderPage(page);

      await order.open({ eggs: 3, wings: 2 });
      await expect(order.count).toHaveText("5 items");
      await expect(rowBadge(page)).toHaveText("5");

      await page.goto("/about/");
      await expect(rowBadge(page)).toHaveText("5");
      await expect(rowBadge(page)).toHaveAttribute("aria-hidden", "true");
      await expect(cartHalf(page)).toHaveAttribute(
        "aria-label", "Your cart, 5 items"
      );

      if (isMobile) {
        await page.locator("header .site-toggle").click();
        await expect(page.locator("#site-menu")).toBeVisible();
        await expect(menuBadge(page)).toHaveText("5");
      }

      // The badge sits over the corner: the row keeps its size.
      const width = await page.locator(".site-order").evaluate(
        (el) => el.getBoundingClientRect().width
      );

      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await expect(rowBadge(page)).toBeHidden();
      await expect(cartHalf(page)).toBeHidden();
      expect(await page.locator(".site-order").evaluate(
        (el) => el.getBoundingClientRect().width
      )).toBeCloseTo(width, 0);
    });

  test("search's Add to cart counts at once", async ({ page }) => {
    await page.goto("/about/");

    const dialog = page.locator("#search-palette");
    const stock = page.waitForResponse("**/api/stock");

    await page.locator("[data-search-open]").click();
    await stock;
    await dialog.locator("#search-palette-input").fill("eggs");
    await expect(dialog.locator("[data-search-card] [data-search-name]"))
      .toHaveText("Large");
    await dialog.getByRole("button", { name: "One more" }).click();
    await dialog.locator("[data-search-button]").click();
    await expect(dialog.locator("[data-search-added]")).toContainText(
      "2 items in your cart"
    );
    await expect(rowBadge(page)).toHaveText("2");
  });

  test("another tab's change arrives without a reload", async ({
    page, context,
  }) => {
    const order = new OrderPage(page);

    await order.open({ eggs: 1 });

    const other = await context.newPage();

    await other.goto("/about/");
    await expect(rowBadge(other)).toHaveText("1");

    const eggs = await order.showRow("eggs");

    await eggs.getByRole("button", { name: "One more" }).click();
    await expect(order.qty("eggs")).toHaveValue("2");
    await expect(rowBadge(other)).toHaveText("2");
  });

  test("the cart half lists the cart and goes on to checkout",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open({ eggs: 2 });
      await page.goto("/about/");
      await cartHalf(page).click();

      const mini = page.locator(".site-mini-cart");

      await expect(mini).toBeVisible();
      await expect(mini.locator(".site-mini-cart-line")).toHaveCount(1);
      await expect(mini.locator(".site-mini-cart-line"))
        .toContainText("× 2");
      await expect(mini.locator("[data-mini-cart-subtotal]"))
        .toHaveText(/^\$\d/);
      await mini.getByRole("link", { name: "Check out" }).click();
      await expect(page).toHaveURL(/\/order\/#details$/);
      await expect(order.count).toHaveText("2 items");
      await expect(page.locator("#details")).toBeInViewport();
    });

  test("blocked storage reads as an empty cart", async ({ page }) => {
    const errors = [];

    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("Storage is blocked.", "SecurityError");
        },
      });
    });
    await page.goto("/about/");
    await expect(page.locator("#search-palette")).toBeAttached();
    await expect(rowBadge(page)).toBeHidden();
    expect(errors).toEqual([]);
  });
});
