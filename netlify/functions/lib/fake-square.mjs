// SQUARE_ENV=fake (lib/fake.mjs): every call square.mjs makes to
// Square, answered here with the same arguments and the same shapes,
// and no request sent. The order is still built by square.mjs, so a
// fault in it shows locally, and every answer is a recording of
// Square's own (test/fixtures/square/, bin/fixtures/record) with the
// request's values put in, read by the same code that reads Square's.
// Nothing is written by hand but the values.
//
// It remembers what it has been told, in this process (forgetFake()
// clears it): the totals Square would work out for each order, what
// has been paid and refunded, the keys it has seen. So it refuses what
// Square refuses (a payment off the order's total, or on a paid or a
// cancelled order, or for nothing; a refund over what is left; a payment
// key reused with another body) by throwing the recorded refusal, and
// takes what Square takes (an order key reused with another body, which
// answers with the first order). Ids come
// from the idempotency key, so a retry returns what the first try made,
// even in a process that remembers nothing.
//
// A card token from the stub SDK (assets/scripts/fake/square.js) is
// `fake:ok-...`, or `fake:<CODE>` for a decline with one of Square's
// codes (DECLINE_MESSAGES): the stub's card 4000 0000 0000 0002 sends
// `fake:CARD_DECLINED`. Square's own sandbox test nonces answer as the
// sandbox does (SANDBOX_NONCES), so a spec that posts one passes here
// and on staging alike.

import { fakeId, recorded } from "./fake.mjs";
import {
  DECLINE_MESSAGES, SquareError, buildChangeOrder, buildOrder, failure,
  paymentRecord, paymentView, refundRecord,
} from "./square.mjs";

const cfg = (env) => ({
  locationId: env.SQUARE_LOCATION_ID || "FAKE-LOCATION", catalog: false,
});

const customerId = (customer) => fakeId("FAKE-CUSTOMER", customer.email);

const answer = (name) => recorded("square", name);

// What this process has been told. Orders: { total, paid, state, built }
// by Square order id; payments: { record, amount, refunded } by payment
// id; refunds: { paymentId, amount } by refund id; keys: the body each
// idempotency key first came with.
const memory = {
  keys: new Map(), orders: new Map(), payments: new Map(),
  refunds: new Map(),
};

export const forgetFake = () => {
  for (const each of Object.values(memory)) each.clear();
};

// Square's refusal, from its recording: the SquareError square.mjs
// throws for it. `change` may edit the recorded body (a decline's code).
const refusal = (name, path, change = (body) => body) => {
  const { status, response } = answer(name);

  return failure(status, change(response), path);
};

// A key used again with the same body is the same call; with another it
// is refused.
const once = (call, key, body, path, name) => {
  const id = `${call}|${key}`;
  const text = JSON.stringify(body);
  const had = memory.keys.get(id);

  if (had !== undefined && had !== text) throw refusal(name, path);
  memory.keys.set(id, text);

  return had !== undefined;
};

// What Square works out for an order it is sent: line items at their
// price, less the discounts (which come off line items only, never off
// a service charge, so they stop at the line items' sum), plus the
// service charges. The recorded orders check this against Square's own
// totals (test/square-replay.test.mjs).
export const squareTotal = (built) => {
  const lines = built.line_items.reduce((sum, line) => sum
    + (line.base_price_money
      ? line.base_price_money.amount * Number(line.quantity) : 0), 0);
  const off = (built.discounts || [])
    .reduce((sum, d) => sum + d.amount_money.amount, 0);
  const fees = (built.service_charges || [])
    .reduce((sum, c) => sum + c.amount_money.amount, 0);

  return lines - Math.min(lines, off) + fees;
};

const remember = (squareOrderId, built) => {
  memory.orders.set(squareOrderId, {
    total: squareTotal(built), paid: 0, state: "OPEN", built,
  });
};

