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
  OrderPage, expect, pickupChosen, test, uniqueEmail,
} from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, closeOrder, deleteCustomer,
  linkIn, orderRecord, teardown, waitForMail,
} from "./support/staging.mjs";

const SIGN_IN = "Your secure sign-in link to North Foster Farm";
const ORDER_ID = /^NFF-\d{4}-[A-Z2-9]{6}$/;
const DROP_SITE = "VFVQ";

test.describe.configure({ mode: "serial" });

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

      const when = order.result.locator("[data-out='when']");

      await expect(when).toContainText(`at ${market.name}.`);
      await expect(when).not.toContainText("the drop site");

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

    await page.goto(linkIn(mail, /\/api\/auth\/verify\?token=/));
    await expect(page).toHaveURL(/\/account\/?/);
    await page.goto("/account/#orders");
    await expect(page.locator("#orders-list")).toContainText(orderId);

    const when = page.locator("[data-out='when']").first();

    await expect(when).toContainText(`at ${market.name}`);

    await page.getByRole("button", { name: /^Change (delivery|pickup)$/ })
      .first().click();

    const select = page.locator("[data-dates]");

    await expect(select).toHaveValue(chosen);
    await expect(select.locator(`option[value='${drop.occurrence}']`))
      .toHaveCount(1);
    await select.selectOption(drop.occurrence);
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

      expect(updated.text).toContain(orderId);
      expect(updated.text).toMatch(/drop site/i);
      expect(updated.text).not.toContain(market.name);

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
