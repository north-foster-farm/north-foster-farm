// Paying on the page with Square's card form in the sandbox, and what
// follows: the success card, the record, the emails. Every order is
// cancelled, refunded and deleted afterwards.
// docs/qa-launch.md, "Payments" and "After the order".
//
// Square sandbox test cards: 4111 1111 1111 1111 is approved;
// 4000 0000 0000 0002 is declined.

import {
  OrderPage, expect, test, uniqueEmail,
} from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, closeOrder, deleteCustomer,
  nff, orderRecord, teardown, waitForMail,
} from "./support/staging.mjs";

const ORDER_ID = /^NFF-\d{4}-[A-Z2-9]{4}$/;

test.describe.configure({ mode: "serial" });

test.describe("payments", () => {
  test.skip(!backOffice().cli, BACK_OFFICE_MISSING);

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

  test("a card pays for an on-farm pickup, and the farm is asked to " +
    "confirm", { tag: "@regression" }, async ({ page }) => {
    const order = new OrderPage(page);
    const email = uniqueEmail("card");

    emails.push(email);
    await order.open({ eggs: 1 });
    await order.method("onfarm");
    await order.contact({ first: "Card", email });

    const date = await order.firstDate("onfarm");

    await order.openCard();
    await expect(order.submit).toHaveText("Place your order");
    await order.card();

    const { status, body } = await order.pay();

    expect(status, JSON.stringify(body)).toBe(200);
    made.push(body.orderId);

    const card = order.result;

    await expect(card).toBeVisible();
    await expect(page.locator("#order-form")).toBeHidden();
    await expect(card.locator("h2")).toHaveText(
      "Thank you, Card. Your order is placed."
    );
    await expect(card.locator("[data-out='total']")).toHaveText("$7");
    await expect(card.locator("[data-out='how']"))
      .toHaveText("Visa ending 1111");
    await expect(card.locator("[data-out='email']")).toHaveText(email);
    await expect(card.locator("[data-out='orderId']")).toHaveText(ORDER_ID);
    await expect(card.locator("[data-out='confirms']")).toContainText(
      "The pickup time you chose is a request"
    );
    await expect(card.locator("[data-out='receiptUrl']")).toHaveAttribute(
      "href", /^https:\/\/.*squareup(sandbox)?\.com\//
    );

    const record = await orderRecord(body.orderId);

    expect(record.status).toBe("paid");
    expect(record.payment).toMatchObject({
      via: "square", method: "card", last4: "1111",
    });
    expect(record.square && record.square.squareOrderId).toBeTruthy();
    expect(record.fulfilment).toMatchObject({
      method: "onfarm", date, state: "requested",
    });
    expect(record.totals.total).toBe(700);

    const receipt = await waitForMail({
      to: email, subject: "Payment received", since,
    });

    expect(receipt.text).toContain("Your payment of $7 came through.");
    expect(receipt.text).toContain("Requested:");

    const farm = await waitForMail({
      // The subject is "New order <id>", a dash, then the total and how.
      subject: new RegExp(
        `^New order ${body.orderId} . \\$7, on-farm pickup$`
      ),
      since,
    });

    expect(farm.text).toContain("$7 by Visa ending 1111");
    expect(farm.text).toContain("Requested, not yet confirmed");
    expect(farm.text).toContain(`orders confirm ${body.orderId}`);

    // The draft is gone: a reload starts a new, empty order.
    await page.goto("/order/");
    await expect(order.count).toHaveText("0 items");
  });

  test("a delivery paid by card is confirmed at once",
    { tag: "@regression" }, async ({ page }) => {
      const order = new OrderPage(page);
      const email = uniqueEmail("delivery");

      emails.push(email);
      await order.open({ wings: 5 });
      await order.contact({ first: "Drop", email, phone: "4015550100" });
      await order.delivery({ address1: "12 Test Road", zip: "02857" });
      await order.firstDate("delivery");
      await order.openCard();
      await order.card();

      const { status, body } = await order.pay();

      expect(status, JSON.stringify(body)).toBe(200);
      made.push(body.orderId);
      const out = (name) => order.result.locator(`[data-out='${name}']`);

      await expect(out("total")).toHaveText("$50");
      await expect(out("when")).toHaveText(
        /, delivered to 12 Test Road\.$/
      );
      await expect(out("confirms")).toHaveText("");

      const record = await orderRecord(body.orderId);

      expect(record.fulfilment).toMatchObject({
        method: "delivery", state: "agreed",
      });
      expect(record.totals).toMatchObject({
        subtotal: 5000, discountAmount: 500, deliveryFee: 500, total: 5000,
      });
      expect(record.customer.phone).toBeTruthy();

      const mail = await waitForMail({
        to: email, subject: "Your order is confirmed", since,
      });

      expect(mail.text).toContain(
        "Your payment of $50 came through and your order is confirmed."
      );
      await waitForMail({
        subject: new RegExp(
          `^New order ${body.orderId} . \\$50, delivery$`
        ),
        since,
      });
    });

  test("a declined card says so, and the next card pays the new total",
    { tag: "@regression" }, async ({ page }) => {
      const order = new OrderPage(page);
      const email = uniqueEmail("decline");

      emails.push(email);
      await order.open({ eggs: 1 });
      await order.method("scituate");
      await order.contact({ first: "Decline", email });
      await order.firstDate("scituate");
      await order.openCard();
      await order.card("4000000000000002");

      const first = await order.pay();

      expect(first.status, JSON.stringify(first.body)).toBe(402);
      expect(first.body).toMatchObject({ declined: true });
      await expect(order.payError).toBeVisible();
      await expect(order.payError).toContainText("declined");
      await expect(order.result).toBeHidden();
      await expect(page.locator("#order-form")).toBeVisible();

      // Nothing is recorded for a declined attempt.
      const none = await nff(["orders", "list", `--email=${email}`]);

      expect(none).toContain("No orders.");

      // The customer changes the cart, then pays with a good card: the
      // charge is the new figure, as a fresh attempt.
      await (await order.showRow("eggs"))
        .getByRole("button", { name: "One more" }).click();
      await expect(order.total).toHaveText("$14");
      await order.card("4111111111111111");

      const second = await order.pay();

      expect(second.status, JSON.stringify(second.body)).toBe(200);
      made.push(second.body.orderId);
      await expect(order.result.locator("[data-out='total']"))
        .toHaveText("$14");

      const record = await orderRecord(second.body.orderId);

      expect(record.totals.total).toBe(1400);
      expect(record.meta.attempt).toBeGreaterThanOrEqual(2);
      await expect(page.locator("#order-result")).toContainText(
        "Visa ending 1111"
      );
    });
});
