// A saved draft keeps its pickup or delivery date through a reload
// (#284). The draft's date was set on the select while it held only
// "Loading dates...", so the browser dropped it and the first date on
// offer won when the list came. Each case picks the last date, never
// the first, and reloads with the list fast and slow. No order is
// placed.

import { OrderPage, expect, test } from "./support/order.mjs";

const lastDate = (select) => select.locator("option").evaluateAll(
  (options) => options.map((o) => o.value).filter(Boolean).at(-1)
);

const delayDates = (page, ms) => page.route("**/api/dates", async (r) => {
  await new Promise((done) => setTimeout(done, ms));
  await r.continue();
});

test.describe("a draft's date (#284)", () => {
  for (const delay of [0, 2500]) {
    test(`on-farm keeps its date and window, dates in ${delay} ms`,
      async ({ page }) => {
        const order = new OrderPage(page);
        const select = page.locator("#onfarm-date");
        const windows = page.locator("[name='onfarm.window']");

        await order.open({ eggs: 1 }, { method: "onfarm" });

        const date = await lastDate(select);

        await select.selectOption(date);
        await page.locator(`label[for='${
          await windows.last().getAttribute("id")}']`).click();
        await expect(windows.last()).toBeChecked();

        const win = await windows.last().getAttribute("value");

        await expect.poll(() => page.evaluate(
          () => localStorage.getItem("nff-order-draft") || ""
        )).toContain(win);
        await delayDates(page, delay);
        await page.goto("/order/");
        await expect(select).toBeEnabled({ timeout: 15_000 });
        await expect(select).toHaveValue(date);
        await expect(page.locator(`[name='onfarm.window'][value='${win}']`))
          .toBeChecked();
      });

    test(`delivery keeps its date, dates in ${delay} ms`, async ({ page }) => {
      const order = new OrderPage(page);
      const select = page.locator("#delivery-date");

      await order.open({ eggs: 1 });
      await order.delivery();
      await expect(select).toBeEnabled();

      const date = await lastDate(select);

      await select.selectOption(date);
      await expect.poll(() => page.evaluate(
        () => localStorage.getItem("nff-order-draft") || ""
      )).toContain(date);
      await delayDates(page, delay);
      await page.goto("/order/");
      await expect(select).toBeEnabled({ timeout: 15_000 });
      await expect(select).toHaveValue(date);
    });
  }
});
