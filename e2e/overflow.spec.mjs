// #185: no page is wider than its viewport, at a phone's width, a
// tablet's, a small laptop's and a desktop's. bin/grid/check.mjs holds
// the built HTML to the grid; this sees what it can't: markup built by
// script, stylesheet overrides, and words too long to wrap.
//
// Every page in the sitemap is loaded, so a new page is covered
// without editing this file, plus the pages the sitemap leaves out
// (sign-in and the account) and the states built after load: the
// order page's cart holding several lines, product search showing
// results, and the account signed in. The account's answers and the
// order page's dates are canned, so this runs against a local build
// as well as staging, and creates nothing.
//
// A failure names the element that sticks out: the outermost one
// whose right edge passes the viewport's.

import { readFileSync } from "node:fs";

import { FULL_CART, OrderPage, expect, test } from "./support/order.mjs";
import { allDates } from "../assets/scripts/order/lib/dates.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import {
  addDays, today, weekday,
} from "../assets/scripts/order/lib/zoned.mjs";

const TERMS = JSON.parse(readFileSync(
  new URL("../data/delivery.json", import.meta.url), "utf8",
));

const WIDTHS = [375, 768, 992, 1440];

// Not in the sitemap. /account/ is left out: signed out, it sends you
// to /login/, and the signed-in test below covers it.
const UNLISTED = ["/login/", "/404.html"];

const ACCOUNT_TABS = ["orders", "receipts", "address", "settings", "help"];

const CUSTOMER = {
  email: "qa-e2e-overflow@example.com", name: "Ada Hen", firstName: "Ada",
  lastName: "Hen", phone: "4015550100", avatar: null, discountGroup: null,
  address: null, reminders: {}, marketing: false,
};

const ORDER = {
  id: "NFF-2609-QA85", status: "paid",
  submittedAt: "2026-09-26T14:00:00.000Z",
  paidAt: "2026-09-26T14:00:05.000Z", cancelRequested: false,
  lines: [{
    sku: "NFF-CHK-EGG-LG", label: "Eggs, large, one dozen", qty: 2,
    unitPrice: 7, lineTotal: 14,
  }],
  totals: { subtotal: 1400, discountAmount: 0, deliveryFee: 0, total: 1400 },
  code: null,
  customer: {
    firstName: "Ada", lastName: "Hen", phone: "4015550100", contact: "",
  },
  fulfilment: {
    method: "onfarm", date: "2026-10-03", state: "requested",
    onfarm: { window: "10 AM – 12 PM" },
  },
  notes: "",
  payments: [{
    at: "2026-09-26T14:00:05.000Z", amount: 1400, via: "square",
    method: "card", brand: "VISA", last4: "1111",
    receiptUrl: "https://squareupsandbox.com/receipt/preview/qa",
  }],
  refunds: [], returns: [], question: null,
  canCancel: true, canChange: true,
};

// The farm's pickup schedule is an environment setting (W11d), so
// /api/dates answers from a schedule of our own: each weekday of the
// next three weeks, a morning and an afternoon window.
const dates = () => {
  const now = new Date();
  const start = today(now, TERMS.timeZone);
  const days = [];

  for (let i = 1; i <= 21; i += 1) {
    const day = addDays(start, i);

    if (weekday(day) >= 1 && weekday(day) <= 5) {
      days.push(`${day} 09:00-12:00 13:00-17:00`);
    }
  }

  return allDates(now, TERMS, parseSchedule(days.join("\n")).windows);
};

