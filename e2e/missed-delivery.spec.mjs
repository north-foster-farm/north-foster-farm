// #193: after a delivery the customer missed, the account page says
// the order is held and what they can do, the cancel panel says the fee
// stays, and the order page counts the kept fee against a change. The
// account's endpoints are canned, so this runs on a local build as on
// staging, and nothing is saved anywhere.

import { CUSTOMER, ORDER, cannedDates } from "./support/canned.mjs";
import { expect, test } from "./support/order.mjs";

// $56 of eggs and a $5 delivery fee, delivered on Thursday the 24th,
// missed, the fee kept, and held until the 1st.
const MISSED = {
  ...ORDER,
  id: "NFF-2609-QA93",
  lines: [{ ...ORDER.lines[0], qty: 8, lineTotal: 56 }],
  totals: { subtotal: 5600, discountAmount: 0, deliveryFee: 500,
    total: 6100 },
  fulfilment: {
    method: "delivery", date: "2026-09-24", state: "agreed", onfarm: null,
    delivery: { address1: "1 Main St", town: "Foster", zip: "02825",
      cooler: "Porch" },
  },
  payments: [{ ...ORDER.payments[0], amount: 6100 }],
  question: { kind: "missed", reason: "", until: "2026-10-01",
    openedAt: "2026-09-24T18:00:00.000Z", answeredAt: null },
  keptFee: 500,
};

const setUp = async (page, context, baseURL, order = MISSED) => {
  await context.addCookies([{
    name: "nff_signed_in", value: "1", url: baseURL,
  }]);
  await page.route("**/api/me", (route) => route.fulfill({
    json: { signedIn: true, customer: CUSTOMER },
  }));
  await page.route("**/api/account/orders", (route) => route.fulfill({
    json: { orders: [order] },
  }));
  await page.route("**/api/account/cart", (route) => route.fulfill({
    json: { ok: true, cart: null },
  }));
  await cannedDates(page);
};

test.describe("a missed delivery", () => {
  test("the account card says it is held, and what to do (draft)",
    async ({ page, context, baseURL }) => {
      await setUp(page, context, baseURL);
      await page.goto("/account/#orders");

      await expect(page.locator("[data-out='pickup']").first()).toHaveText(
        "We couldn't deliver this order, so we're holding it until " +
        "Thursday, October 1. Choose another delivery day (with another " +
        "delivery fee) or a pickup with Change items, or cancel it for a " +
        "refund of $56. If we don't hear from you by then, we'll cancel " +
        "it and refund you, though the delivery fee of $5 isn't " +
        "refunded because we made the trip.",
      );
    });

  test("the cancel panel says the fee stays (draft)",
    async ({ page, context, baseURL }) => {
      await setUp(page, context, baseURL);
      await page.goto("/account/#orders");
      await page.getByRole("button", { name: "Cancel order" }).first()
        .click();

      await expect(page.locator("[data-out='explain']")).toContainText(
        "The delivery fee of $5 isn't refunded because we made the trip.",
      );
    });

  test("a waived miss keeps nothing back",
    async ({ page, context, baseURL }) => {
      await setUp(page, context, baseURL, { ...MISSED, keptFee: 0 });
      await page.goto("/account/#orders");

      await expect(page.locator("[data-out='pickup']").first()).toContainText(
        "Choose another delivery day or a pickup with Change items, or " +
        "cancel it for a refund of $61. If we don't hear from you by " +
        "then, we'll cancel it and refund you in full.",
      );
      await page.getByRole("button", { name: "Cancel order" }).first()
        .click();
      await expect(page.locator("[data-out='explain']")).not.toContainText(
        "isn't refunded",
      );
    });

  test("the order page counts the kept fee against a change (draft)",
    async ({ page, context, baseURL }) => {
      await setUp(page, context, baseURL);
      await page.goto(`/order/?edit=${MISSED.id}`);

      const money = page.locator("[data-edit-money]");

      await expect(money.locator("[data-total='paid']")).toHaveText("$61");
      await expect(money.locator("[data-edit-kept]")).toBeVisible();
      await expect(money.locator("[data-total='kept']")).toHaveText("−$5");
    });

  test("the booked day, now past, is not offered back",
    async ({ page, context, baseURL }) => {
      await setUp(page, context, baseURL);
      await page.goto(`/order/?edit=${MISSED.id}`);

      const select = page.locator("#delivery-date");

      await expect(page.locator("[data-edit-money] [data-total='paid']"))
        .toHaveText("$61");
      await expect(select).toBeEnabled();
      await expect(select.locator("option[value^='20']").first())
        .toBeAttached();
      await expect(select.locator(
        `option[value="${MISSED.fulfilment.date}"]`,
      )).toHaveCount(0);
      await expect(select).not.toHaveValue(MISSED.fulfilment.date);
    });
});
