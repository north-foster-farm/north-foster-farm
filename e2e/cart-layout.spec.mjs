// The cart and the forms at every width James reviewed on 2026-09-24
// (.ignored/audits/2026-09-24/findings.md): about 1500, 1198 (just
// under xl), 990 (just under lg), 575 (just under sm) and the iPhone.
// Each test is one finding turned into a geometric check, so a
// regression shows as a number rather than a feeling.
// docs/qa-launch.md, "The order page and cart".

import { FULL_CART, OrderPage, expect, test } from "./support/order.mjs";

const WIDTHS = [
  { width: 1500, height: 900 },
  { width: 1198, height: 900 },
  { width: 990, height: 800 },
  { width: 575, height: 800 },
  { width: 390, height: 664 },
];
const XL = 1200;

const box = async (locator) => {
  const b = await locator.boundingBox();

  if (!b) throw new Error(`${locator} has no box`);

  return { ...b, right: b.x + b.width, bottom: b.y + b.height };
};

// True when every sampled point across the element's box hits the
// element itself (or its children): nothing from the page shows
// through it or sits on top of it.
const covered = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const misses = [];
  const top = Math.max(r.top, 0);
  const bottom = Math.min(r.bottom, window.innerHeight);

  for (let y = top + 2; y < bottom - 2; y += 12) {
    for (const fx of [0.1, 0.5, 0.9]) {
      const x = r.left + r.width * fx;
      const hit = document.elementFromPoint(x, y);

      if (hit && !el.contains(hit)) {
        misses.push(`${Math.round(x)},${Math.round(y)}: ${
          hit.tagName.toLowerCase()}.${String(hit.className).slice(0, 40)}`);
      }
    }
  }

  return misses;
});

for (const size of WIDTHS) {
  test.describe(`cart at ${size.width}px`, () => {
    test.use({ viewport: size });

    test("Continue to checkout can be reached and pressed",
      { tag: "@regression" }, async ({
        page,
      }) => {
        const order = new OrderPage(page);

        await order.open(FULL_CART);
        await page.waitForTimeout(1_000);
        await order.next.scrollIntoViewIfNeeded();
        await expect(order.next).toBeInViewport({ ratio: 1 });
        // A trial click fails if anything covers the button.
        await order.next.click({ trial: true });
        await order.next.click();
        await expect(page.locator("#details legend")).toBeFocused();
      });

    test("Continue to checkout is never wider than 370px", async ({
      page,
    }) => {
      const order = new OrderPage(page);

      await order.open(FULL_CART);
      expect((await box(order.next)).width).toBeLessThanOrEqual(370.5);
    });

    test("the next-discount nudge shows under Continue", async ({ page }) => {
      const order = new OrderPage(page);

      await order.open(FULL_CART);
      await expect(order.nudge).toHaveText(
        "Next discount: add $1 for $20 off."
      );
      await order.nudge.scrollIntoViewIfNeeded();
      await expect(order.nudge).toBeInViewport({ ratio: 1 });

      const nudge = await box(order.nudge);
      const next = await box(order.next);

      expect(nudge.y).toBeGreaterThanOrEqual(next.bottom - 1);
      // Right-aligned under the button.
      expect(Math.abs(nudge.right - next.right)).toBeLessThanOrEqual(2);
    });

    test("the total sits under the column of prices", async ({ page }) => {
      const order = new OrderPage(page);

      await order.open(FULL_CART);
      await order.total.scrollIntoViewIfNeeded();

      const total = await box(order.total);
      const subtotal = await box(order.subtotal);

      expect(Math.abs(total.right - subtotal.right)).toBeLessThanOrEqual(2);
      // Where the lines share the column (xl and up, and below md),
      // the total also lines up with the line prices.
      if (size.width >= XL || size.width < 768) {
        const sub = await box(order.cart.locator(".order-cart-item-sub")
          .first());

        expect(Math.abs(total.right - sub.right)).toBeLessThanOrEqual(2);
      }
    });

    test("the foot carries Hide below xl and not at xl", async ({ page }) => {
      const order = new OrderPage(page);
      const toggle = order.cart.locator("[data-cart-toggle]");

      await order.open(FULL_CART);
      if (size.width >= XL) {
        await expect(toggle).toBeHidden();
      } else {
        await toggle.scrollIntoViewIfNeeded();
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveText("Hide");

        const t = await box(toggle);
        const next = await box(order.next);

        // Hide on the left, Continue on the right, one row.
        expect(t.right).toBeLessThanOrEqual(next.x);
        expect(Math.abs((t.y + t.height / 2) - (next.y + next.height / 2)))
          .toBeLessThanOrEqual(12);
      }
    });

    test("the settled cart stays inside its own box", async ({ page }) => {
      const order = new OrderPage(page);

      await order.open(FULL_CART);
      // Scroll so the cart has settled into the page, just above
      // Contact information.
      await page.locator("#details").scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);

      const cart = await box(order.cart);
      const details = await box(page.locator("#details legend"));
      const end = await box(order.cart.locator(".order-cart-end"));

      expect(end.bottom).toBeLessThanOrEqual(cart.bottom + 1);
      if (size.width < XL) {
        expect(cart.bottom).toBeLessThanOrEqual(details.y + 1);
      }
      // No line of the item list spills below the cart.
      const spill = await order.cart.locator(".order-cart-item").evaluateAll(
        (items, bottom) => items.filter((li) => {
          const r = li.getBoundingClientRect();
          const list = li.closest("[data-cart-items]")
            .getBoundingClientRect();

          return r.top < list.bottom && r.bottom > bottom + 1;
        }).length, cart.bottom
      );

      expect(spill).toBe(0);
    });

    test("nothing shows through the cart", async ({ page }) => {
      const order = new OrderPage(page);

      await order.open(FULL_CART);
      await page.waitForTimeout(800);
      expect(await covered(order.cart)).toEqual([]);
      if (size.width < XL) {
        await order.cart.locator("[data-cart-toggle]").click();
        await expect(order.cart).toHaveAttribute("data-open", "false");
        await page.waitForTimeout(600);
        expect(await covered(order.cart)).toEqual([]);
      }
    });
  });
}

