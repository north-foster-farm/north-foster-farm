// #267: the payment buttons are the vendors' iframes (PayPal's Venmo
// button, Google Pay, Square's card form), each with a z-index of its
// own. Loose in the page's stacking they painted over the sticky top
// bar and the open menu when the order page scrolled (an iPhone's
// overscroll showed it).
//
// Headless runs reach none of the real iframes, so a stand-in with
// PayPal-sized ambitions (the largest z-index, taller than the
// screen) is put where the Venmo button mounts, and the test asks what
// the page shows at points the bar and the menu cover. The wrapper's
// own stacking is checked too.

import { OrderPage, expect, test } from "./support/order.mjs";
import { cannedDates } from "./support/canned.mjs";

const frame = (el) => {
  const fake = document.createElement("div");

  fake.id = "fake-vendor-frame";
  fake.style.cssText = "position:relative;z-index:2147483647;"
    + "height:3000px;background:red";
  el.hidden = false;
  el.append(fake);
};

// The id of the first ancestor-or-self of what is painted at (x, y)
// that matches `selector`, or "" when none does.
const paintedWithin = (page, x, y, selector) => page.evaluate(
  ([px, py, sel]) => {
    const hit = document.elementFromPoint(px, py);

    return hit && hit.closest(sel) ? sel : (hit && hit.id) || "other";
  },
  [x, y, selector]
);

test.describe("payment buttons stay under the page's own layers", () => {
  test("the payment wrapper is a stacking context", async ({ page }) => {
    await cannedDates(page);
    await new OrderPage(page).open();

    const isolation = await page.locator("[data-pay]").evaluate(
      (el) => getComputedStyle(el).isolation
    );

    expect(isolation).toBe("isolate");
  });

  test("a vendor frame does not cover the top bar or the menu",
    async ({ page, isMobile }) => {
      test.skip(!isMobile, "the top bar and the menu are the phone's");

      await cannedDates(page);
      await new OrderPage(page).open();
      await page.locator("[data-venmo]").evaluate(frame);
      await page.evaluate(() => {
        document.querySelector("[data-venmo-cell]").hidden = false;
        document.querySelector("#payment").scrollIntoView();
        window.scrollBy(0, 40);
      });

      // The bar is unseen until it sticks (#327); before that its box
      // lies over the Show row, whose unseen radio is what answers.
      await expect(page.locator(".order-topbar"))
        .toHaveAttribute("data-stuck", "true");

      const bar = await page.locator(".order-topbar").boundingBox();
      const x = bar.x + bar.width / 2;
      const y = bar.y + bar.height / 2;

      expect(await paintedWithin(page, x, y, ".order-topbar"))
        .toBe(".order-topbar");

      await page.locator("header .site-toggle").click();
      await expect(page.locator("#site-menu")).toHaveClass(/show/);
      await page.waitForTimeout(500);

      const menu = await page.locator("#site-menu").boundingBox();

      expect(await paintedWithin(
        page, menu.x + menu.width / 2, menu.y + menu.height / 2, "#site-menu"
      )).toBe("#site-menu");
    });
});