// How far the page scrolls sideways, and, if it does, what sticks
// out. An element inside a box that clips or scrolls sideways can't
// widen the page, nor can a fixed one; of the rest, only the
// outermost is named, since its children stick out because it does.
const overflow = (page, width) => page.evaluate((viewport) => {
  const doc = document.documentElement;
  const scroll = Math.max(doc.scrollWidth, document.body.scrollWidth);

  if (scroll <= viewport) return null;

  const contained = (el) => {
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const style = getComputedStyle(a);

      if (style.position === "fixed") return true;
      if (a !== el && style.overflowX !== "visible") return true;
    }

    return false;
  };
  const sticksOut = (el) => el.getBoundingClientRect().right > viewport + 0.5
    && !contained(el);
  const name = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const classes = [...el.classList].slice(0, 3).map((c) => `.${c}`);

    return `${el.tagName.toLowerCase()}${id}${classes.join("")}`;
  };
  const culprits = [...document.body.querySelectorAll("*")]
    .filter((el) => sticksOut(el) && !sticksOut(el.parentElement))
    .map((el) => ({
      name: name(el),
      right: Math.round(el.getBoundingClientRect().right),
    }))
    .sort((a, b) => b.right - a.right)
    .slice(0, 3)
    .map(({ name: n, right }) => `${n} (right edge ${right}px)`);

  return `${scroll}px wide in a ${viewport}px viewport; ${
    culprits.join(", ") || "no single element found"}`;
}, width);

// Soft, so one run lists every page that sticks out.
const fits = async (page, width, what) => {
  await page.waitForLoadState("load");
  await page.evaluate(() => document.fonts.ready);
  expect.soft(await overflow(page, width), what).toBeNull();
};

const sitemap = async (request) => {
  const res = await request.get("/sitemap.xml");

  expect(res.ok(), "the sitemap loads").toBe(true);

  return [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map(([, loc]) => new URL(loc).pathname);
};

for (const width of WIDTHS) {
  test.describe(`at ${width}px (#185)`, () => {
    test.use({
      viewport: { width, height: 900 },
      ...(width < 768 ? { isMobile: true, hasTouch: true } : {}),
    });

    test.beforeEach(({ page }) => page.emulateMedia({
      reducedMotion: "reduce",
    }));

    test("every page fits", async ({ page, request }) => {
      const paths = [...await sitemap(request), ...UNLISTED];

      for (const path of paths) {
        await page.goto(path);
        await fits(page, width, path);
      }
    });

    // Until an image arrives, the browser sizes it from its width and
    // height attributes, and a lazy one arrives only near the screen.
    // A layout that needs the image to shrink it overflows meanwhile;
    // without images, every run sees that moment.
    test("every page fits before its images load",
      async ({ page, request }) => {
        const paths = [...await sitemap(request), ...UNLISTED];

        await page.route("**/*", (route) => (
          route.request().resourceType() === "image"
            ? route.abort()
            : route.fallback()
        ));
        for (const path of paths) {
          await page.goto(path);
          await fits(page, width, `${path}, no images`);
        }
      });

    test("the order page fits with a full cart", async ({ page }) => {
      const order = new OrderPage(page);
      const money = order.cart.locator("[data-cart-money-toggle]");

      await page.route("**/api/dates", (route) => route.fulfill({
        json: dates(),
      }));
      await order.open(FULL_CART);
      // Unfold the sums where they fold (below xl).
      if (await money.isEnabled()
        && await money.getAttribute("aria-expanded") === "false") {
        await money.click();
      }
      await fits(page, width, "/order/, cart open");

      await order.method("delivery");
      await fits(page, width, "/order/, delivery");
    });

    test("search fits with results showing", async ({ page }) => {
      const dialog = page.locator("#search-palette");

      await page.goto("/");
      await page.locator("[data-search-open]:visible").first().click();
      await expect(dialog).toHaveClass(/\bis-open\b/);
      await dialog.locator("#search-palette-input").fill("chicken");
      await expect(dialog.locator("#search-palette-list [role='option']")
        .first()).toBeVisible();
      await page.waitForTimeout(300);
      await fits(page, width, "search, results");
    });

    test("the account fits, signed in", async ({ page }) => {
      await page.route("**/api/me", (route) => route.fulfill({
        json: { signedIn: true, customer: CUSTOMER },
      }));
      await page.route("**/api/account/orders", (route) => route.fulfill({
        json: { orders: [ORDER] },
      }));

      for (const tab of ACCOUNT_TABS) {
        await page.goto(`/account/#${tab}`);
        await expect(page.locator("#account-app")).toBeVisible();
        await fits(page, width, `/account/#${tab}`);
      }
    });
  });
}
