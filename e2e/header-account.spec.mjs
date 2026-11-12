// The header's account slot from the first paint (#565). The page
// draws Sign in and it shows at once, with /api/me still out. A page
// with the session stamp is marked signed in before the paint
// (scripts/session/hint.js): Sign in never shows there, and the
// Account button holds its place until the answer fades it in. The
// header never shifts either way. /api/me is held and answered with a
// canned body, so this runs on a local build as on staging.

import { CUSTOMER } from "./support/canned.mjs";
import { expect, test } from "./support/order.mjs";

// Holds /api/me until release() answers it with `body`.
const holdMe = async (page, body) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });

  await page.route("**/api/me", async (route) => {
    await held;
    await route.fulfill({ json: body });
  });

  return () => release();
};

// Layout shifts from the first paint, and the slot's look at that
// paint: each slot's Sign in opacity and display, read in the first
// animation frame, before the deferred bundle can have run.
const watch = (page) => page.addInitScript(() => {
  window.qaShifts = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) window.qaShifts.push(entry);
    }
  }).observe({ type: "layout-shift", buffered: true });

  window.qaFirst = null;
  const look = () => {
    const links = document.querySelectorAll("[data-account-signin]");

    if (!links.length) {
      requestAnimationFrame(look);

      return;
    }
    window.qaFirst = Array.from(links, (link) => {
      const style = getComputedStyle(link);

      return { opacity: style.opacity, display: style.display };
    });
  };

  requestAnimationFrame(look);
});

// -> every layout shift since the first paint, each source named with
// its box before and after, and whether it is in the header. An
// entry's value is the whole page's for that frame, so a header link
// among its sources is no measure of the header's own share: a font
// swap once reflowed the body and the header's links in one entry.
const shifts = (page) => page.evaluate(() => {
  const header = document.querySelector("header");
  const box = (r) => [r.x, r.y, r.width, r.height].map(Math.round);
  const name = (node) => {
    if (!node) return "(gone)";
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return `text "${node.textContent.trim().slice(0, 20)}"`;
    }
    const classes = Array.from(node.classList, (c) => `.${c}`).join("");

    return `${node.localName}${classes}`;
  };

  return window.qaShifts.map((entry) => ({
    at: Math.round(entry.startTime),
    value: entry.value,
    sources: entry.sources.map((s) => ({
      node: name(s.node),
      header: Boolean(s.node && header.contains(s.node)),
      from: box(s.previousRect),
      to: box(s.currentRect),
    })),
  }));
});

// Fails, listing every shift, when a node in the header moved or
// changed size since the first paint.
const expectNoHeaderShift = async (page) => {
  const all = await shifts(page);
  const moved = all.flatMap((e) => e.sources).filter((s) => s.header);

  expect(moved, `layout shifts: ${JSON.stringify(all, null, 1)}`)
    .toEqual([]);
};

const slot = (page) => page.locator("header [data-account]:visible");

test.describe("the header's account slot (#565)", () => {
  test.beforeEach(async ({ page }) => {
    await watch(page);
  });

  test("signed out: Sign in shows from the first paint", async ({ page }) => {
    const release = await holdMe(page, { signedIn: false });

    await page.goto("/about/");

    const signin = slot(page).locator("[data-account-signin]");

    // The answer is still out, and no bar covers the link.
    await expect(signin).toBeVisible();
    await expect(signin).toHaveCSS("opacity", "1");
    await expect(slot(page)).not.toHaveAttribute("data-load", /./);
    await expect.poll(() => page.evaluate(() => window.qaFirst))
      .not.toBeNull();
    for (const first of await page.evaluate(() => window.qaFirst)) {
      expect(first.opacity).toBe("1");
    }

    release();
    await expect(signin).toBeVisible();
    await expect(slot(page).locator("[data-account-menu]")).toBeHidden();
    await expectNoHeaderShift(page);
  });

  test("signed in: no Sign in, and the button keeps its place",
    async ({ page, context, baseURL }) => {
      await context.addCookies([{
        name: "nff_signed_in", value: "qa", url: baseURL,
      }]);

      const release = await holdMe(page, {
        signedIn: true, customer: CUSTOMER,
      });

      await page.goto("/about/");

      const button = slot(page).locator("[data-account-menu]");

      await expect.poll(() => page.evaluate(() => window.qaFirst))
        .not.toBeNull();
      for (const first of await page.evaluate(() => window.qaFirst)) {
        expect(first.display).toBe("none");
      }
      await expect(slot(page).locator("[data-account-signin]")).toBeHidden();

      // The slot's box: on a phone the bar may stand in the button's
      // place by now, at its size.
      const before = await slot(page).boundingBox();

      expect(before.width).toBeGreaterThan(0);

      release();
      await expect(button).toBeVisible();
      await expect(button).toHaveCSS("opacity", "1");
      await expect(slot(page).locator("[data-account-signin]")).toBeHidden();

      const after = await slot(page).boundingBox();

      expect(after.x).toBeCloseTo(before.x, 0);
      expect(after.width).toBeCloseTo(before.width, 0);
      await expectNoHeaderShift(page);
    });

  test("a stamp with no session behind it falls back to Sign in",
    async ({ page, context, baseURL }) => {
      await context.addCookies([{
        name: "nff_signed_in", value: "qa", url: baseURL,
      }]);
      await page.route("**/api/me", (route) => route.fulfill({
        json: { signedIn: false },
      }));

      await page.goto("/about/");

      await expect(slot(page).locator("[data-account-signin]"))
        .toBeVisible();
      await expect(slot(page).locator("[data-account-menu]")).toBeHidden();
    });

});

// With scripts off nothing can fill the header, so what shows is what
// the page drew: Sign in and every other link in the row.
test.describe("the header with scripts off (#565)", () => {
  test.use({ javaScriptEnabled: false });

  test("shows Sign in and the row's links", async ({ page }) => {
    await page.goto("/about/");

    const signin = slot(page).locator("[data-account-signin]");

    await expect(signin).toBeVisible();
    await expect(signin).toHaveCSS("opacity", "1");

    const header = page.locator("header");
    // From md up the text links sit in the row; below it they fold
    // into the menu, and the row has Order, search and the toggle.
    const names = test.info().project.name === "desktop"
      ? ["News", "About", "Contact", "Order"]
      : ["Order"];

    for (const name of names) {
      await expect(header.getByRole("link", { name, exact: true }))
        .toBeVisible();
    }
    await expect(header.getByRole("button", { name: "Search products" }))
      .toBeVisible();
  });
});
