// Switching a paid order between pickup and delivery (#160, AO-17),
// through the account's edit endpoint. An on-farm pickup over the
// delivery minimum is switched to delivery (the fee is charged to the
// sandbox card), then back to pickup (the fee goes back). Each switch
// moves the fulfillment to a new Square order and tells the customer
// and the farm. Cancelled, refunded and deleted after.

import {
  NONCE, eggOrder, firstDate, firstPickup, postOrder,
} from "./support/api.mjs";
import { SKU, expect, test, uniqueEmail } from "./support/order.mjs";
import { signIn } from "./support/session.mjs";
import {
  BACK_OFFICE_MISSING, BASE_URL, backOffice, clearMail, closeOrder,
  deleteCustomer, orderRecord, teardown, waitForMail,
} from "./support/staging.mjs";

const UPDATED = "Your order is updated";

test.describe.configure({ mode: "serial" });

test.describe("switching a paid order between pickup and delivery", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  const email = uniqueEmail("switch");
  let orderId;
  let since;
  let api;

  // One dozen is $7; six clear the delivery minimum.
  test.beforeAll(async ({ request }) => {
    since = new Date();

    const { status, body } = await postOrder(request, await eggOrder(
      request, { email, nonce: NONCE.ok, qty: 6, claimedTotal: 4200 }
    ));

    expect(status, JSON.stringify(body)).toBe(200);
    orderId = body.orderId;
  });

  test.afterAll(async () => {
    if (api) await api.dispose();
    await teardown([
      () => (orderId ? closeOrder(orderId) : null),
      () => deleteCustomer(email),
      () => clearMail({ to: email, since }),
    ]);
  });

  // The edit as the page would send it: the first answer names the
  // new total, the second pays or takes back the difference.
  const edit = async (change, payment) => {
    const url = `/api/account/orders/${orderId}/edit`;
    const body = {
      idempotencyKey: `qa-e2e-switch-${Date.now().toString(36)}${
        Math.random().toString(36).slice(2, 6)}`,
      lines: [{ sku: SKU.eggs, qty: 6 }],
      ...change,
      ...(payment && { payment }),
    };
    const first = await api.post(url, { data: body });
    const priced = await first.json();

    expect(priced.totals, JSON.stringify(priced)).toBeTruthy();

    const res = await api.post(url, {
      data: { ...body, claimedTotal: priced.totals.total },
    });

    expect(res.status(), await res.text()).toBe(200);

    return { priced, answer: await res.json() };
  };

  test("pickup to delivery: the fee is charged", async ({
    page, playwright, request,
  }) => {
    const asked = new Date();

    await signIn(page, email);
    api = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: await page.context().storageState(),
      extraHTTPHeaders: { Origin: BASE_URL },
    });

    const before = await orderRecord(orderId);
    const { priced, answer } = await edit({
      customer: { phone: "4015550100" },
      fulfilment: {
        method: "delivery", date: await firstDate(request, "delivery"),
        delivery: {
          address1: "12 Test Road", town: "Scituate", zip: "02857",
          cooler: "On the porch",
        },
      },
    }, { method: "card", sourceId: NONCE.ok });

    expect(priced.totals).toMatchObject({ deliveryFee: 500, total: 4700 });
    expect(answer.difference).toBe(500);

    const record = await orderRecord(orderId);

    expect(record.fulfilment.method).toBe("delivery");
    expect(record.totals.total).toBe(4700);
    expect(record.payments.map((p) => p.amount)).toEqual([4200, 500]);
    expect(record.edits.at(-1)).toMatchObject({ switched: true });
    // Square cannot change a fulfillment's type, so a new order carries
    // it.
    expect(record.square.fulfilmentOrderId).toBeTruthy();
    expect(record.square.fulfilmentOrderId)
      .not.toBe(before.square.fulfilmentOrderId || before.square.squareOrderId);
    expect(record.square.squareOutOfSync).toBeFalsy();

    await waitForMail({ to: email, subject: UPDATED, since: asked });
    await waitForMail({
      subject: new RegExp(`^Order changed: ${orderId}`), since: asked,
    });
  });

  test("delivery to pickup: the fee goes back", async ({ request }) => {
    test.skip(!api, "Needs the sign-in from the test before.");

    const asked = new Date();
    const before = await orderRecord(orderId);
    const { date, window } = await firstPickup(request);
    const { priced } = await edit({
      fulfilment: { method: "onfarm", date, onfarm: { window } },
    });

    expect(priced.totals).toMatchObject({ deliveryFee: 0, total: 4200 });

    const record = await orderRecord(orderId);

    expect(record.fulfilment).toMatchObject({ method: "onfarm", date });
    expect(record.totals.total).toBe(4200);
    expect(record.refunds.map((r) => [r.amount, r.source]))
      .toEqual([[500, "customer"]]);
    expect(record.refunds[0].squareRefundId).toBeTruthy();
    expect(record.square.fulfilmentOrderId)
      .not.toBe(before.square.fulfilmentOrderId);
    await waitForMail({ to: email, subject: UPDATED, since: asked });
  });
});