export const createOrder = async (order, key, { env = process.env } = {}) => {
  const id = customerId(order.customer);
  const built = buildOrder(order, id, cfg(env));
  const squareOrderId = fakeId("FAKE-ORDER", key);

  // Square answers a key used again with the first order, whatever the
  // second body says (order-create-key-reused.json is a 200).
  if (!memory.orders.has(squareOrderId)) remember(squareOrderId, built);

  // The fake keeps no profiles, so it never makes one for an order to
  // clean up (#236).
  return { squareOrderId, customerId: id, customerMade: false };
};

export const createChangeOrder = async (order, change, key, {
  env = process.env,
} = {}) => {
  const id = customerId(order.customer);
  const built = buildChangeOrder(order, change, id, cfg(env));
  const squareOrderId = fakeId("FAKE-ORDER", key);

  if (!memory.orders.has(squareOrderId)) remember(squareOrderId, built);

  return { squareOrderId, customerId: id };
};

// An order with nothing to pay is closed; one with something to pay is
// refused. What Square does with an order whose credit discount outruns
// its items is in test/fixtures/square/create-order-credit-over-items.json
// (test/square-fixtures.test.mjs holds buildOrder to it); the zero-pay
// answer itself is order-pay-zero.json.
export const payZeroOrder = async (squareOrderId) => {
  const known = memory.orders.get(squareOrderId);

  if (known) {
    if (known.total - known.paid > 0) {
      throw refusal("payment-over-total", `/v2/orders/${squareOrderId}/pay`);
    }
    known.state = "COMPLETED";
  }

  return { squareOrderId };
};

// Square's sandbox test values for a declined card nonce
// (developer.squareup.com, "Sandbox test values"); its ok nonce,
// cnon:card-nonce-ok, pays like any other token.
export const SANDBOX_NONCES = {
  "cnon:card-nonce-declined": "GENERIC_DECLINE",
  "cnon:card-nonce-rejected-cvv": "CVV_FAILURE",
  "cnon:card-nonce-rejected-postalcode": "ADDRESS_VERIFICATION_FAILURE",
  "cnon:card-nonce-rejected-expiration": "INVALID_EXPIRATION",
};

// Which recording a payment of this kind takes its shape from.
const template = (source) => {
  if (source.cash) return "payment-cash";

  return source.external ? "payment-external" : "payment-card-ok";
};

export const createPayment = async ({
  order, squareOrderId, key, source, amount = order.totals.total,
}) => {
  const path = "/v2/payments";
  const token = (source && source.sourceId) || "";
  const code = token.startsWith("fake:")
    ? token.slice(5) : SANDBOX_NONCES[token] || "";

  if (DECLINE_MESSAGES[code]) {
    throw refusal("payment-card-declined", path, (body) => {
      body.errors[0].code = code;

      return body;
    });
  }
  // Our own guard: the page never sends a payment with no source.
  if (!source || (!source.external && !source.cash && !token)) {
    throw new SquareError(`Square 400 on ${path}`, {
      status: 400, code: "INVALID_VALUE",
    });
  }

  const id = fakeId("FAKE-PAYMENT", key);
  const known = memory.orders.get(squareOrderId);
  const body = { squareOrderId, amount, token, source: Object.keys(source) };
  const seen = memory.payments.get(id);

  // The same key and body is the same payment; another body is refused.
  if (once("payment", `${key}-payment`, body, path, "payment-key-reused")
    && seen) {
    return seen.record;
  }

  if (!Number.isInteger(amount) || amount < 1) {
    throw refusal(known && known.total === 0
      ? "payment-zero-order" : "payment-zero-amount", path);
  }
  // Square refuses a payment on a cancelled order: "The order must be
  // OPEN to be paid" (payment-order-canceled.json).
  if (known && known.state === "CANCELED") {
    throw refusal("payment-order-canceled", path);
  }
  if (known && known.paid >= known.total) {
    throw refusal("payment-already-paid", path);
  }
  // FINDING (recorded 2026-10-29): Square takes no part payment either;
  // an amount under the total is the same ORDER_TOTAL_MISMATCH.
  if (known && amount !== known.total) {
    throw refusal(amount > known.total
      ? "payment-over-total" : "payment-under-total", path);
  }

  const payment = answer(template(source)).response.payment;
  const recordedId = payment.id;

  Object.assign(payment, {
    id,
    status: "COMPLETED",
    order_id: squareOrderId,
    amount_money: { ...payment.amount_money, amount },
    total_money: { ...payment.total_money, amount },
    receipt_url: payment.receipt_url
      && payment.receipt_url.split(recordedId).join(id),
  });
  if (payment.card_details) payment.card_details.status = "CAPTURED";

  const record = paymentRecord(payment);

  memory.payments.set(id, { record, payment, amount, refunded: 0 });
  if (known) known.paid += amount;

  return record;
};