test.describe("cart below xl", () => {
  for (const size of WIDTHS.filter((s) => s.width < XL)) {
    test(`${size.width}px: the item list scrolls on its own while the ` +
      "cart floats", async ({ page }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);
      const list = order.cart.locator("[data-cart-items]");

      await order.open(FULL_CART);
      await page.waitForTimeout(800);
      await expect(order.cart).toHaveAttribute("data-stuck", "true");

      const { scrollHeight, clientHeight } = await list.evaluate(
        (el) => ({
          scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
        })
      );

      test.skip(scrollHeight <= clientHeight, "the whole list fits");
      await list.hover();
      await page.mouse.wheel(0, 120);
      await expect.poll(() => list.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);
    });

    test(`${size.width}px: the total bar is flush with the top once the ` +
      "cart is passed", async ({ page }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);
      const bar = size.width >= 992
        ? page.locator(".order-total-bar")
        : page.locator(".order-topbar");

      await order.open(FULL_CART);
      await page.locator("#pickup").scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, 200));
      await page.waitForTimeout(600);
      await expect(bar).toBeVisible();
      await expect(bar).toContainText("20 items");
      // $199 less the $150 tier's $15; the fee is waived.
      await expect(bar).toContainText("$184");

      const b = await box(bar);

      expect(b.y).toBeGreaterThanOrEqual(-1);
      expect(b.y).toBeLessThanOrEqual(1);
      // The lg total bar ignores the pointer (pointer-events: none), so
      // hit-testing it would see through it; the topbar is solid.
      if (size.width < 992) expect(await covered(bar)).toEqual([]);
    });

    test(`${size.width}px: the Cart heading looks like the other section ` +
      "headings", async ({ page }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open(FULL_CART);

      const style = (sel) => page.locator(sel).evaluate((el) => {
        const s = getComputedStyle(el);

        return { size: s.fontSize, weight: s.fontWeight, family: s.fontFamily };
      });

      expect(await style("#order-cart-heading"))
        .toEqual(await style("#details legend"));
    });
  }
});

test.describe("contact form spacing", () => {
  for (const size of WIDTHS) {
    test(`${size.width}px: heading to hint is 0.375rem, and each label sits ` +
      "with its own field", async ({ page }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open({ eggs: 1 });

      const legend = page.locator("#details legend");
      const hint = page.locator("#details .order-section-hint");

      expect(await legend.evaluate((el) => getComputedStyle(el).marginBottom))
        .toBe("6px");
      expect(await hint.getAttribute("style") || "").not.toContain("-12px");

      const first = await box(page.locator("label[for='customer-first-name']"));
      const firstField = await box(page.locator("#customer-first-name"));
      const last = await box(page.locator("label[for='customer-last-name']"));

      if (first.bottom <= firstField.y + 1) {
        // Stacked: the gap inside a group is smaller than between them.
        const inside = firstField.y - first.bottom;
        const between = last.y - firstField.bottom;

        expect(between).toBeGreaterThan(inside);
      }
    });
  }
});

test.describe("the card form", () => {
  for (const size of [WIDTHS[0], WIDTHS[1], WIDTHS[4]]) {
    test(`${size.width}px: the card box hugs Square's field`, async ({
      page,
    }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open({ eggs: 1 });
      await order.method("onfarm");
      await order.openCard();

      const frame = page.locator("iframe[src*='single-card-element-iframe']");

      await expect(frame).toBeVisible();
      await page.waitForTimeout(800);

      const holder = await box(page.locator("[data-card]"));
      const field = await box(frame);
      // Square's own guidance line ("Enter your card number") sits
      // under the field; nothing but it should.
      const message = await box(page.locator("[data-card] .sq-card-message"));

      expect(message.y).toBeGreaterThanOrEqual(field.bottom - 1);
      expect(message.y - field.bottom).toBeLessThanOrEqual(16);
      expect(holder.bottom - message.bottom).toBeLessThanOrEqual(16);
      // One row of fields where there is room for it.
      if (size.width >= 576) expect(field.height).toBeLessThanOrEqual(60);
    });
  }
});
