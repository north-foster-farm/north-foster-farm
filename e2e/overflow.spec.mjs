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
//
// Against staging the page walks are paced (#653): at full speed,
// eight walks of 29 loads each from one address, Netlify's bot
// challenge answered them partway in. So the file runs its tests in
// order in one worker (never two walks at once), and each walk waits
// PACE_MS (support/pace.mjs) between page loads. The other three
// tests at each width keep their pace; they only queue behind the
// walks, as they already did with fullyParallel off. A local build
// makes no wait.

import { pace } from "./support/pace.mjs";
import {
  FULL_CART, OrderPage, expect, test, unfoldCart,
} from "./support/order.mjs";
import {
  ACCOUNT_TABS, cannedDates, keepHome, signedIn, sitemap,
} from "./support/canned.mjs";

const WIDTHS = [375, 768, 992, 1440];

// In order, in one worker, whatever fullyParallel says (#653).
test.describe.configure({ mode: "default" });

// Not in the sitemap. /account/ is left out: signed out, it sends you
// to /login/, and the signed-in test below covers it.
const UNLISTED = ["/login/", "/404.html"];

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

for (const width of WIDTHS) {
  test.describe(`at ${width}px (#185)`, () => {
    test.use({
      viewport: { width, height: 900 },
      isMobile: width < 768,
      hasTouch: width < 768,
    });

    test.beforeEach(async ({ page, baseURL }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await keepHome(page, baseURL);
    });

    test("every page fits", async ({ page, request, baseURL }) => {
      const paths = [...await sitemap(request), ...UNLISTED];

      for (const [i, path] of paths.entries()) {
        if (i) await pace(baseURL);
        await page.goto(path);
        await fits(page, width, path);
      }
    });

    // Until an image arrives, the browser sizes it from its width and
    // height attributes, and a lazy one arrives only near the screen.
    // A layout that needs the image to shrink it overflows meanwhile;
    // without images, every run sees that moment.
    test("every page fits before its images load",
      async ({ page, request, baseURL }) => {
        const paths = [...await sitemap(request), ...UNLISTED];

        await page.route("**/*", (route) => (
          route.request().resourceType() === "image"
            ? route.abort()
            : route.fallback()
        ));
        for (const [i, path] of paths.entries()) {
          if (i) await pace(baseURL);
          await page.goto(path);
          await fits(page, width, `${path}, no images`);
        }
      });

    test("the order page fits with a full cart", async ({ page }) => {
      const order = new OrderPage(page);

      await cannedDates(page);
      await order.open(FULL_CART);
      // Open the cart where it floats folded (below xl).
      if (await order.cart.getAttribute("data-placement") === "floating") {
        await unfoldCart(order);
      }
      await fits(page, width, "/order/, cart open");

      await order.method("delivery");
      await fits(page, width, "/order/, delivery");
    });

    // #402: the field in the header row from 992 px, the magnifier's
    // bar below.
    test("search fits with results showing", async ({ page }) => {
      const field = page.getByRole("combobox", { name: /search/i });
      const region = page.getByRole("search").filter({ has: field });

      await page.goto("/");
      if (width >= 992) {
        await field.click();
      } else {
        await page.getByRole("banner")
          .getByRole("button", { name: /search/i }).click();
      }
      await expect(field).toBeFocused();
      await field.fill("chicken");
      await expect(region.getByRole("option").first()).toBeVisible();
      await page.waitForTimeout(300);
      await fits(page, width, "search, results");
    });

    test("the account fits, signed in", async ({ page }) => {
      await signedIn(page);
      for (const tab of ACCOUNT_TABS) {
        await page.goto(`/account/#${tab}`);
        await expect(page.locator("#account-app")).toBeVisible();
        await fits(page, width, `/account/#${tab}`);
      }
    });
  });
}
