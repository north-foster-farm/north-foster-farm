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

// Answers 500 until `state.up`, then passes through to the real one,
// which carries the test's own pins (eggs in plenty, #507). The 500 is
// what's under test, and no pin can give one.
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

// Runs the page clock through the first load's backoff (2, 5 then 15
// seconds) until the page says ordering is paused. Each retry is timed
// when its failure comes back over the real network, so wait for each
// ask before the clock moves on.
const shut = async (page, state) => {
  const asked = (n) => expect.poll(() => state.asked).toBe(n);

  await asked(1);
  await page.clock.runFor(2_000);
  await asked(2);
  await page.clock.runFor(5_000);
  await asked(3);
  await page.clock.runFor(15_000);
  await asked(4);
  await page.clock.runFor(1_000);
};

test.describe("stock that cannot be checked", () => {
  test("retries, then shuts the page behind a danger alert",
    async ({ page }) => {
      const state = { up: false };

      await flaky(page, state);
      await open(page);

      const callout = page.locator("#order-stock-down");

      // Skeleton first; nothing is said during the backoff. The clock
      // is the test's but the answers are the network's: each retry is
      // timed when its failure comes back, so wait for each ask before
      // running the clock to the next (2, 5 then 15 seconds).
      const asked = (n) => expect.poll(() => state.asked).toBe(n);

      await asked(1);
      await page.clock.runFor(1_000);
      await expect(callout).toBeHidden();
      await page.clock.runFor(1_000);
      await asked(2);
      await page.clock.runFor(5_000);
      await asked(3);
      await page.clock.runFor(15_000);
      await asked(4);
      await page.clock.runFor(1_000);
      await expect(callout).toBeVisible();
      await expect(callout).toHaveClass(/alert-danger/);
      await expect(callout).toContainText("Ordering isn't available right now");
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
      await shut(page, state);

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

  test("Try again asks at once", async ({ page }) => {
    const state = { up: false };

    await flaky(page, state);
    await open(page);
    await shut(page, state);

    const callout = page.locator("#order-stock-down");

    await expect(callout).toBeVisible();
    state.up = true;
    await callout.getByRole("button", { name: "Try again" }).click();
    await expect(callout).toBeHidden();
  });

  test("a later failed refresh keeps the last stock, quietly",
    async ({ page }) => {
      const state = { up: true };

      await flaky(page, state);
      await open(page);

      const callout = page.locator("#order-stock-down");
      const order = new OrderPage(page);

      // The first good answer must be in before stock goes down: the
      // Add buttons are enabled under the skeleton, and a slow first
      // answer on a real deploy would still be loading, or retrying on
      // the page clock, when the two minutes run.
      await expect.poll(async () => {
        await page.clock.runFor(1_000);

        return page.locator("#order-catalog").getAttribute("data-load");
      }, { timeout: 30_000 }).toBeNull();
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
      await shut(page, state);
      await expect.poll(() => reports.some(
        (r) => r && r.where === "stock.unavailable"
      )).toBe(true);
    });
});
