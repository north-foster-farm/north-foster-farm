// The account's tab row on a phone (#579), too wide for the screen, so
// it scrolls sideways: the round arrow and fade at its end while any
// tab lies past it, and their mirror at its start while any tab lies
// before it (#591). Signed in with canned answers, so this runs on a
// local build as well as staging, and saves nothing.

//
// The row scrolls sideways only (#592): no taller than its box with any
// tab selected and focused, so iOS has nothing to bounce up and down,
// with the focus ring and the selected underline whole inside it. The
// cart's scrollers, which the row was modeled on (#560), are checked
// for the same fault on the other axis. On the iPhone project too.

import {
  ACCOUNT_TABS, cannedDates, signedIn,
} from "./support/canned.mjs";
import {
  FULL_CART, OrderPage, expect, test, unfoldCart,
} from "./support/order.mjs";

// A wide screen fits the row: nothing to scroll.
test.skip(({ isMobile }) => !isMobile, "the row fits a wide screen");

const open = async (page, tab = "orders") => {
  await signedIn(page);
  await page.goto(`/account/#${tab}`);
  await expect(page.locator("#account-app")).toBeVisible();
};

// The row's scroll, and the tabs in its own scroll space.
const row = (nav) => nav.evaluate((el) => ({
  left: el.scrollLeft, width: el.clientWidth, full: el.scrollWidth,
  tabs: [...el.querySelectorAll(".account-tab")]
    .filter((tab) => !tab.hidden)
    .map((tab) => ({
      left: tab.offsetLeft, right: tab.offsetLeft + tab.offsetWidth,
    })),
}));
const scrollTo = (nav, left) => nav.evaluate((el, to) => {
  el.scrollLeft = to;
}, left);

test.describe("the account's tab row", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("shows an arrow and a fade at each end with tabs past it",
    async ({ page }) => {
      await open(page);

      const wrap = page.locator("[data-tabs-wrap]");
      const nav = wrap.locator(".account-nav");
      const more = wrap.locator("[data-tabs-more]");
      const back = wrap.locator("[data-tabs-back]");
      const fade = (side) => wrap.evaluate(
        (el, pseudo) => getComputedStyle(el, pseudo).opacity, side
      );
      const { width, full } = await row(nav);

      expect(full, "the row scrolls on a phone").toBeGreaterThan(width + 1);

      // At the start: the end's arrow only.
      await expect(more).toBeVisible();
      await expect(back).toBeHidden();
      await expect(more).toHaveAccessibleName("More tabs");
      await expect.poll(() => fade("::after")).toBe("1");
      await expect.poll(() => fade("::before")).toBe("0");

      // Mid-row: both.
      await scrollTo(nav, Math.round((full - width) / 2));
      await expect(more).toBeVisible();
      await expect(back).toBeVisible();
      await expect(back).toHaveAccessibleName("Earlier tabs");
      await expect.poll(() => fade("::before")).toBe("1");

      // At the end: the start's only.
      await scrollTo(nav, full);
      await expect(more).toBeHidden();
      await expect(back).toBeVisible();
      await expect.poll(() => fade("::after")).toBe("0");

      // Back at the start, the start's goes.
      await scrollTo(nav, 0);
      await expect(back).toBeHidden();
      await expect(wrap).not.toHaveAttribute("data-back");
    });

  test("the start's arrow brings the tab cut off there into view",
    async ({ page }) => {
      await open(page);

      const wrap = page.locator("[data-tabs-wrap]");
      const nav = wrap.locator(".account-nav");
      const back = wrap.locator("[data-tabs-back]");

      await scrollTo(nav, (await row(nav)).full);
      await expect(back).toBeVisible();

      const before = await row(nav);
      const cut = before.tabs.findLast((t) => t.left < before.left - 1);

      await back.click();
      await expect.poll(async () => {
        const { left, width } = await row(nav);

        return cut.left >= left - 1 && cut.right <= left + width + 1;
      }, "the cut-off tab shows whole").toBe(true);

      // Tap by tap, it reaches the start, and its arrow goes.
      for (let i = 0; i < 6 && await back.isVisible(); i += 1) {
        await back.click();
      }
      await expect(back).toBeHidden();
      expect((await row(nav)).left).toBeLessThanOrEqual(1);
    });

  test("the end's arrow brings the first tab cut off to the start",
    async ({ page }) => {
      await open(page);

      const wrap = page.locator("[data-tabs-wrap]");
      const nav = wrap.locator(".account-nav");
      const more = wrap.locator("[data-tabs-more]");
      const before = await row(nav);
      const cut = before.tabs.find(
        (t) => t.right > before.left + before.width + 1
      );
      const stop = Math.min(before.full - before.width, cut.left);

      await more.click();
      await expect.poll(async () => Math.round((await row(nav)).left))
        .toBeGreaterThanOrEqual(stop - 1);
    });

  test("scrolls sideways only, its ring and underline whole",
    async ({ page }) => {
      for (const name of ACCOUNT_TABS) {
        await open(page, name);

        const nav = page.locator(".account-nav");
        const tab = nav.locator(`[data-tab="${name}"]`);

        await expect(tab).toHaveClass(/\bis-active\b/);
        await tab.focus();

        const seen = await tab.evaluate((el) => {
          const box = el.parentElement;
          const row = box.getBoundingClientRect();
          const own = el.getBoundingClientRect();
          const style = getComputedStyle(el);

          return {
            overflowY: getComputedStyle(box).overflowY,
            tall: box.scrollHeight, room: box.clientHeight,
            // Inside the row's box, top to foot: nothing of it clipped.
            inside: own.top >= row.top - 0.5
              && own.bottom <= row.bottom + 0.5,
            underline: parseFloat(style.borderBottomWidth),
            // Drawn inward, so the row's clip can't cut it.
            ring: parseFloat(style.outlineWidth) > 0
              && parseFloat(style.outlineOffset)
                + parseFloat(style.outlineWidth) <= 0,
          };
        });

        expect(seen.overflowY, name).toBe("hidden");
        expect(seen.tall, `${name}: no taller than its box`)
          .toBe(seen.room);
        expect(seen.inside, `${name}: the tab whole in the row`).toBe(true);
        expect(seen.underline, `${name}: the underline`).toBe(2);
        expect(seen.ring, `${name}: the ring drawn inside`).toBe(true);
      }
    });
});

test("the cart's scrollers don't scroll sideways", async ({ page }) => {
  const order = new OrderPage(page);

  await cannedDates(page);
  await order.open(FULL_CART);
  if (await order.cart.getAttribute("data-placement") === "floating") {
    await unfoldCart(order);
  }

  for (const sel of [".order-cart-body", ".order-cart-items"]) {
    const box = order.cart.locator(sel).first();
    const { wide, room } = await box.evaluate((el) => ({
      wide: el.scrollWidth, room: el.clientWidth,
    }));

    expect(wide, `${sel}: no wider than its box`).toBe(room);
  }
});
