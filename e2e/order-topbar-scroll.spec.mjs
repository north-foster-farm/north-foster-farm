// The criteria test for #702, written before the fix and held out of
// every run until it lands: Playwright's testMatch takes *.spec.mjs
// only. The implementer turns it on by renaming it
// e2e/order-topbar-scroll.spec.mjs and adding it to the iphone
// project's testMatch in playwright.config.mjs.
//
// James, from production on an iPhone (2026-11-21): scrolled down to
// Payment with Place your order below it, the phone's sticky bar still
// read "» Chicken Sausage". Its one testable box:
//
// - On a phone (390 px, WebKit), scrolling from the catalog down to
//   Payment and Place your order, the top bar never shows a category
//   once the catalog has scrolled away: it shows what #327 says (no
//   name outside the catalog), at slow and fast scroll speeds.
//
// The page is set up as James's was: one item in the cart, and Chicken
// Sausage wholly out of stock (Sweet Italian is out in the catalog, so
// selling out the maple links empties it, as restock.spec does), which
// "In stock" hides with its outline link (order/restock.js). The other
// two boxes are the fix's commit and the existing checks (#204, #561:
// order-layout.spec's "the bar names the category under it" walks and
// test/sections.test.mjs), and have no test of their own here.

import {
  OrderPage, SKU, SUITE_STOCK, expect, stockApplied, test,
} from "./support/order.mjs";

const PHONE = { width: 390, height: 664 };

test.use({ stockPins: { ...SUITE_STOCK, [SKU.sausage]: 0 } });

// Walks the page from the top of the catalog to its foot in steps of
// `step` px, waiting two frames at each stop (the bar is written on
// the frame after the scroll event, order-form.js watchSections). At
// every stop where the catalog has scrolled away, no row showing below
// the stuck bar's lower edge by any amount, the bar must be blank and
// carry no chevron (#327). Returns what it saw.
const walk = (page, step) => page.evaluate(async (by) => {
  const frames = () => new Promise((done) => requestAnimationFrame(
    () => requestAnimationFrame(done)
  ));
  const catalog = document.getElementById("order-catalog");
  const rows = [...catalog.querySelectorAll(".order-item")]
    .filter((el) => el.getClientRects().length);
  const bar = document.querySelector(".order-topbar");
  const title = bar.querySelector("[data-topbar-title]");
  const payment = document.getElementById("payment");
  const confirm = document.getElementById("confirm");
  const start = catalog.getBoundingClientRect().top + scrollY;
  const foot = document.documentElement.scrollHeight - innerHeight;
  const stops = [];

  for (let y = start; y < foot; y += by) stops.push(Math.round(y));
  stops.push(foot);

  const wrong = [];
  let past = 0;
  let inPayment = 0;
  let inConfirm = 0;

  for (const y of stops) {
    window.scrollTo({ top: y, behavior: "instant" });
    await frames();

    const b = bar.getBoundingClientRect();
    const edge = b.top <= 0.5 ? b.bottom : 0;
    const gone = rows.every((el) => el.getBoundingClientRect().bottom
      <= edge);

    if (!gone) continue;
    past += 1;

    const p = payment.getBoundingClientRect();
    const c = confirm.getBoundingClientRect();

    if (p.top < edge && p.bottom > edge) inPayment += 1;
    if (c.top < innerHeight && c.bottom > edge) inConfirm += 1;

    const text = title.textContent.trim();
    const cat = title.parentElement.hasAttribute("data-cat");

    if (text !== "" || cat) {
      wrong.push({ y: Math.round(scrollY), text, cat });
    }
  }

  return { past, inPayment, inConfirm, wrong };
}, step);

test("on a phone, the top bar never shows a category once the catalog "
  + "has scrolled away, at slow and fast scroll speeds", async ({
  page, browserName,
}) => {
  test.skip(browserName !== "webkit", "the box is WebKit's, at 390 px");
  await page.setViewportSize(PHONE);

  const order = new OrderPage(page);

  await order.open({ wings: 1 });
  await stockApplied(page);
  // The page as James had it: one item, and Chicken Sausage hidden
  // with its outline link under "In stock".
  await expect(page.locator("#order-cart [data-cart-count]"))
    .toHaveText(/^1 item/);
  await expect(page.locator("#cat-sausage")).toBeHidden();

  const title = page.locator(".order-topbar [data-topbar-title]");

  // Slow: a little over a row's height at a time, as a thumb drags.
  // Fast: more than a screen at a time, as a flick lands.
  for (const [speed, step] of [["slow", 37], ["fast", 900]]) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await order.scrollSettled();

    const seen = await walk(page, step);

    expect(seen.past, `${speed}: stops past the catalog`)
      .toBeGreaterThan(0);
    expect(seen.inPayment, `${speed}: stops inside Payment`)
      .toBeGreaterThan(0);
    expect(seen.inConfirm, `${speed}: stops at Place your order`)
      .toBeGreaterThan(0);
    expect(seen.wrong, `${speed}: a category in the bar past the catalog`)
      .toEqual([]);
  }

  // Where James stopped: the middle of Payment, its top under the bar
  // and Place your order below. Reached by a smooth scroll from the
  // catalog, as a flick does, and checked once it is still.
  await page.evaluate(() => window.scrollTo(0, 0));
  await order.scrollSettled();
  await page.evaluate(() => {
    const p = document.getElementById("payment").getBoundingClientRect();

    window.scrollTo({
      top: scrollY + p.top + p.height / 2, behavior: "smooth",
    });
  });
  await order.scrollSettled();
  await expect(title).toHaveText("");
  await expect(page.locator(".order-topbar-title"))
    .not.toHaveAttribute("data-cat", /.*/);
});
