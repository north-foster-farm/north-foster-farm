// Criteria tests for #627: the delivery countdown names its date, so
// it can't seem to name a different Thursday from the "Delivery day"
// select under it. They fail until the notice changes; nothing turns
// them on. The old sentence's one assertion here, forms.spec.mjs's
// "the delivery countdown names the next delivery day", retired into
// the first test below.
//
// The clock: /api/dates is answered with the canned lists and `now`
// pinned to James's screenshot on #626, Wednesday 18 November 2026,
// 6:09 AM (30 s past, so the test's own seconds never take a minute
// off). The page anchors its clock to that `now`, so the delivery
// days on offer are Thursday 19 November and, Thanksgiving week
// skipped, Thursday 3 December. No order is placed.

import { readFileSync } from "node:fs";

import { dates } from "./support/canned.mjs";
import { OrderPage, expect, test } from "./support/order.mjs";
import { deliveryDates } from "../assets/scripts/order/lib/dates.mjs";

const TERMS = JSON.parse(readFileSync(
  new URL("../data/delivery.json", import.meta.url), "utf8",
));

const NOW = "2026-11-18T11:09:30.000Z";
const FIRST = "Thursday, November 19";
const LATER = { date: "2026-12-03", label: "Thursday, December 3" };
const SENTENCE = "Order within 5 hours and 50 minutes for delivery on "
  + `${FIRST}.`;

const pinned = (page) => page.route("**/api/dates", (route) =>
  route.fulfill({
    json: {
      ...dates(), now: NOW, delivery: deliveryDates(new Date(NOW), TERMS),
    },
  }));

// A draft saved earlier for delivery on the later Thursday.
const draftFor = (page, date) => page.addInitScript((saved) => {
  if (!localStorage.getItem("nff-order-draft")) {
    localStorage.setItem("nff-order-draft", JSON.stringify({
      payload: {
        lines: [], customer: {},
        fulfilment: { method: "delivery", date: saved },
      },
      savedAt: Date.now(),
    }));
  }
}, date);

test.describe("the countdown names its date (#627)", () => {
  test("names the date of the day it counts down to, for every method "
    + "it serves", async ({ page }) => {
    const order = new OrderPage(page);
    const text = page.locator("[data-countdown-text]");

    await pinned(page);
    await order.open({ wings: 5 }, { method: "delivery" });
    await expect(text).toHaveText(SENTENCE);
    await expect(text).toBeVisible();
    // Delivery is the only way with a countdown.
    await expect(page.locator("[data-countdown]")).toHaveCount(1);
    await expect(page.locator(
      "[data-method-body='delivery'] [data-countdown]"
    )).toHaveCount(1);
  });

  test("the countdown and the Delivery day select can no longer seem "
    + "to name different Thursdays", async ({ page }) => {
    const order = new OrderPage(page);
    const text = page.locator("[data-countdown-text]");
    const select = page.locator("#delivery-date");

    await pinned(page);
    await order.open({ wings: 5 }, { method: "delivery" });
    await select.selectOption(LATER.date);
    await expect(select.locator("option:checked")).toHaveText(LATER.label);

    // The notice names the first day by the select's own words for it,
    // and those words are not the chosen day's.
    const first = await select.locator("option").first().textContent();

    expect(first).toBe(FIRST);
    await expect(text).toHaveText(SENTENCE);
    await expect(text).not.toContainText(LATER.label);
  });

  test("a draft that wants a later day opens with the notice naming "
    + "the first day's date", async ({ page }) => {
    const order = new OrderPage(page);
    const text = page.locator("[data-countdown-text]");
    const select = page.locator("#delivery-date");

    await pinned(page);
    await draftFor(page, LATER.date);
    await order.open();
    await expect(page.locator("#method-delivery")).toBeChecked();
    await expect(select).toBeEnabled({ timeout: 15_000 });
    await expect(select).toHaveValue(LATER.date);
    await expect(select.locator("option:checked")).toHaveText(LATER.label);
    await expect(text).toBeVisible();
    await expect(text).toHaveText(SENTENCE);
  });
});
