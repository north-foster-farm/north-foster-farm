// A customer cancels a paid order from the account page (AO-07): the
// order card's Cancel order, then Yes, cancel it. The refund goes back
// through the sandbox at once, the order is cancelled, and both the
// customer and the farm are told. The order is placed through the API
// with Square's approved sandbox nonce, and deleted after.

import { NONCE, eggOrder, postOrder } from "./support/api.mjs";
import { expect, test, uniqueEmail } from "./support/order.mjs";
import { signIn } from "./support/session.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, closeOrder, deleteCustomer,
  orderRecord, teardown, waitForMail,
} from "./support/staging.mjs";

test.describe("a customer cancels a paid order", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  const email = uniqueEmail("cancel");
  let orderId;
  let since;

  test.beforeAll(async ({ request }) => {
    since = new Date();

    const { status, body } = await postOrder(request, await eggOrder(
      request, { email, nonce: NONCE.ok }
    ));

    expect(status, JSON.stringify(body)).toBe(200);
    orderId = body.orderId;
  });

  test.afterAll(() => teardown([
    () => (orderId ? closeOrder(orderId) : null),
    () => deleteCustomer(email),
    () => clearMail({ to: email, since }),
  ]));

  test("the refund goes back at once, and both are told",
    { tag: "@regression" }, async ({ page }) => {
      const asked = new Date();

      await signIn(page, email);
      await page.goto("/account/#orders");
      await page.getByRole("button", { name: "Cancel order" }).click();

      const yes = page.getByRole("button", { name: "Yes, cancel it" });

      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith(
          `/api/account/orders/${orderId}/cancel`
        )),
        yes.click(),
      ]);

      expect(res.status(), await res.text()).toBe(200);
      await expect(yes).toBeHidden();

      const record = await orderRecord(orderId);

      // The record's own account of a cancel that did not complete.
      expect(record.status, JSON.stringify({
        cancelRequested: record.cancelRequested, refunds: record.refunds,
        history: (record.history || []).slice(-6),
      })).toBe("cancelled");
      expect(record.cancelRequested).toBeFalsy();
      expect(record.refunds.map((r) => [r.amount, r.source, r.total]))
        .toEqual([[700, "customer", true]]);
      expect(record.refunds[0].squareRefundId).toBeTruthy();

      const mail = await waitForMail({
        to: email, subject: "Your order is canceled", since: asked,
      });

      expect(mail.text).toContain("as requested");
      expect(mail.text).toContain("A refund of $7 is on its way.");

      const farm = await waitForMail({
        subject: `Canceled: ${orderId} by ${email}`, since: asked,
      });

      expect(farm.text).toContain("We refunded $7 automatically");
    });
});
