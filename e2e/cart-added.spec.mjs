// What the phone cart does when something is added (#267): the first
// Add of a browser session opens the pane on the new line and shuts it
// again after 3.5 seconds, pulsing the Hide/Show pill in three pairs
// (#278); a later Add leaves it shut
// and says so in the bar. Neither moves the focus off the item.
// docs/qa-launch.md, OP-30.

import { OrderPage, expect, test } from "./support/order.mjs";

const TALL = { width: 390, height: 844 };

// Presses Add on a catalog row, as a customer would.
const add = async (order, name) => {
  const row = await order.showRow(name);

  await row.locator(".order-qty-add").click();

  return row;
};

test.describe("the cart's word for an Add", () => {
  test.use({ viewport: TALL });

  test("the first Add opens the pane on the line and shuts it",
    async ({ page }) => {
      const order = new OrderPage(page);
      const pill = order.cart.locator("[data-cart-toggle]");
      const live = order.cart.locator("[data-cart-live]");

      // When the pane opens and shuts, timed in the page: a clock out
      // here also counts how slow the run is, and a busy runner once
      // made a 2 s close look like 3.8 s.
      await page.addInitScript(() => {
        window.e2eCart = [];
        new MutationObserver(() => {
          const cart = document.getElementById("order-cart");

          if (cart) {
            window.e2eCart.push([cart.dataset.open, performance.now()]);
          }
        }).observe(document, {
          subtree: true, attributes: true, attributeFilter: ["data-open"],
        });
      });
      await order.open();
      await expect(order.cart).toHaveAttribute("data-open", "false");

      const row = await add(order, "wings");

      await expect(order.cart).toHaveAttribute("data-open", "true");
      await expect(order.cart).toHaveAttribute("data-items", "open");
      // The line shows in the open pane, with no outline of its own
      // (#274, round 4).
      const line = order.cart.locator(".order-cart-item")
        .filter({ hasText: "1.0 – 1.9 lbs" });

      await expect(line).toBeVisible();
      await expect(line).toHaveCSS("box-shadow", "none");
      await expect(line).toHaveCSS("outline-style", "none");
      await expect(live).toHaveText("Added Wings, 1.0 – 1.9 lbs to cart");

      // The focus stays with the item the customer pressed, not the pane.
      const inCart = await page.evaluate(
        () => document.getElementById("order-cart")
          .contains(document.activeElement)
      );

      expect(inCart).toBe(false);
      await expect(row).toBeVisible();

      // It shuts by itself after 3.5 s (TEACH_DWELL: 2 s in #278, 1.5 s
      // more in #274 round 4), then the pill pulses in three pairs.
      await expect(order.cart).toHaveAttribute("data-open", "false", {
        timeout: 8_000,
      });

      const shut = await page.evaluate(() => {
        const log = window.e2eCart;
        const opened = log.findLast(([open]) => open === "true");
        const closed = log.findLast(([open]) => open === "false");

        return closed[1] - opened[1];
      });

      expect(shut).toBeGreaterThanOrEqual(3_300);
      expect(shut).toBeLessThanOrEqual(5_000);
      await expect(pill).toHaveAttribute("data-pulse", "teach");
    });

  test("a later Add leaves the pane shut and says what was added",
    async ({ page }) => {
      const order = new OrderPage(page);
      const pill = order.cart.locator("[data-cart-toggle]");
      const live = order.cart.locator("[data-cart-live]");

      await order.open();
      await add(order, "wings");
      await expect(order.cart).toHaveAttribute("data-open", "false", {
        timeout: 8_000,
      });

      await add(order, "eggs");
      await expect(order.cart).toHaveAttribute("data-open", "false");
      await expect(order.cart.locator("[data-cart-added]"))
        .toHaveText("Added: Eggs, Grade A Large");
      await expect(order.count).toHaveText("2 items");
      await expect(pill).toHaveAttribute("data-pulse", "once");
      await expect(live).toHaveText("Added Eggs, Grade A Large to cart");

      // The word in the bar is gone again after a moment.
      await expect(order.cart.locator("[data-cart-added-box]"))
        .not.toHaveAttribute("data-show", "", { timeout: 5_000 });
    });

  test("a customer's touch keeps the pane open", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open();
    await add(order, "wings");
    await expect(order.cart).toHaveAttribute("data-open", "true");
    await order.cart.locator("[data-cart-items]").dispatchEvent(
      "pointerdown"
    );
    await page.waitForTimeout(5_000);
    await expect(order.cart).toHaveAttribute("data-open", "true");
  });

  test("the first Add is the session's, not the page's", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open();
    await add(order, "wings");
    await expect(order.cart).toHaveAttribute("data-open", "true");
    await expect(order.cart).toHaveAttribute("data-open", "false", {
      timeout: 8_000,
    });

    // A reload keeps the session: the next Add leaves the pane shut.
    await page.reload();
    await expect(page.locator("#onfarm-date")).toBeEnabled();
    await add(order, "eggs");
    await page.waitForTimeout(600);
    await expect(order.cart).toHaveAttribute("data-open", "false");
    await expect(order.cart.locator("[data-cart-added]"))
      .toHaveText("Added: Eggs, Grade A Large");
  });
});

test.describe("with reduced motion", () => {
  test.use({ viewport: TALL });

  test("nothing slides or pulses", async ({ page }) => {
    const order = new OrderPage(page);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await order.open();
    await add(order, "wings");
    await expect(order.cart).toHaveAttribute("data-open", "true");

    const times = await order.cart.evaluate((el) => {
      const seconds = (node, prop) => parseFloat(
        getComputedStyle(node)[prop]
      );

      return {
        fill: seconds(el.querySelector(".order-cart-seg-fill"),
          "transitionDuration"),
        added: seconds(el.querySelector("[data-cart-added-box]"),
          "transitionDuration"),
        pill: seconds(el.querySelector("[data-cart-toggle]"),
          "animationDuration"),
      };
    });

    expect(times.fill).toBeLessThanOrEqual(0.001);
    expect(times.added).toBeLessThanOrEqual(0.001);
    expect(times.pill).toBeLessThanOrEqual(0.001);
  });
});
