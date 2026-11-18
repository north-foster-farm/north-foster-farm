// A saved draft keeps its pickup or delivery date through a reload
// (#284). The draft's date was set on the select while it held only
// "Loading dates...", so the browser dropped it and the first date on
// offer won when the list came. Each case picks the last date, never
// the first, and reloads with the list fast and slow. No order is
// placed.

import {
  OrderPage, expect, pickupChosen, pickupRadios, pickupValues, test,
} from "./support/order.mjs";
import { DROP, FOSTER, datesWith } from "./support/scheduled.mjs";

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

    test(`scheduled pickup keeps a market's occurrence, dates in ${
      delay} ms`, async ({ page }) => {
      const lists = datesWith();
      const order = new OrderPage(page);
      const answer = async (route) => {
        await new Promise((done) => setTimeout(done, delay));
        await route.fulfill({ json: lists });
      };

      await page.route("**/api/dates", answer);
      await order.open({ eggs: 1 }, { method: "scheduled" });
      await expect(pickupRadios(page).first())
        .toBeVisible({ timeout: 15_000 });

      // The market's last date, never the list's first.
      const value = (await pickupValues(page))
        .filter((v) => v.startsWith(`${FOSTER.series}-`)).at(-1);

      await page.locator(`#scheduled-pickups input[value='${value}']`)
        .check();
      await expect.poll(() => page.evaluate(() => JSON.parse(
        localStorage.getItem("nff-order-draft") || "{}"
      ).payload.fulfilment)).toMatchObject({
        method: "scheduled", occurrence: value,
      });
      await page.goto("/order/");
      await expect(pickupRadios(page).first())
        .toBeVisible({ timeout: 15_000 });
      await expect(pickupChosen(page)).toHaveValue(value);
    });

    test(`a draft saved before scheduled pickup restores the drop site, ${
      delay} ms`, async ({ page }) => {
      const lists = datesWith();
      const order = new OrderPage(page);
      const { date, occurrence } = lists.scheduled
        .filter((e) => e.series === DROP.series).at(-1);

      await page.route("**/api/dates", async (route) => {
        await new Promise((done) => setTimeout(done, delay));
        await route.fulfill({ json: lists });
      });
      // The shape an older page saved: method `scituate`, a date.
      await page.addInitScript((saved) => {
        if (!localStorage.getItem("nff-order-draft")) {
          localStorage.setItem("nff-order-draft", JSON.stringify({
            payload: {
              lines: [], customer: {},
              fulfilment: { method: "scituate", date: saved },
            },
          }));
        }
      }, date);
      await order.open();
      await expect(page.locator("#method-scheduled")).toBeChecked();
      await expect(pickupRadios(page).first())
        .toBeVisible({ timeout: 15_000 });
      await expect(pickupChosen(page)).toHaveValue(occurrence);
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
