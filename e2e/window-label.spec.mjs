// The shared window label in the browser (#616, James on PR #621,
// 2026-11-18: "The shared labels need to change too."). Every place
// the page writes a window outside the "Pickup time" radios reads in
// the same full format: "9:00 AM – 12:00 PM", never "noon". Criteria
// tests, written before the change; one test per reader, named for it.
// The radios themselves are e2e/onfarm-times.spec.mjs; the unit tests
// are test/window-label.criteria.mjs and the criteria copies beside it.
//
// The windows come from a schedule written here, through the real
// lib/dates.mjs, so they are known on any day the specs run.

import {
  OrderPage, expect, test,
} from "./support/order.mjs";
import { CUSTOMER, ORDER, dates } from "./support/canned.mjs";
import { onFarmDates } from "../assets/scripts/order/lib/dates.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import {
  addDays, label, today,
} from "../assets/scripts/order/lib/zoned.mjs";

const ZONE = "America/New_York";

// Two days ahead, a morning to noon and an afternoon.
const day = () => addDays(today(new Date(), ZONE), 2);

const lists = () => ({
  ...dates(),
  onfarm: onFarmDates(new Date(), { timeZone: ZONE },
    parseSchedule(`${day()} 09:00-12:00 13:00-17:00`).windows),
});

const answer = (page, body) => page.route(
  "**/api/dates", (route) => route.fulfill({ json: body }),
);

// The account page, signed in, with these orders.
const account = async (page, context, baseURL, orders) => {
  await context.addCookies([{
    name: "nff_signed_in", value: "1", url: baseURL,
  }]);
  await page.route("**/api/me", (route) => route.fulfill({
    json: { signedIn: true, customer: CUSTOMER },
  }));
  await page.route("**/api/account/orders", (route) => route.fulfill({
    json: { orders },
  }));
  await page.route("**/api/account/cart", (route) => route.fulfill({
    json: { ok: true, cart: null },
  }));
  await page.goto("/account/#orders");
};

// An on-farm order booked for 9:00 to 12:00 on `date`.
const booked = (date) => ({
  ...ORDER,
  fulfilment: {
    method: "onfarm", date, state: "requested",
    onfarm: { window: "09:00-12:00", from: "09:00", to: "12:00" },
  },
});

test.describe("the shared window label (#616)", () => {
  test("the order page's lapsed-pickup line reads the window in full",
    async ({ page }) => {
      const body = lists();

      await answer(page, body);
      await page.route("**/api/orders", (route) => (
        route.request().method() === "POST"
          ? route.fulfill({
            status: 409, json: { ok: false, dates: body.onfarm },
          })
          : route.fallback()
      ));

      const order = new OrderPage(page);

      await order.open({ eggs: 1 }, { method: "onfarm" });
      await page.locator("#onfarm-date").selectOption(day());
      await order.pickupTime();
      await order.contact({ email: "window-label@example.com" });
      await order.openCard();
      await order.card();
      await order.submit.click();

      const dialog = page.locator("#order-lapsed");
      const [first] = body.onfarm;

      await expect(dialog).toBeVisible();
      await dialog.getByLabel(`${first.label}, 1:00 – 5:00 PM`).check();
      await dialog.getByRole("button", { name: "Use this time" }).click();
      await expect(page.locator("[data-lapsed-status]")).toHaveText(
        `Pickup is now ${first.label}, 1:00 – 5:00 PM. Pay again to ` +
        "place your order."
      );
    });

  test("the account's order card reads its on-farm window in full",
    async ({ page, context, baseURL }) => {
      await answer(page, lists());
      await account(page, context, baseURL, [booked(day())]);

      const when = page.locator("[data-out='when']").first();

      await expect(when).toHaveText(
        `On-farm pickup, ${label(day())}, 9:00 AM – 12:00 PM`
      );
      await expect(when).not.toContainText(/noon/i);
    });

  test("Change pickup's booked time reads in full when the schedule " +
    "no longer has it", async ({ page, context, baseURL }) => {
    // The booked day is gone from the schedule: the form keeps just
    // the booked time.
    const gone = addDays(day(), 1);

    await answer(page, lists());
    await account(page, context, baseURL, [booked(gone)]);
    await page.getByRole("button", { name: /^Change (delivery|pickup)$/ })
      .first().click();

    const form = page.locator(".account-panel-form");

    await form.locator("[data-dates]").selectOption(gone);
    await expect(form.locator(`[data-dates] option[value='${gone}']`))
      .toHaveText(`On-farm pickup, ${label(gone)}, 9:00 AM – 12:00 PM ` +
        "(as booked)");
    await expect(form.locator("[data-windows] label")).toHaveText([
      "9:00 AM – 12:00 PM (as booked)",
    ]);
  });
});
