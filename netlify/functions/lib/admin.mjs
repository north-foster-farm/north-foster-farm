// What the farm does from the CLI: decide addresses, set pricing
// groups, close and cancel orders, settle returns, count stock. The
// same records and rules as the customer-facing functions, with the
// farm's authority. bin/nff is the thin front.

import { adjust, getCounts, setCount } from "./stock.mjs";
import { LONG_LINK_TTL, requestLink } from "./auth.mjs";
import { sendMail } from "./mail.mjs";
import { confirmOrder, markPaid, sendForOrder } from "./payments.mjs";
import {
  OPEN, allCustomers, allOrders, amendOrder, answerQuestion, deleteCustomer,
  deleteOrder, getCustomer, getOrder, needsAgreement, ordersFor,
  questionOpen, saveCustomer, setStatus,
} from "./records.mjs";
import { mailLinks, orderPathFor, orderUrlFor } from "./site.mjs";
import { cancelFulfilment, cancelInvoice } from "./square.mjs";
import {
  addressDecision, orderCancelled, pickNewTime,
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
      ...addressDecision(saved, decision, { links: mailLinks(env) }),
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
      orderCancelled(cancelled, {
        refund: refund || wasPaid, links: mailLinks(env),
      }), { mail, env, now });
  }

  return getOrder(stores, id);
};

// The farm's side of an on-farm pickup: agree to the window as asked,
// or deny it and have the customer pick again. The farm never moves a
// time itself (James, 2026-09-21).

const openPickup = async (stores, id) => {
  const order = need(await getOrder(stores, id), "order");

  if (order.fulfilment.method !== "onfarm") {
    throw new Error("Only an on-farm pickup needs confirming.");
  }
  if (!OPEN.includes(order.status)) {
    throw new Error(`This order is ${order.status}.`);
  }

  return order;
};

// -> the order, agreed. Sends "confirmed" if it is already paid; the
// second of paid and agreed sends it, whichever that is. Confirming
// after a deny closes the question: the time works after all.
export const confirmPickup = async (stores, id, {
  now = new Date(), env = process.env, mail = sendMail,
} = {}) => {
  const order = await openPickup(stores, id);

  if (!needsAgreement(order) && !questionOpen(order)) return order;

  const agreed = await amendOrder(stores, id, {
    fulfilment: {
      ...order.fulfilment, state: "agreed", agreedAt: now.toISOString(),
    },
    question: answerQuestion(order, "confirmed", "farm", now),
  }, "pickup.agreed", now);

  if (agreed.status !== "paid") return agreed;

  return confirmOrder(stores, agreed, { mail, env, now, again: true });
};

// -> the order, with a `window` question open and the customer told
// to pick again. The email's button is a sign-in link straight to the
// order page, good for a week; while the account pages are off it has
// no button and asks for a reply instead.
export const denyPickup = async (stores, id, {
  reason = "", now = new Date(), env = process.env, mail = sendMail,
  link = requestLink,
} = {}) => {
  const order = await openPickup(stores, id);
  const question = {
    kind: "window",
    reason: String(reason || "").trim(),
    openedAt: now.toISOString(),
    answeredAt: null,
    answer: null,
    by: null,
  };
  const denied = await amendOrder(stores, id, {
    fulfilment: { ...order.fulfilment, state: "requested", agreedAt: null },
    question,
  }, "pickup.denied", now);

  let pickUrl = null;

  if (orderUrlFor(env, id)) {
    const r = await link(stores, {
      email: order.customer.email, next: orderPathFor(id),
    }, { now, env, send: false, limit: false, ttl: LONG_LINK_TTL });

    pickUrl = r.ok ? r.url : orderUrlFor(env, id);
  }

  return sendForOrder(stores, denied, `pickNewTime-${now.getTime()}`,
    pickNewTime(denied, {
      reason: question.reason, pickUrl, links: mailLinks(env),
    }), { mail, env, now });
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

// No email goes out: James answers a return himself, in his own words.
export const resolveReturn = async (stores, id, returnId, {
  now = new Date(), note = "", outcome = "resolved",
} = {}) => {
  const order = need(await getOrder(stores, id), "order");
  const entry = (order.returns || []).find((r) => r.id === returnId);

  if (!entry) throw new Error("No such return on that order.");

  const returns = order.returns.map((r) => (r.id === returnId
    ? { ...r, status: outcome, note, resolvedAt: now.toISOString() }
    : r));

  await amendOrder(stores, id, { returns }, `return.${outcome}`, now);

  return getOrder(stores, id);
};

// Stock

export const stockList = (stores) => getCounts(stores);

export const stockSet = (stores, sku, value) =>
  setCount(stores, sku, value === "none" ? null : Number(value));
