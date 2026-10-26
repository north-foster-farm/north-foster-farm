// What the cart says about the money (#477, docs/cart.md 3): the sums,
// the badges that light as the tiers are reached, the chicks that
// leave the badge just earned, the total's flash, the nudge under
// Proceed to checkout, and the empty cart. The figures themselves are
// pricing.spec.mjs's; this is where the cart shows them.

import {
  FULL_CART, OrderPage, expect, paneStill, settleCart as settled, test,
  unfoldCart as unfold,
} from "./support/order.mjs";

const PHONE = { width: 390, height: 844 };
const MD = { width: 768, height: 1024 };
const XL = { width: 1280, height: 800 };

const box = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();

  return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width };
});

// Every badge shows whatever the way, "Delivery" and "Free delivery"
// among them, on one line with no label (#278; two badges again since
// #274 round 4). The row went missing for pickup once, and the chicks
// with it (4dabd6d, #274).
test("the badges show whatever the way", async ({ page }) => {
  await page.setViewportSize(PHONE);

  const order = new OrderPage(page);

  await order.open({ wings: 2 });
  await unfold(order);

  const badges = order.cart.locator(".order-cart-badges");
  const tier = order.cart.locator("[data-badge='tier-50']");
  const delivery = order.cart.locator("[data-badge='delivery']");
  const free = order.cart.locator("[data-badge='free-delivery']");

  for (const way of ["onfarm", "scheduled", "delivery"]) {
    await order.method(way);
    await expect(badges, way).toBeVisible();
    await expect(tier, way).toBeVisible();
    await expect(delivery, way).toHaveText("Delivery");
    await expect(free, way).toHaveText("Free delivery");
  }
  await expect(badges).not.toContainText("Bulk discount");
});

// "Delivery" lights at the minimum and "Free delivery" at the waiver,
// each a badge of its own, on a pickup too (#278, item 6).
for (const [wings, delivery, free] of [
  [3, "false", "false"], [4, "true", "false"], [15, "true", "true"],
]) {
  test(`the delivery badges at $${wings * 10} on a pickup`, async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);

    const order = new OrderPage(page);

    await order.open({ wings });
    await expect(order.cart.locator("[data-badge='delivery']"))
      .toHaveAttribute("data-on", delivery);
    await expect(order.cart.locator("[data-badge='free-delivery']"))
      .toHaveAttribute("data-on", free);
  });
}

