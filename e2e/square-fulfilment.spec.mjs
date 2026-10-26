// #328, #455: what the farm does to an order reaches its Square order.
// Fulfilling closes the order and its fulfillment there; cancelling
// cancels the fulfillment. The orders are placed through the API with
// Square's sandbox nonce, then fulfilled or cancelled the way the CLI
// does (the back office's ops), and Square's own copy is read back.
// Square's state is asserted only against the sandbox: the fake driver
// of a local build keeps nothing to read. Every order is refunded,
// closed and deleted afterwards.

import { eggOrder, postOrder } from "./support/api.mjs";
import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, closeOrder, deleteCustomer,
  op, orderRecord, teardown,
} from "./support/staging.mjs";

test.describe.configure({ mode: "serial" });

test.describe("the farm's actions reach the Square order", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  const made = [];
  const emails = [];
  let since;

  test.beforeAll(() => {
    since = new Date();
  });

  test.afterAll(() => teardown([
    ...made.map((id) => () => closeOrder(id)),
    ...emails.flatMap((email) => [
      () => deleteCustomer(email),
      () => clearMail({ to: email, since }),
    ]),
  ]));

  const place = async (request, tag) => {
    const email = uniqueEmail(tag);

    emails.push(email);

    const { status, body } = await postOrder(request, await eggOrder(
      request, { email }
    ));

    expect(status, JSON.stringify(body)).toBe(200);
    made.push(body.orderId);

    return body.orderId;
  };

  const square = async (id) => (await op("squareOrder", { id }));

  test("fulfilling an order completes its Square order and fulfillment",
    { tag: "@regression" }, async ({ request }) => {
      const id = await place(request, "fulfil");
      const before = await square(id);

      if (!before.fake) {
        expect(before.squareOrder.state).toBe("OPEN");
        expect(before.squareOrder.fulfillments).toHaveLength(1);
        expect(before.squareOrder.fulfillments[0].state)
          .not.toMatch(/^(COMPLETED|CANCELED)$/);
      }

      await op("orderFulfil", { id });

      const record = await orderRecord(id);

      expect(record.status).toBe("fulfilled");
      expect(record.flags && record.flags.squareOutOfSync).toBeFalsy();

      const after = await square(id);

      if (after.fake) return;
      expect(after.squareOrder.state).toBe("COMPLETED");
      expect(after.squareOrder.fulfillments.map((f) => f.state))
        .toEqual(["COMPLETED"]);
    });

  test("cancelling an order cancels its Square fulfillment",
    { tag: "@regression" }, async ({ request }) => {
      const id = await place(request, "cancel");

      await op("orderCancel", { id, reasonText: "QA e2e" });

      const record = await orderRecord(id);

      expect(record.status).toBe("cancelled");
      expect(record.flags && record.flags.squareOutOfSync).toBeFalsy();

      const after = await square(id);

      if (after.fake) return;
      expect(after.squareOrder.fulfillments.map((f) => f.state))
        .toEqual(["CANCELED"]);
    });
});