// Nothing is remembered across processes, so nothing was paid before.
export const findPaid = async () => null;

export const updateFulfillment = async (squareOrderId) => ({
  id: squareOrderId, version: null,
});

export const cancelFulfillment = async (squareOrderId) => {
  const known = memory.orders.get(squareOrderId);

  if (known) known.fulfillmentCanceled = true;

  return { id: squareOrderId, cancelled: true };
};

// Closing a closed order changes nothing, as with Square.
export const completeOrder = async (squareOrderId) => {
  const known = memory.orders.get(squareOrderId);

  if (known && known.state !== "OPEN") {
    return { id: squareOrderId, completed: false };
  }
  if (known) known.state = "COMPLETED";

  return { id: squareOrderId, completed: true };
};

// Square's copy of an order as it stands: the recording of one, with
// the lines and fulfillment this process built for it. An order it does
// not remember has nothing to compare (lib/drift.mjs).
// An order nobody has paid has no tenders key at all (order-get-open is
// the delivery order after four declines, which left tenders behind), so
// the unpaid ones start from a fresh order's recording; one that has
// been paid gets its own tenders.
const UNPAID = "order-get-line-discount";

// An order with an order-scope discount or a service charge starts from
// the recording of one (a family order's whole-order discount and its
// $0 delivery, #514).
const WHOLE = "order-get-discount-fee-zero";

// Each discount and service charge as Square lists it, from the
// recording of one of its kind, with the built order's values put in.
// Square leaves the key out when there are none.
const discountsOf = (built) => (built.discounts || []).map((d, i) => {
  const [shape] = answer(d.scope === "LINE_ITEM" ? UNPAID : WHOLE)
    .response.order.discounts;

  return {
    ...shape, uid: d.uid || `discount-${i}`, name: d.name,
    amount_money: { ...shape.amount_money, ...d.amount_money },
    applied_money: { ...shape.applied_money, ...d.amount_money },
    scope: d.scope,
  };
});

const chargesOf = (built) => (built.service_charges || []).map((c, i) => {
  const [shape] = answer(WHOLE).response.order.service_charges;

  return {
    ...shape, uid: `service-charge-${i}`, name: c.name,
    amount_money: { ...shape.amount_money, ...c.amount_money },
    applied_money: { ...shape.applied_money, ...c.amount_money },
    total_money: { ...shape.total_money, ...c.amount_money },
    calculation_phase: c.calculation_phase, taxable: c.taxable,
  };
});

const orderTemplate = (built, paid) => {
  if (paid) return "order-get-paid";

  return built.service_charges
    || (built.discounts || []).some((d) => d.scope === "ORDER")
    ? WHOLE : UNPAID;
};

// A recorded order without its own discounts and service charges.
const bareOrder = (name) => {
  const order = answer(name).response.order;

  delete order.discounts;
  delete order.service_charges;

  return order;
};

