// The phone cart's panes (#267): the count and the total are one
// segmented control and the lines and the sums take turns, the whole
// pane stays within 66% of the visible height unless the floor (three
// rows, the total row and Continue) needs more, and the shared row's
// controls are one height whichever side shows. What a spec cannot
// reach is on a real iPhone: Safari's toolbar, the keyboard riding the
// cart up (visualViewport), the notch's safe areas and how the glide
// feels.
// docs/qa-launch.md, OP-28 and OP-29.

import { FULL_CART, OrderPage, expect, test } from "./support/order.mjs";

const PHONE = { width: 390, height: 664 };
const TALL = { width: 390, height: 844 };
// The open pane's share of the visible height (_order.scss, #475).
const CAP = 0.66;

test.describe("cart panes on a phone", () => {
  test.use({ viewport: PHONE });

  test("the count and the total are tabs that take turns", async ({
    page,
  }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);

    const cart = order.cart;
    const items = cart.getByRole("tab", { name: /items?$/ });
    const money = cart.getByRole("tab", { name: /^Total/ });

    await expect(cart.getByRole("tablist", { name: "Cart view" }))
      .toBeVisible();
    await expect(items).toHaveAttribute("aria-selected", "true");
    await expect(money).toHaveAttribute("aria-selected", "false");
    await expect(cart).toHaveAttribute("data-items", "open");
    await expect(cart).toHaveAttribute("data-money", "closed");

    await money.click();
    await expect(money).toHaveAttribute("aria-selected", "true");
    await expect(items).toHaveAttribute("aria-selected", "false");
    await expect(cart).toHaveAttribute("data-money", "open");
    await expect(cart).toHaveAttribute("data-items", "closed");

    // One side is always showing: a second tap on it changes nothing.
    await money.click();
    await expect(cart).toHaveAttribute("data-money", "open");

    // Arrows move the pick and the focus; only the pick is a tab stop.
    await money.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(items).toBeFocused();
    await expect(items).toHaveAttribute("aria-selected", "true");
    await expect(items).toHaveAttribute("tabindex", "0");
    await expect(money).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("End");
    await expect(money).toBeFocused();
    await expect(cart).toHaveAttribute("data-money", "open");
  });

  test("the fill slides under the side that shows", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);

    const cart = order.cart;
    const fill = cart.locator(".order-cart-seg-fill");
    const seg = cart.locator("[data-cart-seg]");
    const half = async () => {
      const f = await fill.boundingBox();
      const t = await seg.boundingBox();

      return { left: f.x - t.x, width: f.width, track: t.width };
    };

    const left = await half();

    expect(left.left).toBeCloseTo(0, 0);
    expect(left.width).toBeCloseTo(left.track / 2, 0);

    await cart.getByRole("tab", { name: /^Total/ }).click();
    await page.waitForTimeout(600);

    const right = await half();

    expect(right.left).toBeCloseTo(right.track / 2, 0);
  });

  // The whole open pane, every row of it, not a part: the lines alone
  // stayed under the cap while the pane took 70% (#267). The cap is
  // 66% of the visible height; it gives way only to the floor of three
  // rows, the total row and Continue (order-form.js measureFloor).
  for (const size of [PHONE, TALL]) {
    const title = `the open pane keeps to ${Math.round(CAP * 100)}% of`
      + ` a ${size.height}px screen`;

    test(title, async ({ page }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open(FULL_CART);
      await page.evaluate(() => window.scrollTo(0, 400));

      const cart = order.cart;
      const hide = cart.locator("[data-cart-toggle]");

      if ((await hide.getAttribute("aria-expanded")) !== "true") {
        await hide.click();
      }

      for (const name of [/items?$/, /^Total/]) {
        await cart.getByRole("tab", { name }).click();
        await page.waitForTimeout(500);

        const b = await cart.boundingBox();
        const floor = await cart.evaluate(
          (el) => parseFloat(el.style.getPropertyValue("--cart-min-h")) || 0
        );

        expect(b).toBeTruthy();
        expect(b.height).toBeLessThanOrEqual(
          Math.max(size.height * CAP, floor) + 1
        );
      }
    });
  }

  // Three rows, the total row and Continue, on every phone: when they
  // do not fit the cap the pane grows, up to the visible area under the
  // top bar and never past the foot of the screen (#267). A phone on
  // its side no longer floats the pane (#274 round 4, cart-round4).
  for (const size of [PHONE, TALL, { width: 375, height: 667 }]) {
    test(`the pane keeps its floor at ${size.width}x${size.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open(FULL_CART);
      await page.evaluate(() => window.scrollTo(0, 400));

      const cart = order.cart;
      const hide = cart.locator("[data-cart-toggle]");

      if ((await hide.getAttribute("aria-expanded")) !== "true") {
        await hide.click();
      }
      await cart.getByRole("tab", { name: /items?$/ }).click();
      await page.waitForTimeout(600);

      const box = async (locator) => locator.evaluate((el) => {
        const r = el.getBoundingClientRect();

        return { top: r.top, bottom: r.bottom };
      });
      const pane = await box(cart);

      expect(pane.bottom).toBeLessThanOrEqual(size.height);
      expect(pane.top).toBeGreaterThanOrEqual(0);

      // Whole and not clipped by the fold: the row's own box is what
      // answers at its centre and at both its edges.
      const rows = cart.locator(".order-cart-item");

      for (let i = 0; i < 3; i += 1) {
        const shown = await rows.nth(i).evaluate((el) => {
          const r = el.getBoundingClientRect();
          const at = (y) => {
            const hit = document.elementFromPoint(r.left + r.width / 2, y);

            return !!hit && el.contains(hit);
          };

          return [r.top + 2, r.top + r.height / 2, r.bottom - 2].map(at);
        });

        expect(shown, `row ${i + 1} is not clipped`).toEqual(
          [true, true, true]
        );
      }

      for (const locator of [
        cart.locator("[data-cart-seg]"), order.next,
      ]) {
        const b = await box(locator);

        expect(b.top).toBeGreaterThanOrEqual(pane.top);
        expect(b.bottom).toBeLessThanOrEqual(pane.bottom);
      }
      await order.next.click({ trial: true });
    });
  }

  test("the more pills never sit over a heading or a line", async ({
    page,
  }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);

    const cart = order.cart;
    const list = cart.locator("[data-cart-items]");
    const down = cart.locator("[data-cart-more]");
    const up = cart.locator("[data-cart-more-top]");

    const apart = async (pill) => {
      const l = await list.boundingBox();
      const p = await pill.boundingBox();

      expect(p.y).toBeGreaterThanOrEqual(l.y + l.height - 1);
    };

    await expect(down).toBeVisible();
    await apart(down);

    await list.evaluate((el) => { el.scrollTop = 140; });
    await expect(up).toBeVisible();
    await apart(up);
    await apart(down);
  });

  // The badges are the first thing to go when the cap has no room for
  // them (a long cart, or a screen under about 800px tall); a short
  // cart on a taller screen keeps them.
  // Every badge shows whatever the way, "Delivery" and "Free delivery"
  // among them, on one line with no label (#278; two badges again since
  // #274 round 4). The row went missing for pickup once, and the chicks
  // with it (4dabd6d, #274).
  test("the badges show whatever the way", async ({ page }) => {
    const order = new OrderPage(page);

    await page.setViewportSize(TALL);
    await order.open({ wings: 2 });
    await page.evaluate(() => window.scrollTo(0, 400));

    const badges = order.cart.locator(".order-badges");
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

    // Lit, at 390 and at an SE's 375: one line, or two where the pane
    // is too narrow (the tiers under the delivery badges, #274 round
    // 4; cart-round4 pins which), never wider than the pane, and the
    // text no larger than the "Next discount" note under Continue.
    for (const width of [390, 375]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => {
        for (const el of document.querySelectorAll("[data-badge]")) {
          el.dataset.on = "true";
        }
      });

      const seen = await badges.evaluate((ul) => {
        const tops = new Set(
          Array.from(ul.querySelectorAll("li"))
            .filter((li) => li.offsetHeight)
            .map((li) => Math.round(li.getBoundingClientRect().top))
        );
        const note = document.querySelector("[data-nudge]");

        return {
          lines: tops.size,
          over: ul.scrollWidth - ul.clientWidth,
          size: parseFloat(getComputedStyle(ul).fontSize),
          note: parseFloat(getComputedStyle(note).fontSize),
        };
      });

      expect(seen.lines, `${width}px lines`).toBeLessThanOrEqual(2);
      expect(seen.over, `${width}px overflow`).toBeLessThanOrEqual(0);
      expect(seen.size).toBeLessThanOrEqual(seen.note);
      expect(seen.size).toBeGreaterThan(0.7 * 16);
    }
  });

  // The badges once gave way first under the cap (bb34f07); they are
  // where the chicks come from, so the cap gives way instead (#274).
  test("a long cart keeps its badges and its way", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART, { method: "delivery" });
    await order.scrollSettled();
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect(order.cart).toHaveAttribute("data-stuck", "true");
    await expect(order.cart.locator(".order-badges")).toBeVisible();
    await expect(order.cart.locator("[data-way-toggle]")).toBeVisible();
  });

  test("the shared row's controls are all 36px tall", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);
    await order.next.scrollIntoViewIfNeeded();

    const heights = (selectors) => Promise.all(selectors.map(async (sel) => {
      const el = order.cart.locator(sel).first();

      if (!(await el.isVisible())) return [sel, null];

      return [sel, (await el.boundingBox()).height];
    }));
    const sides = [
      [".order-cart-add-code", ".order-cart-pick"],
      [".order-cart-code-input", ".order-cart-apply"],
    ];

    for (const side of sides) {
      for (const [sel, h] of await heights(side)) {
        if (h !== null) expect(h, sel).toBeCloseTo(36, 0);
      }
    }

    const open = order.cart.locator("[data-code-toggle]");

    if (await open.isVisible()) await open.click();
    await page.waitForTimeout(300);

    for (const side of sides) {
      for (const [sel, h] of await heights(side)) {
        if (h !== null) expect(h, sel).toBeCloseTo(36, 0);
      }
    }
  });
});
