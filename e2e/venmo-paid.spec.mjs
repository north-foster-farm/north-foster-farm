// Venmo pressed on a draft whose payment already went through, its
// answer lost: the server answers with the paid order and no PayPal
// order (#253), and the page shows the order paid, with no failure
// card and no error under the buttons (#159). PayPal's script is a
// stand-in that presses the button itself, and /api/orders is
// answered in the browser, so nothing reaches a processor. The payment
// it answers with is the capture PayPal made in James's live test
// (test/fixtures/paypal/, #708), read as the server reads it.

import { recorded } from "../netlify/functions/lib/fake.mjs";
import { captureOf } from "../netlify/functions/lib/paypal.mjs";
import { cannedDates } from "./support/canned.mjs";
import { OrderPage, expect, test, uniqueEmail } from "./support/order.mjs";

const CAPTURED = captureOf(recorded("paypal",
  "paypal-20261121T090412024Z-post-v2-checkout-orders-order-id-3-capture-4e0f6a"
).response);

const PAYPAL = {
  clientId: "fake", env: "sandbox", hidden: false,
  sdkUrl: "/e2e-fake/paypal.js",
};

// Presses itself once rendered, as PayPal would on a click: create,
// and on a refusal, onError.
const pressingButton = `
  window.paypal = {
    FUNDING: { VENMO: "venmo" },
    Buttons: (opts) => ({
      isEligible: () => true,
      render: async () => {
        window.pressVenmo = async () => {
          try {
            await opts.createOrder();
          } catch (error) {
            opts.onError(error);
          }
        };
      },
    }),
  };
`;

test("Venmo on an order already paid shows it paid", async ({ page }) => {
  const email = uniqueEmail("venmo-paid");
  const asked = [];

  await cannedDates(page);
  await page.route("**/api/checkout/config", (route) => route.fulfill({
    json: { paypal: PAYPAL },
  }));
  await page.route(`**${PAYPAL.sdkUrl}`, (route) => route.fulfill({
    contentType: "text/javascript", body: pressingButton,
  }));
  await page.route("**/api/health", (route) => route.fulfill({
    status: 202, json: { ok: true },
  }));
  await page.route("**/api/orders", (route) => {
    const body = route.request().postDataJSON();

    asked.push(body.payment);

    return route.fulfill({ json: {
      orderId: "NFF-2610-QAPD", status: "paid",
      totals: {
        subtotal: CAPTURED.amount, discountAmount: 0, deliveryFee: 0,
        total: CAPTURED.amount,
      },
      fulfilment: body.fulfilment, lines: [],
      customer: { firstName: "Paid", name: "Paid Already", email },
      payment: { via: "venmo", method: "venmo" },
    } });
  });

  const order = new OrderPage(page);

  await order.open({ eggs: 1 });
  await order.method("onfarm");
  await order.contact({ first: "Paid", email });
  await order.firstDate("onfarm");
  await page.locator("#payment").scrollIntoViewIfNeeded();
  await expect(page.locator("[data-pay]")).toHaveAttribute(
    "data-pay-state", "venmo-only"
  );
  await page.waitForFunction(() => typeof window.pressVenmo === "function");
  // A press moves the focus off the last field, which saves the draft
  // first; the stand-in has no button to press.
  await page.evaluate(() => document.activeElement.blur());
  await page.evaluate(() => window.pressVenmo());

  await expect(order.result.locator(".order-result-card")).toBeVisible();
  await expect(order.result.locator(".order-result-failed")).toHaveCount(0);
  await expect(order.payError).toBeHidden();
  expect(asked).toEqual([{ method: "venmo", stage: "create" }]);
  expect(await page.evaluate(() => [
    localStorage.getItem("nff-order-pending"),
    localStorage.getItem("nff-order-draft"),
  ])).toEqual([null, null]);
});
