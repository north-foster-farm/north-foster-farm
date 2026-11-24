// A member's credit (#471): signed in, the account page shows the
// group and the balance; on the order page the credit comes off by
// itself and, covering the order, places it with nothing charged, at a
// round chosen under Group orders (#749).
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
import { followLink } from "./support/request-error.mjs";
import {
  GROUP_ORDERS, choose, pick, radioValues,
} from "./support/vff.mjs";

const GROUP = "vff";
const SERIES = "36TS";
const GYM = "The Village Family Fitness";
// $100 of credit against three whole chickens, $60 less the $5 tier.
const CREDIT = 10_000;

// No retries (#693): a retry would grant the credit again and place a
// second order, paid by it.
test.describe.configure({ retries: 0 });

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
      await followLink(page, (await op("login", { email })).url);
      await expect(page.locator("#account-app")).toBeVisible();

      // The head: the balance on the Sign out line, and no group's
      // name (#608).
      const head = page.locator("#account-app .account-head");

      await expect(head.getByText("Credit: $100", { exact: true }))
        .toBeVisible();
      await expect(head).not.toContainText(GYM, { useInnerText: true });

      const order = new OrderPage(page);

      await order.open({ whole: 3 });
      // The account's group unlocks its rounds with no code, under
      // Group orders (#749; under Pick-up days until then).
      const group = await choose(order, GROUP_ORDERS);

      await expect.poll(async () => (await radioValues(group))
        .some((v) => v.startsWith(`${SERIES}-`))).toBe(true);
      const round = (await radioValues(group))
        .find((v) => v.startsWith(`${SERIES}-`));

      await pick(page, group.locator(`input[value='${round}']`));
      expect(await pickupValues(page))
        .not.toContainEqual(expect.stringMatching(`^${SERIES}-`));
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
      await expect(head.getByText("Credit: $45", { exact: true }))
        .toBeVisible();
    });
});
