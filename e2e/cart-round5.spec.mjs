// Cart and checkout, #274 round 5: the settled cart floats again
// hidden, on its lines, with one pill lit on a tablet; Continue at the
// right of the column; Pay and its agreement at the right on a phone
// and at the left from md; every date dropdown as wide as the fields;
// the settled cart's heading spaced like "Pickup or delivery". It sets
// its own sizes, so it runs in the desktop project only.

import { FULL_CART, OrderPage, expect, test } from "./support/order.mjs";

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 1024 };
const LG = { width: 1024, height: 768 };
const XL = { width: 1440, height: 900 };

// Settle the cart at the foot of the catalog: its heading near the top
// of the screen. A floating pane is sticky, so scrolling it into view
// would not move the page.
const settle = async (page, order) => {
  await page.evaluate(() => {
    document.getElementById("order-cart-heading")
      .scrollIntoView({ block: "start", behavior: "instant" });
    window.scrollBy({ top: -90, behavior: "instant" });
  });
  await order.scrollSettled();
  await expect(order.cart).toHaveAttribute("data-stuck", "false");
};

// Settle it, then scroll back to the top, where it floats again.
const settleThenTop = async (page, order) => {
  await settle(page, order);
  await expect(order.cart).toHaveAttribute("data-open", "true");
  await page.evaluate(() => window.scrollTo(0, 0));
  await order.scrollSettled();
  await expect(order.cart).toHaveAttribute("data-stuck", "true");
};

test("on a phone the cart floats again hidden, on its lines", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);

  const order = new OrderPage(page);

  await order.open(FULL_CART);
  await settleThenTop(page, order);
  await expect(order.cart).toHaveAttribute("data-open", "false");
  await expect(order.cart).toHaveAttribute("data-items", "open");
  await expect(order.cart).toHaveAttribute("data-money", "closed");
});

// A tablet's cart is a panel (#274, round 6): it floats again open on
// its right column, the lines folded.
test("on a tablet the cart floats again as a shut panel", async ({
  page,
}) => {
  await page.setViewportSize(TABLET);

  const order = new OrderPage(page);

  await order.open(FULL_CART);
  await settleThenTop(page, order);
  await expect(order.cart).toHaveAttribute("data-open", "true");
  await expect(order.cart).toHaveAttribute("data-items", "closed");
  await expect(order.cart).toHaveAttribute("data-money", "closed");
});

// Settled, both parts open; floating again, a tablet's total row lit
// both its pills green.
test("on a tablet one pill is lit after the cart floats again", async ({
  page,
}) => {
  await page.setViewportSize(TABLET);

  const order = new OrderPage(page);

  await order.open(FULL_CART);
  await settleThenTop(page, order);
  await expect(order.cart.locator("[data-cart-items-toggle]"))
    .toHaveAttribute("data-on", "true");
  await expect(order.cart.locator("[data-cart-money-toggle]"))
    .toHaveAttribute("data-on", "false");
});

test("in the column, Continue is as wide as its words, at the right",
  async ({ page }) => {
    await page.setViewportSize(XL);

    const order = new OrderPage(page);

    await order.open(FULL_CART);

    const box = await order.cart.locator("[data-checkout]").evaluate(
      (el) => {
        const r = el.getBoundingClientRect();
        const end = el.parentElement.getBoundingClientRect();

        return { right: end.right - r.right, width: r.width / end.width };
      }
    );

    expect(box.right).toBeLessThan(2);
    expect(box.width).toBeLessThan(0.7);
  });

test("Pay and its agreement sit right on a phone, left from md", async ({
  page,
}) => {

  const order = new OrderPage(page);

  for (const [size, side] of [[PHONE, "right"], [TABLET, "left"]]) {
    await page.setViewportSize(size);
    await order.open({ eggs: 1 });

    const seen = await page.locator(".order-submit").evaluate((el) => {
      const pay = el.querySelector("#order-submit");

      pay.hidden = false;

      const box = el.getBoundingClientRect();
      const r = pay.getBoundingClientRect();

      return {
        right: Math.abs(box.right - r.right) < 2,
        left: Math.abs(r.left - box.left) < 2,
        align: getComputedStyle(el.querySelector(".order-agree")).textAlign,
      };
    });

    expect(seen[side], `${size.width}px`).toBe(true);
    expect(seen.align, `${size.width}px`)
      .toMatch(side === "right" ? /right|end/ : /left|start/);
  }
});

test("every date dropdown is as wide as the fields", async ({
  page,
}) => {

  const order = new OrderPage(page);

  for (const size of [TABLET, LG, XL]) {
    await page.setViewportSize(size);
    await order.open({ eggs: 1 }, { method: "delivery" });

    const [date, street] = await page.evaluate(() => [
      "#delivery-date", "#delivery-address1",
    ].map((s) => document.querySelector(s).offsetWidth));

    expect(date, `${size.width}px`).toBe(street);
  }
});

// Settled, the pane is relative, and its sticky `bottom` lifted it off
// its place by the rest margin: 8px on a phone, 12px from md.
for (const size of [PHONE, TABLET, LG]) {
  test(`at ${size.width}px the settled cart's heading is spaced like ` +
    "Pickup or delivery", async ({ page }) => {
    await page.setViewportSize(size);

    const order = new OrderPage(page);

    await order.open({ eggs: 1 });
    await settle(page, order);

    const gaps = await page.evaluate(() => {
      const legend = document.querySelector("#pickup legend");
      const card = document.querySelector("#pickup .order-method");
      const heading = document.getElementById("order-cart-heading");
      const cart = document.getElementById("order-cart");

      return {
        legend: card.getBoundingClientRect().top
          - legend.getBoundingClientRect().bottom,
        heading: cart.getBoundingClientRect().top
          - heading.getBoundingClientRect().bottom,
      };
    });

    expect(Math.abs(gaps.heading - gaps.legend)).toBeLessThan(1);
  });
}

// QA's flicker (#274, round 5): settled expanded, the pane lifted off
// hidden for one step, settled again, sprang open and lifted off once
// more. Up in 10px steps, it lifts off once.
for (const size of [TABLET, PHONE]) {
  test(`at ${size.width}px the cart lifts off once on the way up`, async ({
    page,
  }) => {
    await page.setViewportSize(size);

    const order = new OrderPage(page);

    await order.open(FULL_CART);
    await settle(page, order);

    const flips = await page.evaluate(async () => {
      const cart = document.getElementById("order-cart");
      const frame = () => new Promise((done) => requestAnimationFrame(
        () => requestAnimationFrame(done)
      ));
      let last = cart.dataset.stuck;
      let count = 0;

      for (let i = 0; i !== 120; i++) {
        window.scrollBy({ top: -10, behavior: "instant" });
        await frame();
        await new Promise((done) => setTimeout(done, 40));
        if (cart.dataset.stuck !== last) count++;
        last = cart.dataset.stuck;
      }

      return { count, last };
    });

    expect(flips).toEqual({ count: 1, last: "true" });
  });
}
