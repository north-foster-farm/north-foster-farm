// Criteria tests for #619 (Order page: opening the cart from ?add=
// starts two scrolls to different places), one per tested box. ?add=
// ran cart.show(), a smooth scroll to the cart's heading, and the
// focus that followed made clearFocusUnder jump the page at once to
// the cart's slot, so where the page ended depended on which finished
// last. The spec: one scroll, to one place, honoring reduced motion,
// with no change to where focus goes. The third box (lint, tests and
// build green) is CI's.
// Held out of every run by its name until the change lands: renamed to
// cart-add-scroll.spec.mjs, it runs in the desktop and phone projects
// (Chromium), and it joins the iphone project's testMatch in
// playwright.config.mjs for WebKit, as the first box asks.
//
// The place, as cart.show() documents it: below xl, where the cart
// floats, the cart's heading at the top of the screen, at its own
// scroll-margin-top (clear of the order page's top bar); from xl,
// where the cart is the column, the pane brought into view. Both
// tests run with reduced motion and without.
//
// The seam: the heading is #order-cart-heading, the pane #order-cart
// with data-placement "floating" or "column".

import {
  OrderPage, expect, test,
} from "./support/order.mjs";
import { cannedDates } from "./support/canned.mjs";

const CART = { eggs: 2 };
const LOADS = 3;
const MOTIONS = ["reduce", "no-preference"];
// How long, and over how many frames at least, the page must hold
// still to count as settled, and the least time after load before it
// may: under load the smooth scroll was still pending a second later.
// Time, not a frame count: WebKit in Actions draws about 5 frames a
// second, so 60 frames took 13 s there (PR #812, run 45015932719).
const STILL_MS = 1_000;
const STILL_FRAMES = 5;
const AFTER = 2_500;

// Every frame's scrollY from the page's first script on.
const record = (page) => page.addInitScript(() => {
  const ys = [];
  const start = performance.now();
  const tick = () => {
    ys.push([performance.now() - start, scrollY]);
    requestAnimationFrame(tick);
  };

  window.nffScrolls = ys;
  requestAnimationFrame(tick);
});

// Waits until the page has held still for STILL_MS and STILL_FRAMES,
// AFTER ms or more after load, and returns every scrollY it passed
// through. The still run is the frames since scrollY last changed.
const settled = async (page) => {
  await expect.poll(() => page.evaluate(([ms, frames, after]) => {
    const ys = window.nffScrolls;
    const last = ys.at(-1);

    if (!last || last[0] < after) {
      return false;
    }

    const moved = ys.findLastIndex(([, y]) => y !== last[1]);
    const run = ys.slice(moved + 1);

    return run.length >= frames && last[0] - run[0][0] >= ms;
  }, [STILL_MS, STILL_FRAMES, AFTER]), {
    message: "the page settles", timeout: 20_000,
  }).toBe(true);

  return page.evaluate(() => window.nffScrolls.map(([, y]) => y));
};

const prepare = async (page, reducedMotion) => {
  await page.emulateMedia({ reducedMotion });
  await cannedDates(page);
  await record(page);

  return new OrderPage(page);
};

test.describe("opening the cart from ?add= (#619)", () => {
  for (const motion of MOTIONS) {
    test(`after ?add=, the page settles at one position, the same every `
      + `time (${motion} motion)`, async ({ page }) => {
      const order = await prepare(page, motion);
      const finals = [];

      for (let i = 0; i < LOADS; i += 1) {
        // Each load from an empty cart, as a fresh visit has it.
        if (i > 0) {
          await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
          });
        }
        await order.open(CART);

        const ys = await settled(page);
        const moves = ys.slice(1).map((y, k) => y - ys[k])
          .filter((d) => Math.abs(d) > 2);

        // From xl the column may already be in view: no scroll at all
        // is one place too.
        expect(moves.every((d) => Math.sign(d) === Math.sign(moves[0])),
          `load ${i + 1}: one scroll, one way, never back (${ys.join()})`)
          .toBe(true);
        finals.push(ys.at(-1));
      }
      expect(Math.max(...finals) - Math.min(...finals),
        `the same place every time (${finals.join(", ")})`)
        .toBeLessThanOrEqual(1);
    });

    test(`after ?add=, the page settles with the cart's heading in its `
      + `place and the focus where it went before (${motion} motion)`,
    async ({ page }) => {
      const order = await prepare(page, motion);

      await order.open(CART);

      const heading = page.locator("#order-cart-heading");

      await settled(page);

      const placement = await order.cart.getAttribute("data-placement");

      // "No change to where focus goes": cart.show() focuses the pane
      // in the column (xl and up) and the heading below xl.
      await expect(placement === "column" ? order.cart : heading)
        .toBeFocused();

      const at = await heading.evaluate((el) => ({
        top: el.getBoundingClientRect().top,
        margin: parseFloat(getComputedStyle(el).scrollMarginTop),
      }));

      if (placement === "column") {
        const pane = await order.cart.evaluate((el) => {
          const r = el.getBoundingClientRect();

          return { top: r.top, bottom: r.bottom };
        });
        const height = page.viewportSize().height;

        // From xl the heading is display: none (the pane carries its
        // own title, _cart.scss), so only the pane's place is checked.
        expect(pane.top, "the pane's top in view").toBeGreaterThanOrEqual(0);
        expect(pane.top < height && pane.bottom > 0, "the pane in view")
          .toBe(true);
      } else {
        expect(Math.abs(at.top - at.margin),
          `the heading at its scroll margin (${at.top} px, ${at.margin} px)`)
          .toBeLessThanOrEqual(1);
      }
    });
  }
});
