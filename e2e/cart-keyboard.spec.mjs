// The cart under the iOS keyboard (#477, docs/cart.md 4.5; #389, #448,
// #476 before it). The keyboard shrinks only the visual viewport; the
// pane's cap follows it, the body scrolls as a whole, and Hide,
// Proceed to checkout, the code field and Apply stay in reach at every
// phone size, through the settle-and-float round trip too. Nothing is
// measured by script to get there. Runs in WebKit as the iphone
// project and in Chromium; the keyboard is a stand-in visual viewport
// 300px shorter.

import { FULL_CART, OrderPage, expect, test } from "./support/order.mjs";

const SIZES = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 664 },
  { width: 390, height: 844 },
];
const KEYBOARD = 300;

const rect = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();

  return { top: r.top, bottom: r.bottom };
});

const inside = (b, view) => {
  expect(b.top).toBeGreaterThanOrEqual(view.top - 1);
  expect(b.bottom).toBeLessThanOrEqual(view.bottom + 1);
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

// The floating pane open with the code field focused and the keyboard
// up. `roundTrip` first settles the cart and floats it again, as
// James's phone does (#448).
const underKeyboard = async (page, size, { roundTrip = false } = {}) => {
  await page.setViewportSize(size);
  await page.addInitScript(fakeKeyboard);

  const order = new OrderPage(page);
  const cart = order.cart;

  await order.open(FULL_CART);
  if (roundTrip) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await order.scrollSettled();
    await expect(cart).toHaveAttribute("data-placement", "inline");
  }
  await page.evaluate(() => window.scrollTo(0, 400));
  await order.scrollSettled();
  await expect(cart).toHaveAttribute("data-placement", "floating");

  const hide = cart.locator("[data-cart-toggle]");

  if ((await hide.getAttribute("aria-expanded")) !== "true") {
    await hide.click();
  }
  await expect(cart).toHaveAttribute("data-fold", "open");
  await expect(order.discountRow).toBeVisible();

  const before = await rect(cart);

  await order.codeOpen.click();
  await expect(cart).toHaveAttribute("data-share", "code");
  await order.codeInput.focus();
  await page.evaluate((n) => window.__keyboard(n), KEYBOARD);
  await page.waitForTimeout(300);

  return { order, cart, hide, before };
};

const checks = async ({ order, cart, hide }, size) => {
  const pane = await rect(cart);
  const bar = await rect(order.page.locator(".order-topbar"));
  const body = await rect(cart.locator("[data-cart-body]"));

  // The pane inside the visible area, under the bar, never behind it.
  expect(pane.top).toBeGreaterThanOrEqual(bar.bottom - 1);
  expect(pane.bottom).toBeLessThanOrEqual(size.height - KEYBOARD + 1);
  // The field and Apply in the body's view; Hide and Proceed in the
  // pane; each tappable.
  for (const locator of [order.codeInput, order.codeApply]) {
    inside(await rect(locator), body);
  }
  for (const locator of [hide, order.next]) {
    inside(await rect(locator), pane);
  }
  await order.codeApply.click({ trial: true });
  await order.next.click({ trial: true });
  // The field's ring is drawn inside, so the scroller cannot cut it.
  expect(await order.codeInput.evaluate((el) => (
    getComputedStyle(el).boxShadow
  ))).toContain("inset");
  // Still floating: the keyboard never changes the placement.
  await expect(cart).toHaveAttribute("data-placement", "floating");
};

for (const size of SIZES) {
  test.describe(`at ${size.width} by ${size.height}`, () => {
    test("the field, Apply, Hide and Proceed stay in reach", async ({
      page,
    }) => {
      const state = await underKeyboard(page, size);

      await checks(state, size);
    });

    test("a scroll of the body is kept, and the keyboard down restores",
      async ({ page }) => {
        const state = await underKeyboard(page, size);
        const body = state.cart.locator("[data-cart-body]");
        const scrolls = await body.evaluate((el) => (
          el.scrollHeight > el.clientHeight + 1
        ));

        test.skip(!scrolls, "the pane holds everything without scrolling");
        await body.evaluate((el) => { el.scrollTop = 0; });
        await page.evaluate((n) => window.__keyboard(n), KEYBOARD);
        await page.waitForTimeout(150);
        expect(await body.evaluate((el) => el.scrollTop)).toBe(0);

        await page.evaluate(() => window.__keyboard(0));
        await page.waitForTimeout(300);
        const after = await rect(state.cart);

        expect(Math.abs((after.bottom - after.top)
          - (state.before.bottom - state.before.top))).toBeLessThanOrEqual(2);
      });
  });
}

test("after the settle-and-float round trip, the same holds", async ({
  page,
}) => {
  const size = { width: 390, height: 664 };
  const state = await underKeyboard(page, size, { roundTrip: true });

  await checks(state, size);
  // The tier line keeps clear of the total row (#448 round 2).
  const total = await rect(state.cart.locator("[data-part='total']"));
  const badges = await rect(state.cart.locator("[data-part='badges']"));

  if (badges.bottom > badges.top) {
    expect(badges.top).toBeGreaterThanOrEqual(total.bottom - 1);
  }
});
