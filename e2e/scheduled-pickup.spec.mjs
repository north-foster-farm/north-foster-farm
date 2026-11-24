// Scheduled pickup, end to end (#315, the last piece of #309): a
// customer places a market order from the order page, finds it on the
// account page, moves it to the drop site there, and the emails that
// follow are in the staging outbox, the list the emails library shows
// under "Sent, every session". Each piece's own spec covers its part
// (order-scheduled, account, orders-api); this one crosses them.
//
// Runs on staging with the live schedule: it needs one market or
// pop-up occurrence and one drop site occurrence open for pickup, and
// skips, saying so, where the schedule opens fewer. Written, not run,
// while e2e is paused. docs/qa-launch.md, OP-02 and AR-13.

import {
  OrderPage, expect, pickupChosen, placedList, placedRow, seriesStreet,
  test, uniqueEmail,
} from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, closeOrder, deleteCustomer,
  linkIn, orderRecord, teardown, waitForMail,
} from "./support/staging.mjs";
import { followLink } from "./support/request-error.mjs";

const SIGN_IN = "Your secure sign-in link to North Foster Farm";
const ORDER_ID = /^NFF-\d{4}-[A-Z2-9]{6}$/;
const DROP_SITE = "VFVQ";

// No retries (#693): a retry would pay again and reuse a one-time link.
test.describe.configure({ mode: "serial", retries: 0 });

test.describe("a market order, moved to the drop site", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  const email = uniqueEmail("sched");
  let orderId;
  let since;
  let market;
  let drop;
  let chosen;

  test.beforeAll(async ({ request }) => {
    since = new Date();

    const res = await request.get("/api/dates");
    const { scheduled = [] } = res.ok() ? await res.json() : {};

    market = scheduled.find((e) => e.series !== DROP_SITE);
    drop = scheduled.find((e) => e.series === DROP_SITE);
  });

  test.afterAll(() => teardown([
    () => (orderId ? closeOrder(orderId) : null),
    () => deleteCustomer(email),
    () => clearMail({ to: email, since }),
  ]));

  test("the order page places a market order", { tag: "@regression" },
    async ({ page }) => {
      test.skip(!market, "No market or pop-up is open for pickup.");
      test.skip(!drop, "The drop site has no occurrence open for pickup.");

      const order = new OrderPage(page);

      await order.open({ eggs: 1 });
      chosen = await order.scheduled(market.series);
      await expect(pickupChosen(page)).toHaveValue(chosen);
      await order.contact({ first: "Sched", email });
      await order.openCard();
      await order.card();

      const { status, body } = await order.pay();

      expect(status, JSON.stringify(body)).toBe(200);
      orderId = body.orderId;
      expect(orderId).toMatch(ORDER_ID);

      // The panel gives the market's street (#723).
      const receiving = placedList(order.result, "Receiving your order");

      await expect(placedRow(receiving, /pick-?\s?up address/i))
        .toContainText(seriesStreet(market.series));
      await expect(receiving).not.toContainText("the drop site");

      const record = await orderRecord(orderId);

      expect(record.fulfilment).toMatchObject({
        method: "scheduled", occurrence: chosen, date: market.date,
      });
    });

  test("the account page shows the order, and moves it to the drop " +
    "site", { tag: "@regression" }, async ({ page }) => {
    test.skip(!orderId, "The order was not placed.");

    const asked = new Date();

    await page.goto("/login/");
    await page.locator("#login-email").fill(email);
    await page.locator("#login-submit").click();

    const mail = await waitForMail({ to: email, subject: SIGN_IN,
      since: asked });

    await followLink(page, linkIn(mail, /\/api\/auth\/verify\?token=/));
    await expect(page).toHaveURL(/\/account\/?/);
    await page.goto("/account/#orders");
    await expect(page.locator("#orders-list")).toContainText(orderId);

    const when = page.locator("[data-out='when']").first();

    await expect(when).toContainText(`at ${market.name}`);

    await page.getByRole("button", { name: /^Change (delivery|pickup)$/ })
      .first().click();

    // A radio per pickup in the pickup-days layout (#703).
    const form = page.locator(".account-panel-form");
    const radio = (value) => form.locator(`input[type='radio'][value='${
      value}']`);

    await expect(radio(chosen)).toBeChecked();
    await expect(radio(drop.occurrence)).toHaveCount(1);
    await radio(drop.occurrence).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(when).toContainText("at the drop site");
    await expect(when).not.toContainText(market.name);

    await expect.poll(async () => (await orderRecord(orderId)).fulfilment)
      .toMatchObject({
        method: "scheduled", occurrence: drop.occurrence, date: drop.date,
      });
  });

  test("the emails are in the outbox, naming the drop site",
    async () => {
      test.skip(!orderId, "The order was not placed.");

      // To the customer, on the move; to the farm, a notice. Both sit
      // in the library's "Sent, every session" list.
      const updated = await waitForMail({
        to: email, subject: "Your order is updated", since,
      });

      // The customer's email names the drop site by its place, as
      // every email does since #490, and the market only in its
      // "Before:" line (#544: the first run with a market open).
      const before = (updated.text.match(/Before:[^\n]*/) || [""])[0];

      expect(updated.text).toContain(orderId);
      expect(updated.text).toContain(`Where: ${drop.place}`);
      expect(before).toContain(market.name);
      expect(updated.text.replace(before, "")).not.toContain(market.name);

      const farm = await waitForMail({
        subject: `Pickup moved: ${orderId}`, since,
      });

      expect(farm.text).toMatch(/drop site/i);

      // The order's own confirmation named the market.
      const placed = await waitForMail({
        to: email, subject: "Your order is confirmed", since,
      });

      expect(placed.text).toContain(market.name);
    });
});
