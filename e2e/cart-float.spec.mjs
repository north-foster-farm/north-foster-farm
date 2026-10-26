// Where the cart is at every width (#477, docs/cart.md 4.4): a column
// from xl, settled in the page on short screens, and otherwise a pane
// that floats at the foot of the screen while its slot is below and
// settles into the slot as the slot comes up, lifting off closed on
// the way back, once, with no oscillation. The phone's sheet keeps to
// about two thirds of the screen under the top bar; the tablet's panel
// is the right column closed and the full column open. It sets its
// own sizes, so it runs in the desktop project only.

import {
  FULL_CART, OrderPage, expect, test, unfoldCart,
} from "./support/order.mjs";

const PHONE = { width: 390, height: 844 };
const PHONE_SIDE = { width: 844, height: 390 };
const SMALL_TABLET = { width: 576, height: 900 };
const TABLET = { width: 768, height: 1024 };
const LG = { width: 1024, height: 768 };
const LAST_PANEL = { width: 1199, height: 900 };
const XL = { width: 1280, height: 900 };

const box = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();

  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
});

// The pane's place in the page (the slot has no box below xl): its
// top, and the width the pane has to work with.
const anchor = (page) => page.locator("[data-cart-anchor]");

// Settle the cart: its heading near the top of the screen.
const settle = async (page, order) => {
  await page.evaluate(() => {
    document.getElementById("order-cart-heading")
      .scrollIntoView({ block: "start", behavior: "instant" });
    window.scrollBy({ top: -90, behavior: "instant" });
  });
  await order.scrollSettled();
  await expect(order.cart).toHaveAttribute("data-placement", "inline");
};

test.describe("placement on load", () => {
  for (const [name, size, placement] of [
    ["a phone", PHONE, "floating"],
    ["a small tablet", SMALL_TABLET, "floating"],
    ["a tablet", TABLET, "floating"],
    ["a laptop", LG, "floating"],
    ["the last panel width", LAST_PANEL, "floating"],
    ["xl", XL, "column"],
    ["a phone on its side", PHONE_SIDE, "inline"],
  ]) {
    test(`${name} starts ${placement}`, async ({ page }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open(FULL_CART);
      await page.evaluate(() => window.scrollTo(0, 0));
      await order.scrollSettled();
      await expect(order.cart).toHaveAttribute("data-placement", placement);
    });
  }
});

test.describe("floating, settling and lifting off", () => {
  for (const [name, size] of [["a phone", PHONE], ["a tablet", TABLET]]) {
    test(`${name}: the pane settles into its slot and lifts off once`,
      async ({ page }) => {
        await page.setViewportSize(size);

        const order = new OrderPage(page);

        await order.open(FULL_CART);
        await page.evaluate(() => window.scrollTo(0, 200));
        await order.scrollSettled();
        await expect(order.cart).toHaveAttribute("data-placement", "floating");

        // Floating, the pane rests above the foot of the screen.
        const floating = await box(order.cart);

        expect(floating.bottom).toBeLessThanOrEqual(size.height);
        expect(floating.bottom).toBeGreaterThan(size.height - 80);

        // Count every change of placement from here on.
        await order.cart.evaluate((el) => {
          el.__changes = [];
          new MutationObserver(() => {
            el.__changes.push(el.dataset.placement);
          }).observe(el, {
            attributes: true, attributeFilter: ["data-placement"],
          });
        });

        await settle(page, order);
        // Settled: in its slot, every line showing, nothing capped.
        const settled = await box(order.cart);
        const place = await box(anchor(page));

        expect(Math.abs(settled.top - place.top)).toBeLessThanOrEqual(1);
        const list = order.cart.locator("[data-cart-items]");

        expect(await list.evaluate((el) => (
          el.scrollHeight <= el.clientHeight + 1
        ))).toBe(true);
        await expect(order.cart.locator("[data-cart-more]")).toBeHidden();
        await expect(order.cart.locator("[data-cart-toggle]")).toBeHidden();

        // Back up: it lifts off closed, once.
        await page.evaluate(() => window.scrollTo(0, 0));
        await order.scrollSettled();
        await expect(order.cart).toHaveAttribute("data-placement", "floating");
        await expect(order.cart).toHaveAttribute("data-fold", "closed");

        const changes = await order.cart.evaluate((el) => el.__changes);

        expect(changes).toEqual(["inline", "floating"]);
      });
  }

  test("a phone: scrolling up through the seam never flips back", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);

    const order = new OrderPage(page);

    await order.open(FULL_CART);
    await settle(page, order);

    const seen = [];
    let y = await page.evaluate(() => window.scrollY);

    while (y > 0) {
      y = Math.max(0, y - 40);
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(40);
      seen.push(await order.cart.getAttribute("data-placement"));
    }

    const first = seen.indexOf("floating");

    expect(first).toBeGreaterThan(-1);
    expect(seen.slice(0, first).every((p) => p === "inline")).toBe(true);
    expect(seen.slice(first).every((p) => p === "floating")).toBe(true);
  });

  test("a phone on its side never floats", async ({ page }) => {
    await page.setViewportSize(PHONE_SIDE);

    const order = new OrderPage(page);

    await order.open(FULL_CART);
    for (const y of [0, 400, 1200]) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await order.scrollSettled();
      await expect(order.cart).toHaveAttribute("data-placement", "inline");
    }
    expect(await order.cart.evaluate((el) => getComputedStyle(el).position))
      .not.toBe("sticky");
  });
});

