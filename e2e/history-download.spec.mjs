// #165: the account's Orders and Receipts tabs each save the whole
// history as a CSV, and neither button shows with no orders. The
// account is canned (support/canned.mjs), so this runs on a local
// build as on staging, without signing in.

import { readFile } from "node:fs/promises";

import { CUSTOMER, ORDER, signedIn } from "./support/canned.mjs";
import { expect, test } from "./support/order.mjs";

const save = async (page, name) => {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name }).click(),
  ]);

  const text = await readFile(await download.path(), "utf8");

  // A byte-order mark first, so Excel reads it as UTF-8.
  expect(text[0]).toBe("\uFEFF");

  return {
    file: download.suggestedFilename(),
    rows: text.slice(1).trimEnd().split("\r\n"),
  };
};

test.describe("history downloads (#165)", () => {
  test("Orders saves every order, one row each", async ({ page }) => {
    await signedIn(page);
    await page.goto("/account/#orders");

    const { file, rows } = await save(page, "Download all orders (CSV)");

    expect(file).toMatch(/^north-foster-farm-orders-\d{4}-\d\d-\d\d\.csv$/);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^Order,/);
    expect(rows[1]).toContain(ORDER.id);
    expect(rows[1]).toContain("2 x Eggs, large, one dozen");
    expect(rows[1]).toContain("14.00");
  });

  test("Receipts saves each payment, with its receipt", async ({ page }) => {
    await signedIn(page);
    await page.goto("/account/#receipts");

    const { file, rows } = await save(page,
      "Download all receipts (CSV)");

    expect(file).toMatch(/^north-foster-farm-receipts-\d{4}-\d\d-\d\d\.csv$/);
    expect(rows).toEqual([
      "Date,Order,Kind,Amount,Paid with,From,Receipt",
      `2026-09-26,${ORDER.id},Payment,14.00,Visa ending 1111,,${
        ORDER.payments[0].receiptUrl}`,
    ]);
  });

  test("neither button shows with no orders", async ({ page }) => {
    await page.route("**/api/me", (route) => route.fulfill({
      json: { signedIn: true, customer: CUSTOMER },
    }));
    await page.route("**/api/account/orders", (route) => route.fulfill({
      json: { orders: [] },
    }));
    await page.goto("/account/#orders");
    await expect(page.locator("#orders-empty")).toBeVisible();
    await expect(page.locator("[data-download]")).toHaveCount(2);
    await expect(page.locator("[data-download]:visible")).toHaveCount(0);
  });
});