export const getOrder = async (squareOrderId) => {
  const known = memory.orders.get(squareOrderId);

  if (!known) {
    return { ...answer(UNPAID).response.order, id: squareOrderId,
      state: "OPEN", line_items: [], fulfillments: [] };
  }

  const paid = [...memory.payments.values()]
    .filter((p) => p.payment.order_id === squareOrderId);
  const order = bareOrder(orderTemplate(known.built, paid.length > 0));
  const madeDiscounts = discountsOf(known.built);
  const madeCharges = chargesOf(known.built);

  return {
    ...order,
    id: squareOrderId,
    state: known.state,
    line_items: known.built.line_items
      .map((line, i) => ({ uid: `line-${i}`, ...line })),
    fulfillments: (known.built.fulfillments || [])
      .map((f, i) => ({ uid: `fulfillment-${i}`, ...f })),
    ...madeDiscounts.length && { discounts: madeDiscounts },
    ...madeCharges.length && { service_charges: madeCharges },
    total_money: { ...order.total_money, amount: known.total },
    ...paid.length && {
      tenders: paid.map((p) => ({
        id: p.payment.id, payment_id: p.payment.id,
      })),
    },
  };
};

export const deleteCustomer = async () => ({ deleted: true });

// A fake payment never fails part way, so no order is left open.
export const searchOpenOrders = async () => [];

export const customerOrders = async () => ({ paid: false, recent: false });

// An order that has taken money is left alone when `unpaid` says so.
export const cancelOrder = async (squareOrderId, { unpaid = false } = {}) => {
  const known = memory.orders.get(squareOrderId);

  if (known) {
    const paid = known.paid > 0;

    if (known.state !== "OPEN" || (unpaid && paid)) {
      return { id: squareOrderId, cancelled: false, paid };
    }
    // Square refuses to cancel an order while its fulfillment is open
    // (order-cancel-refused.json), so the real cancelOrder cancels the
    // fulfillment first; the fake does both.
    known.fulfillmentCanceled = true;
    known.state = "CANCELED";
  }

  return { id: squareOrderId, cancelled: true };
};

// A recorded refund with this process's id, payment and amount.
const refundBody = (name, id, { paymentId, amount }) => {
  const refund = answer(name).response.refund;

  return {
    ...refund,
    id,
    payment_id: paymentId,
    amount_money: { ...refund.amount_money, amount },
  };
};

// A refund is what Square answered to one, with the amount asked for;
// it settles when asked about (getRefund). A key used again is the same
// refund.
export const refundPayment = async ({ squarePaymentId, amount, key }) => {
  const paid = memory.payments.get(squarePaymentId);
  const id = fakeId("FAKE-REFUND", key);
  const had = memory.refunds.get(id);

  if (had) return refundRecord(refundBody("refund-create", id, had), amount);
  if (paid && amount > paid.amount - paid.refunded) {
    throw refusal("refund-too-large", "/v2/refunds");
  }

  const made = { paymentId: squarePaymentId, amount };

  memory.refunds.set(id, made);
  if (paid) paid.refunded += amount;

  return refundRecord(refundBody("refund-create", id, made), amount);
};

// What has been refunded is what this process was asked to refund.
export const getPayment = async (squarePaymentId) => {
  const known = memory.payments.get(squarePaymentId);

  if (!known) {
    return paymentView({
      ...answer("payment-get").response.payment, id: squarePaymentId,
    });
  }

  return paymentView({
    ...known.payment,
    refunded_money: known.refunded
      ? { amount: known.refunded, currency: "USD" } : undefined,
  });
};

// A refund settles by the time it is asked about.
export const getRefund = async (squareRefundId) => {
  const made = memory.refunds.get(squareRefundId);

  return refundRecord(made
    ? refundBody("refund-get", squareRefundId, made)
    : { ...answer("refund-get").response.refund, id: squareRefundId }, 0);
};

// No Square to count stock: the store's counts stand (#267).
export const inventoryCounts = async () => null;

// No customers here to rename.
export const renameCustomerEmail = async () => [];
