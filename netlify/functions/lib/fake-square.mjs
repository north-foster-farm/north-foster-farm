// SQUARE_ENV=fake (lib/fake.mjs): every call square.mjs makes to
// Square, answered here with the same arguments and the same shapes,
// and no request sent. Stateless: ids come from the idempotency key,
// so a retry returns what the first try made, as Square does. The
// order is still built by square.mjs, so a fault in it shows locally.
//
// A card token from the stub SDK (assets/scripts/fake/square.js) is
// `fake:ok-...`, or `fake:<CODE>` for a decline with one of Square's
// codes (DECLINE_MESSAGES): the stub's card 4000 0000 0000 0002 sends
// `fake:CARD_DECLINED`. Square's own sandbox test nonces answer as the
// sandbox does (SANDBOX_NONCES), so a spec that posts one passes here
// and on staging alike.

import { fakeId } from "./fake.mjs";
import {
  DECLINE_MESSAGES, SquareError, buildChangeOrder, buildOrder,
} from "./square.mjs";

const cfg = (env) => ({
  locationId: env.SQUARE_LOCATION_ID || "FAKE-LOCATION", catalog: false,
});

const customerId = (customer) => fakeId("FAKE-CUSTOMER", customer.email);

export const createOrder = async (order, key, { env = process.env } = {}) => {
  const id = customerId(order.customer);

  buildOrder(order, id, cfg(env));

  return { squareOrderId: fakeId("FAKE-ORDER", key), customerId: id };
};

export const createChangeOrder = async (order, change, key, {
  env = process.env,
} = {}) => {
  const id = customerId(order.customer);

  buildChangeOrder(order, change, id, cfg(env));

  return { squareOrderId: fakeId("FAKE-ORDER", key), customerId: id };
};

export const payZeroOrder = async (squareOrderId) => ({ squareOrderId });

// Square's sandbox test values for a declined card nonce
// (developer.squareup.com, "Sandbox test values"); its ok nonce,
// cnon:card-nonce-ok, pays like any other token.
export const SANDBOX_NONCES = {
  "cnon:card-nonce-declined": "CARD_DECLINED",
  "cnon:card-nonce-rejected-cvv": "CVV_FAILURE",
  "cnon:card-nonce-rejected-postalcode": "ADDRESS_VERIFICATION_FAILURE",
  "cnon:card-nonce-rejected-expiration": "INVALID_EXPIRATION",
};

export const createPayment = async ({ order, key, source }) => {
  const token = (source && source.sourceId) || "";
  const code = token.startsWith("fake:")
    ? token.slice(5) : SANDBOX_NONCES[token] || "";

  if (DECLINE_MESSAGES[code]) {
    throw new SquareError("Square 402 on /v2/payments", {
      status: 402, declined: true, code, detail: [{ code }],
    });
  }
  if (!source || (!source.external && !token)) {
    throw new SquareError("Square 400 on /v2/payments", {
      status: 400, code: "INVALID_VALUE",
    });
  }
  if (!(order.totals.total >= 0)) {
    throw new SquareError("Square 400 on /v2/payments", {
      status: 400, code: "INVALID_VALUE",
    });
  }

  const card = !source.external;

  return {
    squarePaymentId: fakeId("FAKE-PAYMENT", key),
    status: "COMPLETED",
    receiptUrl: null,
    brand: card ? "VISA" : null,
    last4: card ? "1111" : null,
    wallet: null,
  };
};

// Nothing is remembered here, so nothing was paid before.
export const findPaid = async () => null;

export const updateFulfilment = async (squareOrderId) => ({
  id: squareOrderId, version: null,
});

export const cancelFulfilment = async (squareOrderId) => ({
  id: squareOrderId, cancelled: true,
});

export const deleteCustomer = async () => ({ deleted: true });

export const cancelOrder = async (squareOrderId) => ({
  id: squareOrderId, cancelled: true,
});

export const refundPayment = async ({ amount, key }) => ({
  squareRefundId: fakeId("FAKE-REFUND", key),
  status: "COMPLETED",
  amount,
});

// What has been refunded is not remembered: none, as far as this
// knows.
export const getPayment = async (squarePaymentId) => ({
  squarePaymentId,
  status: "COMPLETED",
  receiptUrl: null,
  brand: null,
  last4: null,
  wallet: null,
  refunded: 0,
});

// No Square to count stock: the store's counts stand (#267).
export const inventoryCounts = async () => null;

// No customers here to rename.
export const renameCustomerEmail = async () => [];
