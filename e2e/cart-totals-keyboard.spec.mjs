// The cart's sums on the Total tab under the iOS keyboard (#448). With
// the discount field open the keyboard shrinks the visual viewport and
// the pane's cap with it. Only the lines' floor was measured, so on the
// Total tab the pane stayed untight and the sums' fold, the one part
// left to give way, was squeezed: "Subtotal" cut at the pane's top,
// the discount row on the toggle and no rule between them. The sums
// keep their own section now, whole and unscrolled where the room
// holds them, and #389's open row, Apply, Hide and Proceed to checkout
// stay inside the pane. On the smallest phone the code row keeps its
// room and the sums scroll as a whole. Runs in WebKit as the iphone
// project; the keyboard is a stand-in visual viewport 300px shorter.

import { FULL_CART, OrderPage, expect, test } from "./support/order.mjs";

const WIDTHS = [
  { width: 320, height: 664 },
  { width: 375, height: 667 },
  { width: 390, height: 664 },
];
// The iPhone SE (first generation): too short for the sums beside the
// pane and the open code row.
const SMALL = { width: 320, height: 568 };

const KEYBOARD = 300;
const FOLD = ".order-cart-fold:not(.order-cart-after) > .order-cart-inner";
const AFTER = ".order-cart-after > .order-cart-inner";

// The box of what the selector matches, in the viewport.
const rect = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();

  return { top: r.top, bottom: r.bottom };
});

// A box whole inside another, a pixel's rounding either way.
const inside = (box, view) => {
  expect(box.top).toBeGreaterThanOrEqual(view.top - 1);
  expect(box.bottom).toBeLessThanOrEqual(view.bottom + 1);
};

// A visual viewport that the test can shrink: the keyboard's stand-in.
const fakeKeyboard = () => {
  const real = window.visualViewport;
  const fake = new EventTarget();

  fake.kb = 0;
  Object.defineProperties(fake, {
    height: { get: () => real.height - fake.kb },
    width: { get: () => real.width },
    offsetTop: { get: () => real.offsetTop },
    offsetLeft: { get: () => 0 },
    scale: { get: () => 1 },
    pageTop: { get: () => real.pageTop },
    pageLeft: { get: () => 0 },
  });
  Object.defineProperty(window, "visualViewport", { get: () => fake });
  window.__keyboard = (n) => {
    fake.kb = n;
    fake.dispatchEvent(new Event("resize"));
  };
};

// The stuck pane open on the Total tab with the bulk discount showing,
// the code field open and focused and the keyboard up.
// `roundTrip` first scrolls the cart down into its place in the page
// (settled) and back up to float again, as James's phone does (#448).
const totalsUnderKeyboard = async (page, size, { roundTrip = false } = {}) => {
  await page.setViewportSize(size);
  await page.addInitScript(fakeKeyboard);

  const order = new OrderPage(page);
  const cart = order.cart;

  await order.open(FULL_CART);
  if (roundTrip) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(cart).toHaveAttribute("data-stuck", "false");
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect(cart).toHaveAttribute("data-stuck", "true");

  const hide = cart.locator("[data-cart-toggle]");

  if ((await hide.getAttribute("aria-expanded")) !== "true") {
    await hide.click();
  }
  await cart.getByRole("tab", { name: /^Total/ }).click();
  await expect(cart).toHaveAttribute("data-money", "open");
  await expect(cart).toHaveAttribute("data-items", "closed");
  await page.waitForTimeout(500);

  // The bulk discount shows: the row the report saw on the toggle.
  await expect(order.discountRow).toBeVisible();

  await order.codeOpen.click();
  await order.codeInput.focus();
  await page.evaluate((n) => window.__keyboard(n), KEYBOARD);
  await page.waitForTimeout(300);

  // Tight: what is under the total row scrolls.
  await expect(cart).toHaveAttribute("data-tight", "");

  return { order, cart, hide };
};

// The pane inside the visible area, its top at the top bar's foot or
// under it, never behind the bar.
const paneInRoom = async (cart, size) => {
  const pane = await rect(cart);
  const bar = await cart.evaluate((el) => parseFloat(
    el.style.getPropertyValue("--cart-bar")
  ) || 0);

  expect(pane.top).toBeGreaterThanOrEqual(bar - 1);
  expect(pane.bottom).toBeLessThanOrEqual(size.height - KEYBOARD + 1);

  return pane;
};

