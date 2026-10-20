// Loading skeletons (#271): every region that fills in after the page
// shows the same bars while its request is held, swaps in the content
// without moving the page, and says so with a Try again when the
// request fails or never answers. Each request is held with
// page.route and answered on cue, as search.spec.mjs does, and every
// answer is canned, so this runs on a local build as on staging.

import {
  CUSTOMER, ORDER, cannedDates, dates,
} from "./support/canned.mjs";
import { expect, test } from "./support/order.mjs";

const SHOW_AFTER_MS = 150;
const GIVE_UP_MS = 10_000;

// Holds every request matching `url` until release() answers it with
// `answer` (route.fulfill's options), or with route.continue() if none.
const hold = async (page, url, answer) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });

  await page.route(url, async (route) => {
    await held;
    if (answer) await route.fulfill(answer);
    else await route.continue();
  });

  return () => release();
};

// Layout shifts, recorded from the first paint, with the regions their
// moved nodes sat in: a swap that shifts nothing adds nothing.
const watchShifts = (page) => page.addInitScript(() => {
  window.qaShifts = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) window.qaShifts.push(entry);
    }
  }).observe({ type: "layout-shift", buffered: true });
});

// -> the CLS since `from` (a performance.now() mark): of nodes inside
// `selector`, and of the whole page.
const shiftsSince = (page, from, selector) => page.evaluate(
  ([since, sel]) => {
    const region = document.querySelector(sel);
    const after = window.qaShifts.filter((e) => e.startTime >= since);
    const sum = (list) => list.reduce((s, e) => s + e.value, 0);

    return {
      region: sum(after.filter((e) => e.sources.some((s) => s.node
        && region && region.contains(s.node)))),
      page: sum(after),
    };
  },
  [from, selector],
);

const now = (page) => page.evaluate(() => performance.now());

// Asserts the region is loading with its bars up.
const loading = async (region) => {
  await expect(region).toHaveAttribute("data-load", "shown");
  await expect(region).toHaveAttribute("aria-busy", "true");
  await expect(region.locator(".skeleton-status").first())
    .toHaveText("Loading…");
  await expect(region.locator(".skeleton").first())
    .toHaveAttribute("aria-hidden", "true");
};

// Asserts the region has settled, its bars gone.
const settled = async (region) => {
  await expect(region).not.toHaveAttribute("data-load", /./);
  await expect(region).not.toHaveAttribute("aria-busy", /./);
  await expect(region.locator(".skeleton").first()).toBeHidden();
};

const json = (body) => ({ json: body });
const STOCK = json({ items: {} });

