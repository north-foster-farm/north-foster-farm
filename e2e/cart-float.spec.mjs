// Where the cart is at every width (#477, docs/cart.md 4.4): a column
// from xl, settled in the page on short screens, and otherwise a pane
// that floats at the foot of the screen while its slot is below and
// settles into the slot as the slot comes up, lifting off closed on
// the way back, once, with no oscillation. The phone's sheet keeps to
// about two thirds of the screen under the top bar; the tablet's panel
// is the right column closed and the full column open. It sets its
// own sizes, so it runs in the desktop project only.

import {
  FULL_CART, OrderPage, expect, paneStill, test, unfoldCart,
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

  // In small steps, and stopping on the seam itself: the settle and
  // lift-off thresholds never overlap, so nothing flips back. The
  // panel's closed and open heights are nearly equal, where an
  // overlap would show first.
  for (const [name, size] of [["a phone", PHONE], ["a tablet", TABLET]]) {
    test(`${name}: scrolling up through the seam never flips back`,
      async ({ page }) => {
        await page.setViewportSize(size);

        const order = new OrderPage(page);

        await order.open(FULL_CART);
        await settle(page, order);

        const seen = [];
        let y = await page.evaluate(() => window.scrollY);

        while (y > 0) {
          y = Math.max(0, y - 8);
          await page.evaluate((top) => window.scrollTo(0, top), y);
          await page.waitForTimeout(30);
          seen.push(await order.cart.getAttribute("data-placement"));
          // Pause on the seam: a pane that flips does it here.
          if (seen.length > 1 && seen.at(-1) !== seen.at(-2)) {
            await page.waitForTimeout(800);
            seen.push(await order.cart.getAttribute("data-placement"));
          }
        }

        const first = seen.indexOf("floating");

        expect(first).toBeGreaterThan(-1);
        expect(seen.slice(0, first).every((p) => p === "inline")).toBe(true);
        expect(seen.slice(first).every((p) => p === "floating")).toBe(true);
      });
  }

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

  // Hide and Expand ease (#533): mid-ease the pane's left edge is on
  // its way, the right column has not moved and the lines are still
  // on screen; closed, they are hidden. Under reduced motion it is a
  // swap.
  const floatOpen = async (page) => {
    const order = new OrderPage(page);

    await page.setViewportSize(TABLET);
    await order.open(FULL_CART);
    await order.scrollSettled();
    await page.evaluate(() => window.scrollTo(0, 300));
    await order.scrollSettled();
    await expect(order.cart).toHaveAttribute("data-placement", "floating");
    await unfoldCart(order);

    return order;
  };

  // Presses the pill and looks two frames later.
  const pressAndLook = (order) => order.cart.evaluate(async (pane) => {
    const sums = pane.querySelector("[data-part='sums']");
    const lines = pane.querySelector("[data-part='lines']");
    const was = {
      left: pane.getBoundingClientRect().left,
      sums: sums.getBoundingClientRect().left,
    };

    pane.querySelector("[data-cart-toggle]").click();
    await new Promise((done) => requestAnimationFrame(
      () => requestAnimationFrame(done)
    ));

    return {
      was,
      left: pane.getBoundingClientRect().left,
      sums: sums.getBoundingClientRect().left,
      easing: pane.getAnimations()
        .some((a) => a.transitionProperty === "width"),
      lines: getComputedStyle(lines).visibility,
    };
  });

  test("Hide retracts the lines into the totals and Expand reverses it",
    async ({ page }) => {
      const order = await floatOpen(page);
      const lines = order.cart.locator("[data-part='lines']");
      const open = await box(order.cart);

      const hiding = await pressAndLook(order);

      expect(hiding.easing).toBe(true);
      expect(hiding.lines).toBe("visible");
      expect(Math.abs(hiding.sums - hiding.was.sums)).toBeLessThanOrEqual(1);
      await expect(order.cart).toHaveAttribute("data-fold", "closed");
      await expect(lines).toBeHidden();
      await paneStill(order.cart);

      const closed = await box(order.cart);

      expect(hiding.left).toBeGreaterThan(open.left);
      expect(hiding.left).toBeLessThan(closed.left);

      const showing = await pressAndLook(order);

      expect(showing.easing).toBe(true);
      expect(showing.lines).toBe("visible");
      expect(showing.left).toBeLessThan(closed.left);
      expect(showing.left).toBeGreaterThan(open.left);
      expect(Math.abs(showing.sums - showing.was.sums))
        .toBeLessThanOrEqual(1);
      await expect(order.cart).toHaveAttribute("data-fold", "open");
      await paneStill(order.cart);
      expect(Math.abs((await box(order.cart)).left - open.left))
        .toBeLessThanOrEqual(1);
    });

  // The total row and the pane's height hold through a fold (#533):
  // the closed panel used to drop the row's rule and padding, so the
  // row jumped on every Hide. Measured open, mid-ease both ways, and
  // settled closed and open again.
  test("a fold moves neither the total row nor the pane's height",
    async ({ page }) => {
      const order = await floatOpen(page);
      const row = order.cart.locator("[data-part='total']");
      const measure = () => order.cart.evaluate((pane) => {
        const r = pane.querySelector("[data-part='total']")
          .getBoundingClientRect();

        return {
          top: r.top,
          height: r.height,
          pane: pane.getBoundingClientRect().height,
        };
      });
      // Presses the pill and measures two frames into the ease.
      const pressAndMeasure = () => order.cart.evaluate(async (pane) => {
        pane.querySelector("[data-cart-toggle]").click();
        await new Promise((done) => requestAnimationFrame(
          () => requestAnimationFrame(done)
        ));

        const r = pane.querySelector("[data-part='total']")
          .getBoundingClientRect();

        return {
          top: r.top,
          height: r.height,
          pane: pane.getBoundingClientRect().height,
          easing: pane.getAnimations()
            .some((a) => a.transitionProperty === "width"),
        };
      });
      const same = (got, want) => {
        expect(Math.abs(got.top - want.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(got.height - want.height)).toBeLessThanOrEqual(1);
        expect(Math.abs(got.pane - want.pane)).toBeLessThanOrEqual(1);
      };

      await expect(row).toBeVisible();

      const open = await measure();
      const hiding = await pressAndMeasure();

      expect(hiding.easing).toBe(true);
      same(hiding, open);
      await expect(order.cart).toHaveAttribute("data-fold", "closed");
      await paneStill(order.cart);
      same(await measure(), open);

      const showing = await pressAndMeasure();

      expect(showing.easing).toBe(true);
      same(showing, open);
      await expect(order.cart).toHaveAttribute("data-fold", "open");
      await paneStill(order.cart);
      same(await measure(), open);
    });

  test("under reduced motion Hide and Expand are a swap", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });

    const order = await floatOpen(page);
    const lines = order.cart.locator("[data-part='lines']");
    const hiding = await pressAndLook(order);

    expect(hiding.easing).toBe(false);
    expect(hiding.lines).toBe("hidden");
    await paneStill(order.cart);
    expect(Math.abs((await box(order.cart)).left - hiding.left))
      .toBeLessThanOrEqual(1);

    const showing = await pressAndLook(order);

    expect(showing.easing).toBe(false);
    await expect(lines).toBeVisible();
    expect(Math.abs(showing.left - hiding.was.left)).toBeLessThanOrEqual(1);
  });

  test("a long list scrolls in the left column with its arrows", async ({
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

// No rule over the subtotal on the panel, 576px to xl (#533). James saw
// a hairline there at about 1400px and 122% zoom, which is the panel
// at about 1147px. The phone's sheet and xl's column keep theirs,
// where it divides the lines from the totals.
test.describe("the subtotal", () => {
  for (const [name, size, rule] of [
    ["a phone", PHONE, "1px"],
    ["a phone on its side", PHONE_SIDE, "1px"],
    ["a small tablet", SMALL_TABLET, "0px"],
    ["a tablet", TABLET, "0px"],
    ["a zoomed laptop", { width: 1147, height: 760 }, "0px"],
    ["the last panel width", LAST_PANEL, "0px"],
    ["xl", XL, "1px"],
  ]) {
    const has = rule === "0px" ? "has no rule" : "keeps its rule";

    test(`${has} above it on ${name}`, async ({ page }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);
      const sums = order.cart.locator("[data-part='sums']");

      await order.open(FULL_CART);
      await order.scrollSettled();
      if (await order.cart.getAttribute("data-placement") === "floating") {
        await unfoldCart(order);
      }
      await expect(sums).toBeVisible();
      expect(await sums.evaluate((el) => (
        getComputedStyle(el).borderTopWidth
      ))).toBe(rule);
    });
  }
});