test.describe("the phone's sheet", () => {
  test("open, it keeps to about two thirds of the screen under the bar",
    async ({ page }) => {
      await page.setViewportSize(PHONE);

      const order = new OrderPage(page);

      await order.open(FULL_CART);
      await order.scrollSettled();
      await page.evaluate(() => window.scrollTo(0, 300));
      await order.scrollSettled();
      await expect(order.cart).toHaveAttribute("data-placement", "floating");
      await unfoldCart(order);

      const pane = await box(order.cart);
      const bar = await box(page.locator(".order-topbar"));
      const height = pane.bottom - pane.top;

      expect(height).toBeLessThanOrEqual(PHONE.height * 0.7);
      expect(height).toBeGreaterThanOrEqual(PHONE.height * 0.55);
      expect(pane.top).toBeGreaterThanOrEqual(bar.bottom - 1);
      // The lines show at least three rows and scroll on their own.
      const list = order.cart.locator("[data-cart-items]");
      const rows = await list.locator(".order-cart-item").count();
      const shown = await list.evaluate((el) => {
        const r = el.getBoundingClientRect();

        return Array.from(el.querySelectorAll(".order-cart-item"))
          .filter((li) => {
            const b = li.getBoundingClientRect();

            return b.top >= r.top - 1 && b.bottom <= r.bottom + 1;
          }).length;
      });

      expect(shown).toBeGreaterThanOrEqual(3);
      if (shown < rows) {
        await expect(order.cart.locator("[data-cart-more]")).toBeVisible();
      }
    });

  test("the top bar stays over the pane", async ({ page }) => {
    await page.setViewportSize(PHONE);

    const order = new OrderPage(page);

    await order.open(FULL_CART);
    await page.evaluate(() => window.scrollTo(0, 300));
    await order.scrollSettled();

    const [bar, pane] = await page.evaluate(() => [
      getComputedStyle(document.querySelector(".order-topbar")).zIndex,
      getComputedStyle(document.getElementById("order-cart")).zIndex,
    ]);

    expect(Number(bar)).toBeGreaterThan(Number(pane));
  });
});

