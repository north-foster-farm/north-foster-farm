// One model, one render (#477, James's second condition): the cart in
// the page and the cart floating over it are the same element, drawn
// by the same render from the same state, so they cannot show
// different contents or totals. This fails if they ever do: it reads
// the pane's lines, sums, total, badges and way while it floats, lets
// it settle into the page, reads them again, and compares; then it
// changes the cart in each placement and checks the other shows the
// change, and that the bars' readouts never disagree with the pane.
// It sets its own sizes, so it runs in the desktop project only.

import {
  FULL_CART, OrderPage, expect, paneStill, test, unfoldCart,
} from "./support/order.mjs";

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 1024 };

// Everything the cart says, as text, in document order.
const contents = (cart) => cart.evaluate((el) => {
  const text = (sel) => Array.from(el.querySelectorAll(sel))
    .map((n) => n.textContent.replace(/\s+/g, " ").trim());

  return {
    lines: text(".order-cart-item"),
    groups: text(".order-cart-group-name"),
    sums: text("[data-part='sums']:not([hidden]) .order-cart-row"),
    count: el.querySelector("[data-cart-count]").textContent.trim(),
    total: el.querySelector("[data-total='total']").textContent.trim(),
    badges: Array.from(el.querySelectorAll("[data-badge]"))
      .map((b) => `${b.dataset.badge}:${b.dataset.on}`),
    way: el.querySelector("[data-way-name]").textContent.trim(),
    nudge: el.querySelector("[data-nudge]").textContent.trim(),
  };
});

const identity = (cart) => cart.evaluate((el) => {
  el.__id = el.__id || Math.random().toString(36).slice(2);

  return el.__id;
});

const settle = async (page, order) => {
  await page.evaluate(() => {
    document.getElementById("order-cart-heading")
      .scrollIntoView({ block: "start", behavior: "instant" });
    window.scrollBy({ top: -90, behavior: "instant" });
  });
  await order.scrollSettled();
  await expect(order.cart).toHaveAttribute("data-placement", "inline");
  await paneStill(order.cart);
};

const float = async (page, order) => {
  await page.evaluate(() => window.scrollTo(0, 300));
  await order.scrollSettled();
  await expect(order.cart).toHaveAttribute("data-placement", "floating");
  await unfoldCart(order);
};

for (const [name, size] of [["a phone", PHONE], ["a tablet", TABLET]]) {
  test.describe(`on ${name}`, () => {
    test("the floating cart and the settled cart are one element with "
      + "one content", async ({ page }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open(FULL_CART);
      await float(page, order);

      const id = await identity(order.cart);
      const floating = await contents(order.cart);

      await settle(page, order);
      expect(await identity(order.cart)).toBe(id);
      expect(await contents(order.cart)).toEqual(floating);
      expect(await page.locator("#order-cart").count()).toBe(1);
    });

    test("a change made in either placement shows in the other", async ({
      page,
    }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open(FULL_CART);
      await settle(page, order);
      // Remove a line while settled.
      await order.cart.locator("[data-remove]").first().click();
      await paneStill(order.cart);
      const settled = await contents(order.cart);

      expect(settled.count).toBe("17 items");
      await float(page, order);
      expect(await contents(order.cart)).toEqual(settled);

      // Change the way while floating.
      await order.cart.locator("[data-way-toggle]").click();
      await order.cart.locator("[data-way='delivery']").click();
      await expect(order.cart.locator("[data-way-name]"))
        .toHaveText("Delivery");
      const changed = await contents(order.cart);

      expect(changed.badges).not.toEqual(settled.badges);
      await settle(page, order);
      expect(await contents(order.cart)).toEqual(changed);
    });

    test("the bars' readouts never disagree with the pane", async ({
      page,
    }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open(FULL_CART);
      for (const y of [0, 300]) {
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await order.scrollSettled();
        const pane = await contents(order.cart);
        const bars = await page.evaluate(() => {
          const texts = (sel) => Array.from(document.querySelectorAll(sel))
            .map((n) => n.textContent.trim());

          return {
            counts: texts("[data-total-bar-count]"),
            totals: texts("[data-total-bar-total]"),
          };
        });

        for (const count of bars.counts) expect(count).toBe(pane.count);
        for (const total of bars.totals) expect(total).toBe(pane.total);
      }
    });
  });
}
