// The farm's refunds and cancels (RF-01 to RF-03), as the CLI makes
// them: a partial card refund, a cancel that sends everything back,
// and a cancel the farm says sends nothing. Each order is placed
// through the API with Square's approved sandbox nonce. The refunds
// are asserted on the record, with the sandbox's refund id, and the
// customer's "Your order is canceled" in the outbox. Closed and
// deleted after.

import { NONCE, eggOrder, postOrder } from "./support/api.mjs";
import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, closeOrder, deleteCustomer,
  nff, orderRecord, teardown, waitForMail,
} from "./support/staging.mjs";

const CANCELED = "Your order is canceled";

test.describe.configure({ mode: "serial" });

test.describe("the farm refunds and cancels", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  const email = uniqueEmail("refund");
  const orders = {};
  let since;

  const place = async (request, name) => {
    const { status, body } = await postOrder(request, await eggOrder(
      request, { email, nonce: NONCE.ok }
    ));

    expect(status, JSON.stringify(body)).toBe(200);
    orders[name] = body.orderId;

    return body.orderId;
  };

  test.beforeAll(() => { since = new Date(); });

  test.afterAll(() => teardown([
    ...Object.values(orders).map((id) => () => closeOrder(id)),
    () => deleteCustomer(email),
    () => clearMail({ to: email, since }),
  ]));

  test("RF-01: a partial refund leaves the order paid, and the rest " +
    "is refused above what is left", async ({ request }) => {
    const id = await place(request, "partial");

    await nff(["orders", "refund", id, "--reason=Short one dozen",
      "--amount-cents=500"]);

    const record = await orderRecord(id);

    expect(record.status).toBe("paid");
    expect(record.refunds).toHaveLength(1);
    expect(record.refunds[0]).toMatchObject({
      amount: 500, source: "farm", total: false,
    });
    expect(record.refunds[0].squareRefundId).toBeTruthy();

    // $2 is left; a second $5 is more than the order holds.
    await expect(nff(["orders", "refund", id, "--amount-cents=500"]))
      .rejects.toThrow(/must be between \$0\.01 and \$2/);
    expect((await orderRecord(id)).refunds).toHaveLength(1);
  });

  test("RF-02: a cancel sends everything back and says so",
    async ({ request }) => {
      const id = await place(request, "cancel");
      const asked = new Date();

      await nff(["orders", "cancel", id, "--reason-text=Test order."]);

      const record = await orderRecord(id);

      expect(record.status).toBe("cancelled");
      expect(record.refunds.map((r) => [r.amount, r.source, r.total]))
        .toEqual([[700, "farm", true]]);
      expect(record.refunds[0].squareRefundId).toBeTruthy();

      const mail = await waitForMail({
        to: email, subject: CANCELED, since: asked,
      });

      expect(mail.text).toContain("Test order.");
      expect(mail.text).toContain("A refund of $7 is on its way.");
    });

  test("RF-03: a cancel the farm says sends nothing back",
    async ({ request }) => {
      const id = await place(request, "keep");
      const asked = new Date();

      await nff(["orders", "cancel", id, "--no-refund",
        "--reason-text=Test order."]);

      const record = await orderRecord(id);

      expect(record.status).toBe("cancelled");
      expect(record.refunds || []).toEqual([]);

      const mail = await waitForMail({
        to: email, subject: CANCELED, since: asked,
      });

      expect(mail.text).not.toContain("refund of");
    });
});