test.describe("the tablet's panel", () => {
  for (const size of [SMALL_TABLET, TABLET, LG, LAST_PANEL]) {
    test(`at ${size.width}px: closed is the right column, open the whole`,
      async ({ page }) => {
        await page.setViewportSize(size);

        const order = new OrderPage(page);
        const pill = order.cart.locator("[data-cart-toggle]");

        await order.open(FULL_CART);
        await order.scrollSettled();
        await page.evaluate(() => window.scrollTo(0, 300));
        await order.scrollSettled();
        await expect(order.cart).toHaveAttribute("data-placement", "floating");
        await unfoldCart(order);

        const col = await box(anchor(page));
        const open = await box(order.cart);
        const sums = order.cart.locator("[data-part='sums']");
        const sumsOpen = await box(sums);

        expect(Math.abs(open.left - col.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(open.right - col.right)).toBeLessThanOrEqual(1);

        await pill.click();
        await expect(order.cart).toHaveAttribute("data-fold", "closed");
        await page.waitForTimeout(500);

        const closed = await box(order.cart);
        const sumsClosed = await box(sums);
        const width = col.right - col.left;
        const expected = Math.min(width, Math.max(width / 2, 22 * 16));

        expect(Math.abs(closed.right - col.right)).toBeLessThanOrEqual(1);
        expect(Math.abs(closed.right - closed.left - expected))
          .toBeLessThanOrEqual(2);
        // The right column did not move.
        expect(Math.abs(sumsClosed.left - sumsOpen.left))
          .toBeLessThanOrEqual(1);
        expect(Math.abs(sumsClosed.right - sumsOpen.right))
          .toBeLessThanOrEqual(1);
      });
  }

  test("a long list scrolls in the left column with its pills", async ({
    page,
  }) => {
    await page.setViewportSize(TABLET);

    const order = new OrderPage(page);

    await order.open({ ...FULL_CART, whole: 2 });
    await order.scrollSettled();
    await page.evaluate(() => window.scrollTo(0, 300));
    await order.scrollSettled();
    await expect(order.cart).toHaveAttribute("data-placement", "floating");
    await unfoldCart(order);

    const list = order.cart.locator("[data-cart-items]");
    const scrolls = await list.evaluate((el) => (
      el.scrollHeight > el.clientHeight + 1
    ));

    test.skip(!scrolls, "the whole list fits this tall");
    await expect(order.cart.locator("[data-cart-more]")).toBeVisible();
    await order.cart.locator("[data-cart-more]").click();
    await expect(order.cart.locator("[data-cart-more-top]")).toBeVisible();
  });
});

test.describe("the column", () => {
  test("sticks beside the catalog with no heading and no pill", async ({
    page,
  }) => {
    await page.setViewportSize(XL);

    const order = new OrderPage(page);

    await order.open(FULL_CART);
    await expect(order.cart).toHaveAttribute("data-placement", "column");
    await expect(page.locator("#order-cart-heading")).toBeHidden();
    await expect(order.cart.locator("[data-cart-toggle]")).toBeHidden();
    expect(await order.cart.evaluate((el) => getComputedStyle(el).position))
      .toBe("sticky");

    // Scrolled, it holds at its sticky offset, 1rem under the top.
    await page.evaluate(() => window.scrollTo(0, 600));
    await page.waitForTimeout(100);
    const after = await box(order.cart);

    expect(Math.abs(after.top - 16)).toBeLessThanOrEqual(1);
    await page.evaluate(() => window.scrollTo(0, 1200));
    await page.waitForTimeout(100);
    const further = await box(order.cart);

    expect(Math.abs(further.top - 16)).toBeLessThanOrEqual(1);
  });

  test("eases to its new height as lines come and go", async ({ page }) => {
    await page.setViewportSize(XL);

    const order = new OrderPage(page);

    await order.open({ wings: 1 });
    await page.waitForTimeout(600);
    const before = await order.cart.evaluate((el) => el.eases || 0);

    await order.item("eggs").locator(".order-qty-add").click();
    // The view counts every ease it starts on the pane.
    await expect.poll(() => order.cart.evaluate((el) => el.eases || 0))
      .toBeGreaterThan(before);
  });
});
