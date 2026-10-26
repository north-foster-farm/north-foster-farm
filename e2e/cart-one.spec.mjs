// One cart, one render (#477, James's second condition): the in-page
// cart and the floating pane are the same element, aside#order-cart,
// drawn by the same render from the same state, so there is nothing to
// drift. This fails if a second cart root ever appears, if what the
// pane shows floating differs from what it shows settled, or if the
// bars' readouts or the header's badge disagree with the pane.

import {
  FULL_CART, OrderPage, expect, paneStill, settleCart, test, unfoldCart,
} from "./support/order.mjs";

const SIZES = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];

// Everything the pane says, as text.
const contents = (order) => order.cart.evaluate((el) => {
  const text = (sel) => [...el.querySelectorAll(sel)]
    .map((node) => node.textContent.replace(/\s+/g, " ").trim());
  const one = (sel) => el.querySelector(sel).textContent.trim();

  return {
    groups: text(".order-cart-group-name"),
    lines: text(".order-cart-item"),
    subtotal: one("[data-total='subtotal']"),
    discount: one("[data-total='discount']"),
    fee: one("[data-total='fee']"),
    total: one("[data-total='total']"),
    count: one("[data-cart-count]"),
    badges: [...el.querySelectorAll("[data-badge]")]
      .map((b) => `${b.dataset.badge}:${b.dataset.on}`),
    way: one("[data-way-name]"),
    nudge: one("[data-nudge]"),
  };
});

// The figures outside the pane: the bars' readouts and the header's
// badge, which render() writes in the same call.
const readouts = (page) => page.evaluate(() => ({
  counts: [...document.querySelectorAll("[data-total-bar-count]")]
    .map((el) => el.textContent.trim()),
  totals: [...document.querySelectorAll("[data-total-bar-total]")]
    .map((el) => el.textContent.trim()),
  badge: document.querySelector("header .site-actions [data-cart-badge]")
    .textContent.trim(),
}));

const agree = async (page, order) => {
  const pane = await contents(order);
  const bars = await readouts(page);

  for (const count of bars.counts) expect(count).toBe(pane.count);
  for (const total of bars.totals) expect(total).toBe(pane.total);
  expect(bars.badge).toBe(pane.count.split(" ")[0]);

  return pane;
};

for (const size of SIZES) {
  test(`${size.width}px: one cart element, the same settled and floating`,
    async ({ page }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open(FULL_CART, { method: "delivery" });

      // One root, one list of lines, nowhere else in the document.
      await expect(page.locator("#order-cart")).toHaveCount(1);
      await expect(page.locator(".order-cart")).toHaveCount(1);
      await expect(page.locator("[data-cart-items]")).toHaveCount(1);
      await expect(page.locator(".order-cart-item")).toHaveCount(7);

      await settleCart(order);

      const settled = await agree(page, order);

      expect(settled.count).toBe("20 items");
      expect(settled.lines).toHaveLength(7);

      // From xl the cart is a column and never floats: the one state
      // is the whole proof there.
      if (size.width >= 1200) {
        await expect(order.cart).toHaveAttribute("data-placement", "column");

        return;
      }

      await page.evaluate(() => window.scrollTo(0, 300));
      await expect(order.cart).toHaveAttribute("data-placement", "floating");
      await unfoldCart(order);
      await paneStill(order.cart);

      const floating = await agree(page, order);

      expect(floating).toEqual(settled);

      // A change made while it floats shows in the pane and the
      // readouts alike, and again once it settles.
      const row = await order.showRow("eggs");

      await row.getByRole("button", { name: "One more" }).click();
      await expect(order.count).toHaveText("21 items");
      await paneStill(order.cart);

      const changed = await agree(page, order);

      expect(changed.total).not.toBe(settled.total);
      await settleCart(order);
      expect(await agree(page, order)).toEqual(changed);

      // A line taken out while settled is gone once it floats again,
      // and a way picked while floating holds once it settles.
      await order.cart.getByRole("button", {
        name: "Remove Wings, 1.0 – 1.9 lbs from your cart",
      }).click();
      await expect(order.count).toHaveText("17 items");
      await paneStill(order.cart);

      const fewer = await agree(page, order);

      expect(fewer.lines).toHaveLength(6);
      await page.evaluate(() => window.scrollTo(0, 300));
      await expect(order.cart).toHaveAttribute("data-placement", "floating");
      await unfoldCart(order);
      await paneStill(order.cart);
      expect(await agree(page, order)).toEqual(fewer);

      await order.cart.locator("[data-way-toggle]").click();
      await order.cart.locator("[data-way='onfarm']").click();
      await expect(order.cart.locator("[data-way-name]"))
        .toHaveText("On-farm pickup");
      await paneStill(order.cart);

      const picked = await agree(page, order);

      expect(picked.fee).toBe("");
      await settleCart(order);
      expect(await agree(page, order)).toEqual(picked);
      await expect(page.locator("#method-onfarm")).toBeChecked();
    });
}