// All but $200+ lit, the floating pane open. One line where it fits
// with room to spare; a phone up to 414px puts the tiers on a second
// line, the delivery badges on the first (#274 round 4, #289).
for (const width of [320, 360, 390, 414, 430]) {
  const lines = width >= 430 ? 1 : 2;

  test(`the lit badges take ${lines} line(s) at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });

    const order = new OrderPage(page);

    await order.open({ wings: 15, thighs: 4 });
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect(order.cart).toHaveAttribute("data-placement", "floating");
    await unfold(order);
    await expect(order.cart.locator("[data-badge='tier-150']"))
      .toHaveAttribute("data-on", "true");

    const badges = order.cart.locator(".order-cart-badges");
    const seen = await badges.evaluate((ul) => {
      const lis = [...ul.querySelectorAll("li")]
        .filter((li) => li.getBoundingClientRect().height > 0);
      const top = (li) => Math.round(li.getBoundingClientRect().top);
      const tops = [...new Set(lis.map(top))];
      const row = (t) => lis.filter((li) => top(li) === t);

      return {
        lines: tops.length,
        first: row(tops[0]).map((li) => li.textContent.trim()),
        over: ul.scrollWidth - ul.clientWidth,
        spare: Math.min(...tops.map((t) => ul.clientWidth - row(t).reduce(
          (n, li) => n + li.getBoundingClientRect().width, 0
        ))),
      };
    });

    expect({ lines: seen.lines, over: seen.over }).toEqual({ lines, over: 0 });
    if (lines === 2) expect(seen.first).toEqual(["Delivery", "Free delivery"]);
    // Room to spare: Linux's Chromium rounds each letter to a whole
    // pixel, and wrapped the line where a Mac left 5.5px (#289).
    expect(seen.spare, "px to spare").toBeGreaterThanOrEqual(6);
  });
}

test("the chicks leave the tier just earned", async ({ page }) => {
  await page.setViewportSize(PHONE);

  const order = new OrderPage(page);

  // $48: two dollars short of the first tier.
  await order.open({ wings: 4, eggs: 1 });
  await page.evaluate(() => window.scrollTo(0, 300));
  await order.scrollSettled();
  await unfold(order);

  const badge = order.cart.locator("[data-badge='tier-50']");

  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("data-on", "false");

  // The row's Add under the open pane, pressed as a tap would. The
  // chicks start from where the badge is once the new line is laid
  // out, which is where it rests after the pane's ease.
  await order.item("drums").locator(".order-qty-add")
    .evaluate((el) => el.click());
  await expect(badge).toHaveAttribute("data-on", "true");
  await paneStill(order.cart);

  const b = await badge.boundingBox();

  // The canvas is a box around where the chicks start: 480 wide and
  // centered on it, 70% of its 360 above it, clamped to the screen
  // (celebrate.js).
  const canvas = await page.locator(".order-chicks").first().evaluate((c) => {
    const r = c.getBoundingClientRect();

    return { left: r.left, top: r.top };
  });
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;

  expect(Math.abs(canvas.left - Math.max(0, Math.round(x - 240))))
    .toBeLessThan(2);
  expect(Math.abs(canvas.top - Math.max(0, Math.round(y - 252))))
    .toBeLessThan(2);
});

test("the total bumps when it changes", async ({ page }) => {
  await page.setViewportSize(XL);

  const order = new OrderPage(page);

  await order.open({ wings: 1 });
  await expect(order.total).toHaveText("$10");
  await order.item("wings").getByRole("button", { name: "One more" }).click();
  await expect(order.total).toHaveText("$20");
  await expect(order.total).toHaveClass(/\bis-bumped\b/);
});

for (const size of [PHONE, MD, XL]) {
  test(`${size.width}px: the nudge sits right-aligned under Proceed`,
    async ({ page }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open(FULL_CART);
      await expect(order.nudge).toHaveText(
        "Next discount: add $1 for $20 off."
      );
      await settled(order);
      await order.nudge.scrollIntoViewIfNeeded();
      await expect(order.nudge).toBeInViewport();

      const nudge = await box(order.nudge);
      const next = await box(order.next);

      expect(nudge.y).toBeGreaterThanOrEqual(next.bottom - 1);
      expect(Math.abs(nudge.right - next.right)).toBeLessThanOrEqual(2);
    });

  test(`${size.width}px: the total sits under the column of prices`,
    async ({ page }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open(FULL_CART);
      await settled(order);
      await order.total.scrollIntoViewIfNeeded();

      const total = await box(order.total);
      const subtotal = await box(order.subtotal);

      expect(Math.abs(total.right - subtotal.right)).toBeLessThanOrEqual(2);
      // Where the lines share the column (xl and up, and below 576),
      // the total also lines up with the line prices.
      if (size.width >= 1200 || size.width < 576) {
        const sub = await box(order.cart.locator(".order-cart-item-sub")
          .first());

        expect(Math.abs(total.right - sub.right)).toBeLessThanOrEqual(2);
      }
    });

  test(`${size.width}px: empty, the cart shows the way and the code only`,
    async ({ page }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open();
      await page.evaluate(() => window.scrollTo(0, 300));
      if (await order.cart.locator("[data-cart-toggle]").isVisible()) {
        await unfold(order);
      }
      await expect(order.cart).toHaveAttribute("data-empty", "");
      await expect(order.subtotal).toBeHidden();
      await expect(order.cart.locator(".order-cart-badges")).toBeHidden();
      await expect(order.cart.locator("[data-way-toggle]")).toBeVisible();
      await expect(order.codeOpen).toBeVisible();
      await expect(order.next).toBeDisabled();

      // No room left above the total row.
      const gap = await order.cart.evaluate((el) => (
        el.querySelector(".order-cart-total-row").getBoundingClientRect().top
          - el.getBoundingClientRect().top
      ));

      expect(gap).toBeLessThan(2 * 16);

      await (await order.showRow("wings")).locator(".order-qty-add").click();
      await expect(order.cart).not.toHaveAttribute("data-empty", "");
      await expect(order.subtotal).toBeVisible();
    });
}

test("a signed-out customer's discount is the largest of tier and code",
  async ({ page }) => {
    const order = new OrderPage(page);

    // $100: the $10 tier. A code worth less never replaces it
    // (totals.mjs); the row names the one in force.
    await order.open({ wings: 10 });
    await expect(order.discountRow).toBeVisible();
    await expect(order.discountLabel).toHaveText("Bulk discount ($100+)");
    await expect(order.discount).toHaveText("−$10");
    await expect(order.total).toHaveText("$90");
  });
