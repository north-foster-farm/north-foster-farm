// Criteria tests for #892 (Order page: a late stock answer shifts the
// page after the ?add= scroll), one per "Done when" box marked
// (test), named for it and written before the fix. ?add= scrolls to
// the cart on a fixed 300 ms timer (order-form.js addFromQuery), not
// after the first stock answer (stock.js ready()). An answer that
// comes later hides the sold-out rows above the cart, and on a phone
// the page shrinks under the finished scroll. The fifth box (the
// #619 and #706 specs, cart-add-scroll and checkout-go, passing on
// staging unchanged) is a staging run's, not a test here.
//
// Held out of every run by its name: playwright.config.mjs takes
// *.spec.mjs only, so the implementer turns it on by renaming it
// e2e/cart-stock-scroll.spec.mjs. It runs in the desktop and phone
// projects.
//
// The late answer: /api/stock as the server gives it, held DELAY_MS,
// with every row the suite does not pin marked sold out, so rows
// above the cart hide when it lands, as staging's live stock does.
// The pinned rows (SUITE_STOCK) keep their counts. Nothing in it is
// hand-written but those marks, as restock.spec.mjs's stubStock does.
//
// The place, as cart.show() documents it: below xl, where the cart
// floats (#order-cart data-placement "floating"), the heading
// #order-cart-heading at the top of the screen at its own
// scroll-margin-top; from xl, where the cart is the column, the pane
// in view (the heading is display: none there).

import { cannedDates } from "./support/canned.mjs";
import { TODAY, moneyFor } from "./support/money-day.mjs";
import {
  OrderPage, SUITE_STOCK, expect, stockApplied, test,
} from "./support/order.mjs";

const DELAY_MS = 3_000;
const CART = { eggs: 2 };
const MOTIONS = ["reduce", "no-preference"];
// Held still this long, over at least this many frames, counts as
// settled. WebKit in Actions draws about 5 frames a second.
const HOLD_MS = 1_000;
const HOLD_FRAMES = 5;
// The least time after the answer is applied before the page may
// count as settled, so a scroll that starts on the answer is seen.
const AFTER_MS = 2_500;
// The first load gets, in stock.js, up to 60 s of retries before it
// shuts the page; the cart must be in view by then and a little after.
const GIVE_UP_MS = 75_000;
// How long a shown explanation must stay up.
const KEEP_MS = 3_000;

// Holds /api/stock, then answers with the server's own answer, every
// unpinned row marked sold out. Resolves `landed` once it answers.
const lateStock = async (page) => {
  let land;
  const landed = new Promise((resolve) => { land = resolve; });

  await page.route("**/api/stock*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));

    const res = await route.fetch();
    const body = await res.json();

    for (const sku of Object.keys(body.items)) {
      if (!(sku in SUITE_STOCK)) {
        body.items[sku] = { inStock: false, available: 0 };
      }
    }
    await route.fulfill({ response: res, json: body });
    land();
  });

  return landed;
};

// Every frame's scrollY from the first script on, with its time.
const trackScroll = (page) => page.addInitScript(() => {
  const t0 = performance.now();
  const frames = [];
  const step = () => {
    frames.push({ at: performance.now() - t0, y: scrollY });
    requestAnimationFrame(step);
  };

  window.qaFrames = frames;
  window.qaStart = t0;
  requestAnimationFrame(step);
});

// Waits for scrollY to hold still for HOLD_MS over HOLD_FRAMES, and
// returns every scrollY the page has passed through.
const stillAgain = async (page, after) => {
  await expect.poll(() => page.evaluate(({ ms, count, least }) => {
    const frames = window.qaFrames;
    const end = frames.length - 1;
    let from = end;

    while (from > 0 && frames[from - 1].y === frames[end].y) from -= 1;

    return frames[end].at >= least && end - from + 1 >= count
      && frames[end].at - frames[from].at >= ms;
  }, { ms: HOLD_MS, count: HOLD_FRAMES, least: after }), {
    message: "the page holds still", timeout: 20_000,
  }).toBe(true);

  return page.evaluate(() => window.qaFrames.map((f) => f.y));
};

// Opens ?add= with the late answer, and waits until it has landed,
// been applied, and the page has held still after it.
const openLate = async (page, motion) => {
  await page.emulateMedia({ reducedMotion: motion });
  await cannedDates(page);
  await trackScroll(page);

  const landed = await lateStock(page);
  const order = new OrderPage(page);

  const shown = page.locator(".order-item:not([hidden])");

  await order.open(CART);

  const before = await shown.count();

  await landed;
  await stockApplied(page);
  expect(await shown.count(), "the late answer hid rows")
    .toBeLessThan(before);

  const applied = await page.evaluate(() => performance.now()
    - window.qaStart);

  return { order, ys: await stillAgain(page, applied + AFTER_MS) };
};

