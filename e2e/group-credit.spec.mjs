// A member's credit (#471): signed in, the account page shows the
// group and the balance; on the order page the credit comes off by
// itself and, covering the order, places it with nothing charged.
// Runs on the local build with fake payments and on staging against
// the real Square sandbox, where the zero-pay call is the real one
// (fakes audit, 6426321360): the back office makes the member, grants
// the credit and signs them in.

import {
  OrderPage, expect, pickupValues, test, uniqueEmail,
} from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearSession, op, teardown,
} from "./support/staging.mjs";

const GROUP = "vff";
const SERIES = "36TS";
const GYM = "The Village Family Fitness";
// $100 of credit against three whole chickens, $60 less the $5 tier.
const CREDIT = 10_000;

test.describe("a member's credit (#471)", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  const email = uniqueEmail("credit");
  let orderId;

  test.beforeAll(async () => {
    await op("groupCode", { key: GROUP });
    await op("customerJoin", { email, key: GROUP });
    await op("creditGrant", { email, amount: CREDIT, round: email });
  });

  test.afterAll(() => teardown([
    () => (orderId ? op("orderDelete", { id: orderId },
      { allowFail: true }) : null),
    () => op("creditClear", { email }, { allowFail: true }),
    () => op("customerDelete", { email }, { allowFail: true }),
  ]));

  test("shows on the account page and pays an order whole",
    async ({ page, context }) => {
      await clearSession(context);
      await page.goto((await op("login", { email })).url);
      await expect(page.locator("#account-app")).toBeVisible();

      // The head's right: the group and the balance.
      const member = page.locator("#account-member");

      await expect(member).toBeVisible();
      await expect(member.locator("[data-member-group]")).toHaveText(GYM);
      await expect(member.locator("[data-member-credit]"))
        .toHaveText("Credit: $100");

      const order = new OrderPage(page);

      await order.open({ whole: 3 }, { method: "scheduled" });
      // The account's group unlocks the gym with no code.
      await expect.poll(async () => (await pickupValues(page))
        .some((v) => v.startsWith(`${SERIES}-`))).toBe(true);
      await order.scheduled(SERIES);
      await order.contact({ first: "Credit", email });

      // $55 of credit covers it: nothing to pay, no card.
      const note = page.locator("[data-credit-note]");

      await expect(note).toBeVisible();
      await expect(note)
        .toHaveText("Your credit covers this order: $55, nothing to pay.");
      await expect(page.locator("#pay-card-panel")).toBeHidden();
      await expect(order.submit).toBeVisible();
      await expect(order.submit).toBeEnabled();

      const { status, body } = await order.pay();

      expect(status, JSON.stringify(body)).toBe(200);
      orderId = body.orderId;
      expect(body.totals.total).toBe(0);
      expect(body.totals.credit).toBe(5500);
      expect(body.payment.via).toBe("credit");
      await expect(order.result).toBeVisible();

      // The record: the credit as the one tender, and the Square
      // order made and paid as zero where Square is real.
      const { order: placed } = await op("orderShow", { id: orderId });

      expect(placed.payments.map((p) => [p.via, p.amount]))
        .toEqual([["credit", 5500]]);
      expect(placed.creditFrom).toBe(email);
      expect(placed.square && placed.square.squareOrderId).toBeTruthy();

      // The balance on the account page follows.
      await page.goto("/account/");
      await expect(member.locator("[data-member-credit]"))
        .toHaveText("Credit: $45");
    });
});
