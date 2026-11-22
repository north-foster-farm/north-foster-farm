// #619, qa's review: the cart's own focus after its smooth scroll is no
// Tab's, even when a Tab came just before it. Tab onto the top bar's
// total (live once the page is past the cart), Enter, and the page
// grows a little while the smooth scroll back to the cart runs: the
// scroll still goes one way and settles once. Before the fix an
// earlier Tab let clearFocusUnder's resize check scroll the page at
// once, cutting the smooth scroll short and then coming back. The top
// bar is a phone's (d-lg-none), so this runs in the phone project.

import { cannedDates } from "./support/canned.mjs";
import { OrderPage, expect, test } from "./support/order.mjs";

const STILL = 60;

test("Tab and Enter on the top bar's total, then a resize, scroll one "
  + "way to the cart and settle once", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "the phone's top bar");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await cannedDates(page);

  const order = new OrderPage(page);

  await order.open({ eggs: 2 });

  const total = page.locator(".order-topbar-total");

  // Past the cart, so the total goes back to it.
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await order.scrollSettled();
  await expect(total).not.toHaveAttribute("inert");

  // A real Tab onto the total: from it back one stop, then forward.
  await total.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(total).toBeFocused();

  await page.evaluate(() => {
    const ys = [];
    const tick = () => {
      ys.push(scrollY);
      requestAnimationFrame(tick);
    };

    window.nffScrolls = ys;
    requestAnimationFrame(tick);
  });
  await page.keyboard.press("Enter");
  // The page grows 40 px 120 ms later, inside clearFocusUnder's watch.
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    const grow = document.createElement("div");

    grow.style.height = "40px";
    document.getElementById("order-form").append(grow);
  });

  await expect.poll(() => page.evaluate((still) => {
    const tail = window.nffScrolls.slice(-still);

    return tail.length === still && tail.every((y) => y === tail[0]);
  }, STILL), { message: "the page settles", timeout: 15_000 }).toBe(true);

  const ys = await page.evaluate(() => window.nffScrolls);
  const moves = ys.slice(1).map((y, i) => y - ys[i])
    .filter((d) => Math.abs(d) > 2);

  expect(moves.length, "the page scrolled back to the cart")
    .toBeGreaterThan(0);
  expect(moves.every((d) => d < 0), `one way, up (${moves.join()})`)
    .toBe(true);
  await expect(page.locator("#order-cart-heading")).toBeFocused();
});