// Whether the cart is where cart.show() puts it, and what was read.
const cartPlace = (order) => order.page.evaluate(() => {
  const pane = document.getElementById("order-cart");
  const heading = document.getElementById("order-cart-heading");
  const box = pane.getBoundingClientRect();

  if (pane.dataset.placement === "column") {
    return {
      ok: box.top >= 0 && box.top < innerHeight && box.bottom > 0,
      read: `pane ${box.top} to ${box.bottom} of ${innerHeight}`,
    };
  }

  const top = heading.getBoundingClientRect().top;
  const margin = parseFloat(getComputedStyle(heading).scrollMarginTop);

  return {
    ok: Math.abs(top - margin) <= 1, read: `heading ${top}, margin ${margin}`,
  };
});

// Whether the cart has been brought into view at all.
const cartSeen = (order) => order.page.evaluate(() => {
  const pane = document.getElementById("order-cart");
  const el = pane.dataset.placement === "column" ? pane
    : document.getElementById("order-cart-heading");
  const box = el.getBoundingClientRect();

  return box.bottom > 0 && box.top < innerHeight;
});

const tipsOf = (button) => button.evaluate((el) => (
  el.getAttribute("aria-describedby") || ""
).split(/\s+/).map((id) => document.getElementById(id))
  .filter((node) => node?.getAttribute("role") === "tooltip"
    && node.getBoundingClientRect().height > 0)
  .map((node) => node.textContent.trim()));

test.describe("a late stock answer after ?add= (#892)", () => {
  for (const motion of MOTIONS) {
    test("After ?add=, the page settles with the cart's heading at its "
      + "scroll margin when the live stock answer arrives after the "
      + `300 ms the scroll waits today (${motion} motion)`,
    async ({ page }) => {
      const { order } = await openLate(page, motion);
      const place = await cartPlace(order);

      expect(place.ok, `the cart in its place (${place.read})`).toBe(true);
    });

    test("After ?add=, the page still scrolls once, one way, never back, "
      + `with the stock answer delayed (${motion} motion)`,
    async ({ page }) => {
      const { ys } = await openLate(page, motion);
      const steps = ys.slice(1).map((y, i) => y - ys[i])
        .filter((d) => Math.abs(d) > 2);

      // From xl the column may need no scroll: none is one way too.
      expect(steps.every((d) => Math.sign(d) === Math.sign(steps[0])),
        `one scroll, one way, never back (${ys.join()})`).toBe(true);
    });
  }

  test("When the live stock answer never arrives or fails, the cart is "
    + "still brought into view", async ({ page }) => {
    test.setTimeout(2 * GIVE_UP_MS + 30_000);

    const ways = {
      "never arrives": () => {},
      fails: (route) => route.abort("failed"),
    };

    for (const [name, answer] of Object.entries(ways)) {
      await test.step(name, async () => {
        await page.unroute("**/api/stock*");
        await page.route("**/api/stock*", answer);
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        }).catch(() => {});
        await cannedDates(page);

        const order = new OrderPage(page);

        await order.open(CART);
        await expect.poll(() => cartSeen(order), {
          message: `${name}: the cart in view`, timeout: GIVE_UP_MS,
        }).toBe(true);
      });
    }
  });

  test("On the phone, a tap on Proceed to checkout below the delivery "
    + "minimum, made after a delayed stock answer, shows its "
    + "explanation and keeps it", async ({ page }, info) => {
    test.skip(info.project.name === "desktop", "the phone's cart only");

    const { deliveryMinimum: MIN } = moneyFor(TODAY);
    const { order } = await openLate(page, "no-preference");

    await order.method("delivery");
    await order.scrollSettled();

    const current = (await order.subtotal.textContent()).trim();
    const why = `Delivery orders have a $${MIN} minimum (current order `
      + `is ${current}). Please add more to your cart or choose a `
      + "different pick-up option.";

    expect(Number(current.replace(/\D/g, "")), "below the minimum")
      .toBeLessThan(MIN);
    // Forced: the button is aria-disabled but takes the press (#706).
    await (info.project.use.hasTouch
      ? order.next.tap({ force: true })
      : order.next.click({ force: true }));
    await expect.poll(() => tipsOf(order.next), {
      message: "the tap is explained", timeout: 5_000,
    }).toEqual([why]);
    await page.waitForTimeout(KEEP_MS);
    expect(await tipsOf(order.next), "and the explanation stays")
      .toEqual([why]);
  });
});
