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
    await page.route("**/api/me", (route) => route.fulfill(json({
      signedIn: true, customer: CUSTOMER,
    })));
    await page.route("**/api/account/orders", (route) => route.fulfill(
      json({ orders: [ORDER] }),
    ));
    // Each region's states, timed in the page. A stubbed answer is
    // quick, but on a busy run it can still take longer than the
    // 150 ms the bars wait, and then they rightly show.
    await page.addInitScript(() => {
      window.qaLoads = [];
      new MutationObserver((changes) => {
        for (const c of changes) {
          window.qaLoads.push([
            c.target.id || c.target.className, c.target.dataset.load || "",
            performance.now(),
          ]);
        }
      }).observe(document, {
        attributes: true, attributeFilter: ["data-load"], subtree: true,
      });
    });
    await page.goto("/account/");
    await expect(page.locator("#account-app")).toBeVisible();

    const loads = await page.evaluate(() => window.qaLoads);
    const regions = [...new Set(loads.map(([region]) => region))];

    for (const region of regions) {
      const own = loads.filter(([r]) => r === region);
      const began = own.find(([, state]) => state === "wait")?.[2];
      const shown = own.find(([, state]) => state === "shown")?.[2];
      const done = own.find(([, state]) => state === "")?.[2];

      if (began === undefined) continue;
      // The bars never come sooner than 150 ms, and an answer within
      // it never shows them.
      if (shown !== undefined) {
        expect(shown - began, region).toBeGreaterThanOrEqual(
          SHOW_AFTER_MS - 5
        );
      }
      if (done !== undefined && done - began < SHOW_AFTER_MS) {
        expect(shown, region).toBeUndefined();
      }
    }
  });

  test("the top bar holds the Sign in link's place", async ({ page }) => {
    const release = await hold(page, "**/api/me", json({
      signedIn: true, customer: CUSTOMER,
    }));

    await page.goto("/about/");

    // The header row's slot: with the links from md up, with the
    // actions below md (#303).
    const slot = page.locator("header [data-account]:visible");

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

  test("the top bar covers only the account slot (#322)",
    async ({ page }) => {
      const release = await hold(page, "**/api/me", json({
        signedIn: false,
      }));

      await page.goto("/about/");

      const slot = page.locator("header [data-account]:visible");

      await page.waitForTimeout(SHOW_AFTER_MS + 100);
      await loading(slot);

      const bar = await slot.locator(".skeleton-over").boundingBox();
      const actions = await page.locator("header .site-actions")
        .first().boundingBox();

      // Never the whole row of icons, search and the menu button too.
      expect(bar.width).toBeLessThan(actions.width * 0.6);
      release();
      await settled(slot);
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
    await expect(page.locator("#account-email")).toHaveText(CUSTOMER.email);

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
    // The site's alert component (#333).
    await expect(failed).toHaveClass(/\balert\b/);
    await expect(region).toHaveAttribute("data-load", "failed");
    await expect(region).not.toHaveAttribute("aria-busy", /./);
    await failed.getByRole("link", { name: "Try again" }).click();
    await settled(region);
    await expect(page.locator("#account-app")).toBeVisible();
  });

  test("a request that never answers gives up after ten seconds",
    async ({ page }) => {
      // The region's states, timed in the page: a wait out here also
      // counts how slow the run is, and on a busy runner the region had
      // given up before a 9 s wait here ended.
      await page.addInitScript(() => {
        window.e2eLoads = [];
        new MutationObserver(() => {
          const region = document.getElementById("account-region");
          const state = region && region.dataset.load;
          const last = window.e2eLoads[window.e2eLoads.length - 1];

          if (state && (!last || last[0] !== state)) {
            window.e2eLoads.push([state, performance.now()]);
          }
        }).observe(document, {
          subtree: true, attributes: true, attributeFilter: ["data-load"],
        });
      });
      await hold(page, "**/api/me");
      await page.goto("/account/");

      const region = page.locator("#account-region");

      await expect(region.locator(".skeleton-failed")).toBeVisible({
        timeout: GIVE_UP_MS + 5000,
      });

      const states = await page.evaluate(() => window.e2eLoads);
      const at = (name) => states.find(([state]) => state === name)?.[1];

      // Waiting, then the bars, then the failure, ten seconds on.
      expect(states.map(([state]) => state)).toEqual([
        "wait", "shown", "failed",
      ]);
      expect(at("failed") - at("wait")).toBeGreaterThanOrEqual(
        GIVE_UP_MS - 100
      );
      expect(at("failed") - at("wait")).toBeLessThanOrEqual(
        GIVE_UP_MS + 1000
      );
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
    // Every answer fails until the page has seen Try again pressed.
    // The page also retries by itself, 2 s after a failure, and hides
    // the link while it does; had that retry succeeded, a slow run
    // lost the link before it could press it.
    // The press is noted here, in the test, since Try again may reload
    // the page; a request that beats the note waits for it a moment.
    let tried = false;

    await page.exposeFunction("e2eTried", () => {
      tried = true;
    });
    await page.addInitScript(() => {
      document.addEventListener("click", (e) => {
        if (e.target.closest(".skeleton-failed a")) window.e2eTried();
      }, true);
    });
    await page.route("**/api/stock", (route) => route.fulfill(STOCK));
    await page.route("**/api/dates", async (route) => {
      if (!tried) await new Promise((r) => setTimeout(r, 500));

      return route.fulfill(tried
        ? json(dates())
        : { status: 500, json: { error: "Stubbed." } });
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
