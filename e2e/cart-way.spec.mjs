// The cart's shared row (#203, #477): the way and Add discount side by
// side, each opening over the whole row. A pick sets the page's method
// without scrolling it; a code is applied, refused or taken off; a
// tap or focus outside the row, or Escape, folds it back. Safari does
// not focus a button it taps (#383), so the Safari case plays that
// part in Chromium.

import {
  FULL_CART, OrderPage, expect, test, unfoldCart as unfold,
} from "./support/order.mjs";

const SIZES = [
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

for (const size of SIZES) {
  test.describe(`at ${size.width} px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(size);
    });

    test("each way can be picked from the cart, Safari style",
      async ({ page }) => {
        const order = new OrderPage(page);

        await order.open(FULL_CART);
        await unfold(order);
        await page.evaluate(() => {
          document.addEventListener("mousedown", (e) => {
            const button = e.target.closest("button");

            if (!button) return;
            e.preventDefault();
            button.closest("[tabindex]").focus({ preventScroll: true });
          }, true);
        });

        for (const { way, name } of WAYS) {
          const before = await page.evaluate(() => window.scrollY);

          await order.cart.locator("[data-way-toggle]").click();
          await expect(order.cart).toHaveAttribute("data-share", "way");
          await order.cart.locator(`[data-way='${way}']`).click();
          await expect(page.locator(`[name='method'][value='${way}']`))
            .toBeChecked();
          await expect(order.cart.locator("[data-way-name]"))
            .toHaveText(name);
          await expect(order.cart).toHaveAttribute("data-share", "");
          // The customer is in the cart, not at the section (#203).
          expect(await page.evaluate(() => window.scrollY)).toBe(before);
        }
      });

    test("the page's own choice shows in the cart, and the link wins",
      async ({ page }) => {
        const order = new OrderPage(page);

        await order.open({ wings: 2 }, { method: "scheduled" });
        await expect(order.cart.locator("[data-way-name]"))
          .toHaveText("Pickup days");
        await page.reload();
        await expect(page.locator("#onfarm-date")).toBeEnabled();
        await expect(order.cart.locator("[data-way-name]"))
          .toHaveText("Pickup days");

        // ?method= from the home page's links beats the remembered way.
        await page.goto("/order/?method=delivery");
        await expect(page.locator("#onfarm-date")).toBeEnabled();
        await expect(page.locator("#method-delivery")).toBeChecked();
        await expect(order.cart.locator("[data-way-name]"))
          .toHaveText("Delivery");
      });

    test("a tap outside the open row folds it, Escape too, and the "
      + "focus returns", async ({ page }) => {
      const order = new OrderPage(page);
      const toggle = order.cart.locator("[data-way-toggle]");

      await order.open(FULL_CART);
      await unfold(order);
      await toggle.click();
      await expect(order.cart).toHaveAttribute("data-share", "way");
      await expect(order.cart.locator("[data-way][aria-pressed='true']"))
        .toBeFocused();
      await page.keyboard.press("Escape");
      await expect(order.cart).toHaveAttribute("data-share", "");
      await expect(toggle).toBeFocused();
      // Escape with the row shut folds the floating cart, not the row.
      await expect(order.cart).toHaveAttribute("data-fold", "open");

      await order.codeOpen.click();
      await expect(order.cart).toHaveAttribute("data-share", "code");
      await expect(order.codeInput).toBeFocused();
      await page.locator("h1").first().click();
      await expect(order.cart).toHaveAttribute("data-share", "");
    });

    test("a code is refused, applied and taken off", async ({ page }) => {
      const order = new OrderPage(page);

      await order.open({ wings: 5 }, { method: "delivery" });
      await unfold(order);
      await order.codeOpen.click();
      await order.codeInput.fill("nosuchcode");
      await order.codeApply.click();
      await expect(order.codeNote).toHaveText("That code isn't valid.");
      await expect(order.codeInput).toHaveValue("NOSUCHCODE");
      await expect(order.cart).toHaveAttribute("data-share", "code");
      await expect(order.discountLabel).toHaveText("Bulk discount ($50+)");
      await expect(order.total).toHaveText("$50");

      // The joke is a code like any other to the row: accepted, the
      // field empties, the row folds and Add discount takes the focus.
      await order.codeInput.fill("eggboi");
      await order.codeInput.press("Enter");
      await expect(order.codeNote).toHaveText("Code applied.");
      await expect(order.codeInput).toHaveValue("");
      await expect(order.cart).toHaveAttribute("data-share", "");
      await expect(order.codeOpen).toBeFocused();
      await expect(order.cart.locator(".order-cart-joke")).toBeVisible();

      // Apply with the field empty takes the code off again.
      await order.codeOpen.click();
      await order.codeApply.click();
      await expect(order.cart.locator(".order-cart-joke")).toHaveCount(0);
      await expect(order.codeNote).toBeHidden();
    });

    test("the row's controls share one height, open or shut",
      async ({ page }) => {
        const order = new OrderPage(page);

        await order.open(FULL_CART);
        await unfold(order);
        await order.next.scrollIntoViewIfNeeded();

        const heights = (selectors) => Promise.all(
          selectors.map(async (sel) => {
            const el = order.cart.locator(sel).first();

            if (!(await el.isVisible())) return [sel, null];

            return [sel, (await el.boundingBox()).height];
          })
        );
        const sides = [
          ["[data-way-toggle]", "[data-code-toggle]"],
          ["[data-way]", "[data-field='code']", "[data-code-apply]"],
        ];

        for (const pass of ["shut", "open"]) {
          if (pass === "open") {
            await order.codeOpen.click();
            await page.waitForTimeout(300);
          }
          for (const side of sides) {
            for (const [sel, h] of await heights(side)) {
              if (h !== null) expect(h, `${sel} ${pass}`).toBeCloseTo(36, 0);
            }
          }
        }
      });
  });
}
