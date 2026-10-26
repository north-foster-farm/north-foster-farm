// PAYPAL_ENV=fake (lib/fake.mjs): every call paypal.mjs makes to
// PayPal, answered here with the same arguments and the same shapes,
// and no request sent. Stateless: the order id carries its amount, so
// the capture can report it as PayPal would, and ids come from the
// request ids, so a retry returns what the first try made.
//
// The stub SDK (assets/scripts/fake/paypal.js) approves at once. The
// server never hears of an approval before the capture, so an order
// here reads as created until it is captured: the jobs leave an
// abandoned fake checkout to the sweep.

import { fakeId } from "./fake.mjs";
import { PayPalError } from "./paypal.mjs";

const PREFIX = "FAKE-PP";

const amountOf = (paypalOrderId) => {
  const m = String(paypalOrderId).match(/^FAKE-PP-(\d+)-/);

  return m ? Number(m[1]) : null;
};

const payer = { email: "venmo-buyer@example.com", name: "Fake Venmo" };

export const createOrder = async (order, key) => ({
  paypalOrderId: fakeId(`${PREFIX}-${order.totals.total}`, key),
});

export const getOrder = async (paypalOrderId) => {
  if (amountOf(paypalOrderId) === null) {
    throw new PayPalError(`PayPal 404 on /v2/checkout/orders/${
      paypalOrderId}`, { status: 404, code: "RESOURCE_NOT_FOUND" });
  }

  return { status: "CREATED", updatedAt: null, capture: null };
};

export const captureOrder = async (paypalOrderId) => {
  const amount = amountOf(paypalOrderId);

  if (amount === null) {
    throw new PayPalError(`PayPal 404 on /v2/checkout/orders/${
      paypalOrderId}/capture`, { status: 404, code: "RESOURCE_NOT_FOUND" });
  }

  return {
    paypalOrderId,
    paypalCaptureId: fakeId("FAKE-CAPTURE", paypalOrderId),
    status: "COMPLETED",
    amount,
    payer: { ...payer },
  };
};

export const refundCapture = async ({ amount, key }) => ({
  paypalRefundId: fakeId("FAKE-PP-REFUND", key),
  status: "COMPLETED",
  amount,
});

export const getRefund = async (paypalRefundId) => ({
  paypalRefundId, status: "COMPLETED", amount: 0,
});

// PayPal cannot reach this machine, and a fake must never take a
// forged event for a real one: nothing verifies.
export const verifyWebhook = async () => false;
