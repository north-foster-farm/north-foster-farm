// A failed stock check fails closed (#333): the first load retries
// with a backoff while the skeleton shows, then the page says ordering
// is paused, shuts Add and the cart's way to payment, keeps asking, and
// opens again on the first good answer without a reload. /api/stock is
// held with page.route, and the page's clock is the test's, so the
// 2, 5 and 15 second waits cost nothing.

import { OrderPage, expect, test } from "./support/order.mjs";

const down = (route) => route.fulfill({
  status: 500, json: { message: "down" },
});

// Answers 500 until `state.up`, then passes through to the real one.
const flaky = async (page, state) => {
  state.asked = 0;
  await page.route("**/api/stock", async (route) => {
    state.asked += 1;
    if (state.up) await route.continue();
    else await down(route);
  });
};

const open = async (page, cart) => {
  await page.clock.install();
  await page.goto(`/order/${cart ? `?add=${cart}` : ""}`);
};

test.describe("stock that cannot be checked", () => {
  test("retries, then shuts the page behind a danger alert",
    async ({ page }) => {
      const state = { up: false };

      await flaky(page, state);
      await open(page);

      const callout = page.locator("#order-stock-down");

      // Skeleton first; nothing is said during the backoff.
      await page.clock.runFor(1_000);
      await expect(callout).toBeHidden();
      await page.clock.runFor(2_000 + 5_000 + 15_000 + 1_000);
      await expect(callout).toBeVisible();
      await expect(callout).toHaveClass(/alert-danger/);
      await expect(callout).toContainText("Ordering is paused");
      await expect(callout.locator("a[href^='tel:']")).toBeVisible();
      await expect(callout.locator("a[href^='mailto:']")).toBeVisible();
      expect(state.asked).toBe(4);

      const order = new OrderPage(page);

      await expect(order.item("eggs").locator("[data-step='1']").first())
        .toBeDisabled();
      await expect(order.qty("eggs")).toBeDisabled();
      // The old line of text with a Try again link is gone.
      await expect(page.locator("#order-catalog .skeleton-failed"))
        .toHaveCount(0);
    });

  test("opens by itself when stock answers, with no reload",
    async ({ page }) => {
      const state = { up: false };

      await flaky(page, state);
      await open(page);
      await page.clock.runFor(40_000);

      const callout = page.locator("#order-stock-down");
      const order = new OrderPage(page);

      await expect(callout).toBeVisible();
      await page.evaluate(() => {
        window.sameDocument = true;
      });
      state.up = true;
      // The background check, every 30 seconds.
      await page.clock.runFor(31_000);
      await expect(callout).toBeHidden();
      await expect(order.item("eggs").locator("[data-step='1']").first())
        .toBeEnabled();
      expect(await page.evaluate(() => window.sameDocument)).toBe(true);
    });

  test("Check again asks at once", async ({ page }) => {
    const state = { up: false };

    await flaky(page, state);
    await open(page);
    await page.clock.runFor(40_000);

    const callout = page.locator("#order-stock-down");

    await expect(callout).toBeVisible();
    state.up = true;
    await callout.getByRole("button", { name: "Check again" }).click();
    await expect(callout).toBeHidden();
  });

  test("a later failed refresh keeps the last stock, quietly",
    async ({ page }) => {
      const state = { up: true };

      await flaky(page, state);
      await open(page);
      await page.clock.runFor(1_000);

      const callout = page.locator("#order-stock-down");
      const order = new OrderPage(page);

      await expect(order.item("eggs").locator("[data-step='1']").first())
        .toBeEnabled();
      state.up = false;
      // Two minutes on: the refresh fails.
      await page.clock.runFor(2 * 60_000 + 1_000);
      await expect(callout).toBeHidden();
      await expect(order.item("eggs").locator("[data-step='1']").first())
        .toBeEnabled();
    });

  test("an unreachable stock sends the farm a browser report",
    async ({ page }) => {
      const state = { up: false };
      const reports = [];

      await page.route("**/api/health", async (route) => {
        reports.push(route.request().postDataJSON());
        await route.fulfill({ status: 202, json: { ok: true } });
      });
      await flaky(page, state);
      await open(page);
      await page.clock.runFor(40_000);
      await expect.poll(() => reports.some(
        (r) => r && r.where === "stock.unavailable"
      )).toBe(true);
    });
});
