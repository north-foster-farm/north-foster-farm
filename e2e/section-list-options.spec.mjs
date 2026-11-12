// #562, an exploration on lane/cloud-562 only: a tap on the phone
// bar's name lists the page's sections. Two options, picked by the
// page's ?sections= query (order-form.js wireSectionList):
//
// - drop (the default): the list drops from under the bar over a
//   shaded page;
// - drawer: the sidebar's own offcanvas drawer slides in from the
//   left.
//
// For each, at 390 x 844: pictures of the bar closed, the list open,
// and the list open over an open floating cart, saved to
// test-results/section-list-options/ for the coordinator to post on
// the issue. Asserted is only what the pictures and the report claim:
// the current section's link is marked and takes the focus, Escape
// shuts the list and puts the focus back on the bar, and a link chosen
// goes to its section with the list shut.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  OrderPage, addQuery, expect, paneStill, test, unfoldCart,
} from "./support/order.mjs";

const OUT = join(
  import.meta.dirname, "..", "test-results", "section-list-options"
);

test.use({ viewport: { width: 390, height: 844 } });

const shot = async (page, testInfo, name) => {
  const file = join(OUT, `${name}-${testInfo.project.name}.png`);

  mkdirSync(OUT, { recursive: true });
  // Past the drop's and the drawer's eases.
  await page.waitForTimeout(500);
  await page.screenshot({ path: file, animations: "disabled" });
  await testInfo.attach(name, { path: file, contentType: "image/png" });
};

// /order/ with a cart, so the cart floats at the foot, and the option.
const open = async (page, option) => {
  const order = new OrderPage(page);
  const cart = { eggs: 2, wings: 1, thighs: 1 };

  await page.goto(`/order/?add=${addQuery(cart)}&sections=${option}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator("#onfarm-date")).toBeEnabled();
  await page.evaluate(() => document.fonts.ready.then(() => {}));
  // ?add= scrolls to the cart after load; let it finish first.
  await page.waitForTimeout(1_000);

  return order;
};

// The second category's heading under the bar: the bar stuck and
// naming it, the cart floating closed at the foot.
const toCategory = async (order) => {
  const name = await order.page.evaluate(() => {
    const cat = document.querySelectorAll(".order-cat")[1];

    window.scrollTo({
      top: cat.getBoundingClientRect().top + window.scrollY - 40,
      behavior: "instant",
    });

    return cat.querySelector(".order-cat-text").textContent.trim();
  });

  await order.scrollSettled();
  await paneStill(order.cart);

  return name;
};

for (const option of ["drop", "drawer"]) {
  test(`option ${option}: closed, open, and over the open cart`, async ({
    page,
  }, testInfo) => {
    const order = await open(page, option);
    const button = page.locator("[data-sections]");
    const side = page.locator("#order-side");
    const name = await toCategory(order);

    await expect(button).toHaveAttribute("data-sections", option);
    await expect(button).toHaveText(name);
    await expect(order.cart).toHaveAttribute("data-placement", "floating");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await shot(page, testInfo, `${option}-closed`);

    // Open: the current category's link is marked and focused.
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");

    const marked = side.locator(".order-side-sub .nav-link.active");

    await expect(marked).toHaveText(name);
    await expect(marked).toBeFocused();
    await shot(page, testInfo, `${option}-open`);

    // Escape: shut, the focus back on the bar.
    await page.keyboard.press("Escape");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(button).toBeFocused();
    await expect(side).toBeHidden();

    // The floating cart open, then the list over it.
    await unfoldCart(order);
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(marked).toBeFocused();
    await shot(page, testInfo, `${option}-open-cart`);

    // Shut again, the cart is still open: the list left it alone.
    await page.keyboard.press("Escape");
    await expect(side).toBeHidden();
    await expect(button).toBeFocused();
    await expect(order.cart).toHaveAttribute("data-fold", "open");
  });

  test(`option ${option}: a section chosen from the list`, async ({
    page,
  }) => {
    const order = await open(page, option);
    const button = page.locator("[data-sections]");
    const side = page.locator("#order-side");

    await toCategory(order);
    await button.click();

    // The first category, above the current one: tall enough to land
    // under the bar, as a short last one may not be.
    const first = side.locator(".order-side-sub .nav-item:not([hidden]) a")
      .first();
    const want = (await first.textContent()).trim();

    await first.click();
    await expect(side).toBeHidden();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await order.scrollSettled();
    await expect(page.locator("[data-sections] [data-topbar-title]"))
      .toHaveText(want);
  });
}
