// What the farm does from the CLI: decide addresses, set pricing
// groups, close and cancel orders, settle returns, count stock. The
// same records and rules as the customer-facing functions, with the
// farm's authority. bin/nff is the thin front.

import { adjust, getCounts, setCount } from "./stock.mjs";
import { sendMail } from "./mail.mjs";
import { markPaid, sendForOrder } from "./payments.mjs";
import {
  allCustomers, allOrders, amendOrder, deleteCustomer, deleteOrder,
  getCustomer, getOrder, ordersFor, saveCustomer, setStatus,
} from "./records.mjs";
import { cancelFulfilment, cancelInvoice } from "./square.mjs";
import {
  addressDecision, orderCancelled, returnResolved,
} from "./templates.mjs";

const need = (thing, what) => {
  if (!thing) throw new Error(`No such ${what}.`);

  return thing;
};

// Customers

export const listCustomers = (stores) => allCustomers(stores);

export const showCustomer = async (stores, email) => ({
  customer: need(await getCustomer(stores, email), "customer"),
  orders: await ordersFor(stores, email),
});

export const setCustomer = async (stores, email, patch, money) => {
  const customer = need(await getCustomer(stores, email), "customer");
  const next = { ...customer };

  if (patch.name !== undefined) next.name = String(patch.name);
  if (patch.phone !== undefined) next.phone = String(patch.phone);
  if (patch.avatar !== undefined) next.avatar = patch.avatar || null;
  if (patch.group !== undefined) {
    const groups = (money && money.discountGroups) || {};
    const key = patch.group === "none" || !patch.group ? null : patch.group;

    if (key && !groups[key]) {
      throw new Error(`Unknown group "${key}". Known: ${
        Object.keys(groups).join(", ") || "none"}.`);
    }
    next.discountGroup = key;
  }

  return saveCustomer(stores, next);
};

export const removeCustomer = async (stores, email) => {
  need(await getCustomer(stores, email), "customer");
  await deleteCustomer(stores, email);

  return true;
};

// Approve or deny a delivery address and tell the customer.
export const decideAddress = async (stores, email, decision, {
  now = new Date(), env = process.env, mail = sendMail,
} = {}) => {
  const customer = need(await getCustomer(stores, email), "customer");

  if (!customer.address) throw new Error("This customer has no address.");
  if (!["approved", "denied"].includes(decision)) {
    throw new Error("Decision must be approved or denied.");
  }

  const saved = await saveCustomer(stores, {
    ...customer,
    address: {
      ...customer.address,
      status: decision,
      reviewedAt: now.toISOString(),
      reviewedBy: "farm",
    },
  });

  try {
    await mail({
      to: saved.email,
      idempotencyKey: `address-${decision}-${now.getTime()}`,
      ...addressDecision(saved, decision),
    }, { env });
  } catch (error) {
    console.error(`Mail failed: ${error.message}`);
  }

  return saved;
};

// Orders

export const listOrders = async (stores, { status, email, open } = {}) => {
  let orders = email ? await ordersFor(stores, email) : await allOrders(stores);

  if (status) orders = orders.filter((o) => o.status === status);
  if (open) {
    orders = orders.filter((o) => ["submitted", "paid"].includes(o.status));
  }

  return orders;
};

export const showOrder = async (stores, id) =>
  need(await getOrder(stores, id), "order");

export const payOrder = async (stores, id, options = {}) =>
  need(await markPaid(stores, id, { ...options, source: "farm" }), "order");

// The farm cancels: any status but fulfilled. Stock goes back, the
// invoice and fulfilment are cancelled if unpaid, the customer is told.
export const cancelOrder = async (stores, id, {
  now = new Date(), env = process.env, mail = sendMail,
  square = { cancelInvoice, cancelFulfilment }, refund = false,
} = {}) => {
  const order = need(await getOrder(stores, id), "order");

  if (["cancelled", "abandoned"].includes(order.status)) return order;

  const wasPaid = order.status === "paid" || order.cancelRequested;
  const cancelled = await setStatus(stores, id, "cancelled", now, {
    source: "farm",
  });

  if (!order.cancelRequested) await adjust(stores, order.lines, 1);

  if (order.square && order.square.invoiceId && order.status === "submitted") {
    try {
      await square.cancelInvoice(order.square.invoiceId, { env });
      if (order.square.squareOrderId) {
        await square.cancelFulfilment(order.square.squareOrderId, { env });
      }
    } catch (error) {
      console.error(`Square cancel failed: ${error.message}`);
    }
  }

  // A customer who already asked was already told.
  if (!order.cancelRequested) {
    await sendForOrder(stores, cancelled, "orderCancelled",
      orderCancelled(cancelled, { refund: refund || wasPaid }),
      { mail, env, now });
  }

  return getOrder(stores, id);
};

export const fulfilOrder = async (stores, id, { now = new Date() } = {}) =>
  need(await setStatus(stores, id, "fulfilled", now, { source: "farm" }),
    "order");

export const removeOrder = async (stores, id) => {
  need(await getOrder(stores, id), "order");
  await deleteOrder(stores, id);

  return true;
};

// Returns

export const resolveReturn = async (stores, id, returnId, {
  now = new Date(), env = process.env, mail = sendMail, note = "",
  outcome = "resolved",
} = {}) => {
  const order = need(await getOrder(stores, id), "order");
  const entry = (order.returns || []).find((r) => r.id === returnId);

  if (!entry) throw new Error("No such return on that order.");

  const returns = order.returns.map((r) => (r.id === returnId
    ? { ...r, status: outcome, note, resolvedAt: now.toISOString() }
    : r));
  const changed = await amendOrder(stores, id, { returns },
    `return.${outcome}`, now);

  await sendForOrder(stores, changed, `returnResolved-${returnId}`,
    returnResolved(changed, { ...entry, status: outcome, note }),
    { mail, env, now });

  return getOrder(stores, id);
};

// Stock

export const stockList = (stores) => getCounts(stores);

export const stockSet = (stores, sku, value) =>
  setCount(stores, sku, value === "none" ? null : Number(value));
