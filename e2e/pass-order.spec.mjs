// #182, the staging check: a delivery under the minimum, placed for
// real through POST /api/orders with a fee-waiving pass, reaches the
// Square sandbox with a $0 "Delivery fee" service charge and no
// discount line. The pass comes from the deploy's back office, as the
// farm's `passes issue --waive-fee` would make one; the order is
// refunded, closed and deleted after the run. delivery-pass.spec.mjs
// covers the page with the endpoint canned.

import terms from "../data/delivery.json" with { type: "json" };
import { NONCE, eggOrder, firstDate, postOrder } from "./support/api.mjs";
import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, closeOrder, deleteCustomer,
  deletePass, issuePass, orderRecord, squareOrder, teardown,
} from "./support/staging.mjs";

const EGGS = 700;

test.describe("a fee-waiving pass in Square (#182)", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  const email = uniqueEmail("pass");
  const made = [];
  let code;
  let since;

  test.beforeAll(async () => {
    since = new Date();
    code = await issuePass({ email, waiveFee: true });
  });

  test.afterAll(() => teardown([
    ...made.map((id) => () => closeOrder(id)),
    () => deleteCustomer(email),
    () => clearMail({ to: email, since }),
    () => deletePass(code),
  ]));

  test("takes a small delivery with no fee, and Square gets a $0 charge",
    async ({ request }) => {
      const payload = await eggOrder(request, { email, nonce: NONCE.ok });

      payload.customer.phone = "401-555-0100";
      payload.fulfilment = {
        method: "delivery",
        date: await firstDate(request, "delivery"),
        onfarm: {},
        delivery: {
          address1: "1 Main St", town: "Foster", zip: "02825",
          cooler: "Porch",
        },
      };
      payload.pass = code;
      payload.claimedTotal = EGGS;

      expect(EGGS).toBeLessThan(terms.money.deliveryMinimum * 100);

      const { status, body } = await postOrder(request, payload);

      expect(status, JSON.stringify(body)).toBe(200);
      made.push(body.orderId);

      const record = await orderRecord(body.orderId);

      expect(record.pass).toBe(code);
      expect(record.passWaivesFee).toBe(true);
      expect(record.totals.deliveryFee).toBe(0);
      expect(record.totals.feeWaived).toBe(true);
      expect(record.totals.total).toBe(EGGS);

      const square = await squareOrder(body.orderId);

      expect(square.serviceCharges).toEqual([{
        name: "Delivery fee", amount: 0,
      }]);
      expect(square.discounts).toEqual([]);
      expect(square.total).toBe(EGGS);
      expect(square.fulfillments[0].type).toBe("DELIVERY");
    });
});