test.describe("loading skeletons (#271)", () => {
  test.beforeEach(async ({ page }) => {
    await watchShifts(page);
  });

  test("a quick answer never shows the bars", async ({ page }) => {
    let shown = false;

    await page.route("**/api/me", (route) => route.fulfill(json({
      signedIn: true, customer: CUSTOMER,
    })));
    await page.route("**/api/account/orders", (route) => route.fulfill(
      json({ orders: [ORDER] }),
    ));
    await page.exposeFunction("qaShown", () => { shown = true; });
    await page.addInitScript(() => {
      new MutationObserver((changes) => {
        if (changes.some((c) => c.target.dataset.load === "shown")) {
          window.qaShown();
        }
      }).observe(document, {
        attributes: true, attributeFilter: ["data-load"], subtree: true,
      });
    });
    await page.goto("/account/");
    await expect(page.locator("#account-app")).toBeVisible();
    expect(shown).toBe(false);
  });

  test("the top bar holds the Sign in link's place", async ({ page }) => {
    const release = await hold(page, "**/api/me", json({
      signedIn: true, customer: CUSTOMER,
    }));

    await page.goto("/about/");

    // The header row's slot, from md up, or the phone menu's.
    const slot = page.locator("[data-account]").first();

    await page.waitForTimeout(SHOW_AFTER_MS + 100);
    await loading(slot);

    const from = await now(page);

    release();
    await settled(slot);
    await expect(slot.locator("[data-account-menu]")).not.toHaveAttribute(
      "hidden", /.*/,
    );
    expect((await shiftsSince(page, from, "header")).region).toBeLessThan(
      0.01,
    );
  });

  test("the account page: bars, the swap, no shift", async ({ page }) => {
    const release = await hold(page, "**/api/me", json({
      signedIn: true, customer: CUSTOMER,
    }));

    await page.route("**/api/account/orders", (route) => route.fulfill(
      json({ orders: [ORDER, { ...ORDER, id: "NFF-2609-QA86" }] }),
    ));
    await page.goto("/account/");

    const region = page.locator("#account-region");

    // Loading from the first paint, its place kept.
    await expect(region).toHaveAttribute("aria-busy", "true");
    await loading(region);
    await expect(page.locator("#account-app")).toBeHidden();

    const from = await now(page);

    release();
    await settled(region);
    await expect(page.locator("#account-app")).toBeVisible();
    await expect(page.locator("#account-name")).toHaveText(CUSTOMER.name);

    const shifts = await shiftsSince(page, from, "#account-region");

    expect(shifts.region).toBeLessThan(0.01);
    expect(shifts.page).toBeLessThan(0.05);
  });

  test("the account page fails with Try again", async ({ page }) => {
    let answers = 0;

    await page.route("**/api/me", (route) => route.fulfill(json({
      signedIn: true, customer: CUSTOMER,
    })));
    await page.route("**/api/account/orders", (route) => {
      answers += 1;

      return route.fulfill(answers === 1
        ? { status: 500, json: { error: "Stubbed." } }
        : json({ orders: [ORDER] }));
    });
    await page.goto("/account/");

    const region = page.locator("#account-region");
    const failed = region.locator(".skeleton-failed");

    await expect(failed).toBeVisible();
    await expect(failed).toContainText("We couldn't load your account.");
    await expect(region).toHaveAttribute("data-load", "failed");
    await expect(region).not.toHaveAttribute("aria-busy", /./);
    await failed.getByRole("link", { name: "Try again" }).click();
    await settled(region);
    await expect(page.locator("#account-app")).toBeVisible();
  });

  test("a request that never answers gives up after ten seconds",
    async ({ page }) => {
      await hold(page, "**/api/me");
      await page.goto("/account/");

      const region = page.locator("#account-region");

      await loading(region);
      await page.waitForTimeout(GIVE_UP_MS - 1000);
      await expect(region).toHaveAttribute("data-load", "shown");
      await expect(region.locator(".skeleton-failed")).toBeVisible({
        timeout: 3000,
      });
      await expect(region.getByRole("link", { name: "Try again" }))
        .toBeVisible();
    });

  test("the order page: stock, dates, prefill and the card form",
    async ({ page, context, baseURL }) => {
      // The session stamp says someone may be signed in, so the
      // prefill waits under its skeletons.
      await context.addCookies([{
        name: "nff_signed_in", value: "qa", url: baseURL,
      }]);

      const stock = await hold(page, "**/api/stock", STOCK);
      const lists = await hold(page, "**/api/dates", json(dates()));
      const who = await hold(page, "**/api/me", json({
        signedIn: true, customer: CUSTOMER,
      }));
      const config = await hold(page, "**/api/checkout/config",
        json({ off: true }));

      await page.goto("/order/");

      const catalog = page.locator("#order-catalog");
      const date = page.locator("[data-dates-region]").first();
      const name = page.locator("[data-prefill-region]").first();

      await loading(catalog);
      await expect(catalog.locator(".order-qty .skeleton").first())
        .toBeVisible();
      await loading(date);
      await loading(name);

      // The card form loads once its section is near.
      await page.locator("#payment").scrollIntoViewIfNeeded();

      const card = page.locator("#pay-card-panel");

      await loading(card);
      await page.evaluate(() => window.scrollTo(0, 0));

      const from = await now(page);

      stock();
      lists();
      who();
      await settled(catalog);
      await settled(date);
      await settled(name);
      await expect(page.locator("#customer-first-name"))
        .toHaveValue(CUSTOMER.firstName);
      await expect(page.locator("#onfarm-date")).toBeEnabled();

      const shifts = await shiftsSince(page, from, "#order-form");

      expect(shifts.region).toBeLessThan(0.01);

      config();
      await settled(card);
    });

  test("the order page's dates fail with Try again", async ({ page }) => {
    let answers = 0;

    await page.route("**/api/stock", (route) => route.fulfill(STOCK));
    await page.route("**/api/dates", (route) => {
      answers += 1;

      return route.fulfill(answers === 1
        ? { status: 500, json: { error: "Stubbed." } }
        : json(dates()));
    });
    await page.goto("/order/");

    const date = page.locator("[data-dates-region]").first();
    const failed = date.locator(".skeleton-failed");

    await expect(failed).toContainText("We couldn't load the dates.");
    await failed.getByRole("link", { name: "Try again" }).click();
    await settled(date);
    await expect(page.locator("#onfarm-date")).toBeEnabled();
  });

  test("the contact page's order picker", async ({ page }) => {
    await page.route("**/api/me", (route) => route.fulfill(json({
      signedIn: true, customer: CUSTOMER,
    })));

    const release = await hold(page, "**/api/account/orders",
      json({ orders: [ORDER] }));

    await page.goto("/contact/");

    const region = page.locator("[data-contact-orders-region]");

    await loading(region);

    const from = await now(page);

    release();
    await settled(region);
    await expect(page.locator("#contact-order option")).toHaveCount(2);
    expect((await shiftsSince(page, from, "#contact-form")).region)
      .toBeLessThan(0.01);
  });

  test("news: the next page comes under bars of its rows",
    async ({ page }) => {
      const release = await hold(page, "**/news/page/2/");

      await page.goto("/news/");

      const more = page.locator("[data-news-more]");
      const before = await page.locator(".news-item").count();

      await page.evaluate(() => window.scrollBy(0, 20_000));
      await loading(more);
      await expect(more.locator(".news-item")).toHaveCount(3);
      release();
      await settled(more);
      await expect.poll(() => page.locator(".news-years .news-item").count())
        .toBeGreaterThan(before);
    });

  test("search: the stock badges wait under bars", async ({ page }) => {
    const release = await hold(page, "**/api/stock", STOCK);

    await page.goto("/about/");
    await page.locator("[data-search-open]").click();

    const body = page.locator(".search-palette-body");
    const price = page.locator(".search-palette-row-price").first();

    await loading(body);
    await expect(price.locator(".skeleton")).toBeVisible();
    release();
    await settled(body);
    await expect(price).toHaveText(/^\$/);
  });

  test("the bars are still when motion is reduced", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await cannedDates(page);
    await hold(page, "**/api/stock", STOCK);
    await page.goto("/order/");

    const bar = page.locator("#order-catalog .skeleton .placeholder").first();

    await expect(bar).toBeVisible();
    expect(await bar.evaluate((el) => getComputedStyle(el).animationName))
      .toBe("none");
  });
});