// #389: the open row and Apply in the scrolling part's view, Hide and
// Proceed to checkout inside the pane, and each one tappable.
const rowInReach = async ({ order, cart, hide }, pane) => {
  const view = await rect(cart.locator(AFTER));

  for (const locator of [order.codeInput, order.codeApply]) {
    inside(await rect(locator), view);
  }
  for (const locator of [hide, order.next]) {
    inside(await rect(locator), pane);
  }
  await order.codeApply.click({ trial: true });
  await order.next.click({ trial: true });
};

for (const size of WIDTHS) {
  test.describe(`at ${size.width} by ${size.height}`, () => {
    test("the sums keep their section, and the open row its reach",
      async ({ page }) => {
        const parts = await totalsUnderKeyboard(page, size);
        const { cart } = parts;
        const pane = await paneInRoom(cart, size);
        const fold = cart.locator(FOLD);
        const seg = await rect(cart.locator("[data-cart-seg]"));
        const rule = cart.locator(".order-cart-money .order-cart-rule");
        const rows = cart.locator(
          ".order-cart-money .order-cart-row:not([hidden])"
        );

        // Whole without scrolling: the sums' box is at its top and
        // holds all it has.
        const box = await fold.evaluate((el) => ({
          top: el.scrollTop, full: el.scrollHeight, seen: el.clientHeight,
        }));

        expect(box.top).toBe(0);
        expect(box.full).toBeLessThanOrEqual(box.seen + 1);

        // Each row and the rule inside the fold's box, under the pane's
        // top.
        const view = await rect(fold);
        const count = await rows.count();

        expect(count).toBeGreaterThanOrEqual(2);
        expect(view.top).toBeGreaterThanOrEqual(pane.top);
        for (let i = 0; i < count; i += 1) {
          inside(await rect(rows.nth(i)), view);
        }
        inside(await rect(rule), view);

        // The gray rule under the last row and clear of the toggle: the
        // section ends above it, not on it.
        const last = await rect(rows.nth(count - 1));
        const line = await rect(rule);

        expect(line.top).toBeGreaterThan(last.bottom + 4);
        expect(seg.top).toBeGreaterThan(line.bottom + 4);

        await rowInReach(parts, pane);
      });
  });
}

// #448, round 2: after the cart settles in the page and floats again,
// the tight pane's scroller (the tier line, the way, the code) began
// flush under the items/total switch, and what had scrolled up clipped
// against it; with four items the tier line lay on the switch's foot.
// The scroller keeps a gap under the switch, as the dark rule gave it
// with the keyboard down.
test.describe("after the settle and float round trip", () => {
  const size = WIDTHS[2];

  test("the tier line keeps its room under the switch", async ({ page }) => {
    const parts = await totalsUnderKeyboard(page, size, { roundTrip: true });
    const { cart } = parts;
    const pane = await paneInRoom(cart, size);
    const seg = await rect(cart.locator("[data-cart-seg]"));
    const edge = await rect(cart.locator(AFTER));

    expect(edge.top).toBeGreaterThanOrEqual(seg.bottom + 8);

    // The room costs the code row nothing: it stays in reach.
    await rowInReach(parts, pane);
  });
});

test.describe(`at ${SMALL.width} by ${SMALL.height}`, () => {
  test("the code row keeps its room and the sums scroll as a whole",
    async ({ page }) => {
      const parts = await totalsUnderKeyboard(page, SMALL);
      const { cart } = parts;
      const pane = await paneInRoom(cart, SMALL);
      const fold = cart.locator(FOLD);

      // The open row and Apply in view first: the sums never take
      // their room.
      await rowInReach(parts, pane);

      // The sums' box scrolls rather than clips.
      const box = await fold.evaluate((el) => ({
        overflow: getComputedStyle(el).overflowY,
        full: el.scrollHeight, seen: el.clientHeight,
      }));

      expect(box.overflow).toBe("auto");
      expect(box.full).toBeGreaterThan(box.seen);
      expect((await rect(fold)).top).toBeGreaterThanOrEqual(pane.top);
    });
});
