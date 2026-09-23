// What the farm does from the CLI: decide addresses, set pricing
// groups, close and cancel orders, settle returns, count stock. The
// same records and rules as the customer-facing functions, with the
// farm's authority. bin/nff is the thin front.

import terms from "../../../data/delivery.json" with { type: "json" };
import { dollars } from "../../../assets/scripts/order/lib/totals.mjs";
import { adjust, getCounts, setCount } from "./stock.mjs";
import { LONG_LINK_TTL, requestLink } from "./auth.mjs";
import { sendMail } from "./mail.mjs";
import { confirmOrder, recordRefund, sendForOrder } from "./payments.mjs";
import * as paypalApi from "./paypal.mjs";
import {
  OPEN, allCustomers, allOrders, amendOrder, answerQuestion, deleteCustomer,
  deleteOrder, getCustomer, getOrder, needsAgreement, openOrders, ordersFor,
  questionOpen, saveCustomer, setStatus,
} from "./records.mjs";
import { mailLinks, orderPathFor, orderUrlFor } from "./site.mjs";
import * as squareApi from "./square.mjs";
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

export const listOrders = async (stores, {
  status, email, open,
} = {}) => {
  let orders = email ? await ordersFor(stores, email) : await allOrders(stores);

  if (status) orders = orders.filter((o) => o.status === status);
  if (open) orders = orders.filter((o) => OPEN.includes(o.status));

  return orders;
};

export const showOrder = async (stores, id) =>
  need(await getOrder(stores, id), "order");

// Money back, whole or part, through whichever processor took it: a
// card or wallet payment through Square, a Venmo payment through
// PayPal (and noted on the Square copy so the books agree, best
// effort). Once per order; a second call is refused. -> the order.
export const refundOrder = async (stores, id, {
  now = new Date(), env = process.env, amount, reason = "",
  square = squareApi, paypal = paypalApi, fetchImpl,
} = {}) => {
  const order = need(await getOrder(stores, id), "order");
  const p = order.payment || {};

  if (order.refund) {
    throw new Error(`Already refunded ${dollars(order.refund.amount)} on ${
      order.refund.at.slice(0, 10)}.`);
  }
  if (!["paid", "cancelled", "fulfilled"].includes(order.status)) {
    throw new Error(`This order is ${order.status}.`);
  }

  const cents = amount === undefined ? order.totals.total : amount;

  if (!Number.isInteger(cents) || cents <= 0 || cents > order.totals.total) {
    throw new Error(`The refund must be between $0.01 and ${
      dollars(order.totals.total)}.`);
  }

  const key = `refund-${id}-${now.getTime()}`;
  let refund;

  if (p.via === "venmo" && p.paypalCaptureId) {
    refund = await paypal.refundCapture({
      paypalCaptureId: p.paypalCaptureId, amount: cents, key,
      note: reason || `North Foster Farm order ${id}`,
    }, { env, fetchImpl, now });
    if (p.squarePaymentId) {
      try {
        const copy = await square.refundPayment({
          squarePaymentId: p.squarePaymentId, amount: cents, key, reason,
        }, { env, fetchImpl });

        refund.squareRefundId = copy.squareRefundId;
      } catch (error) {
        console.error(`Square could not note the refund: ${error.message}`);
      }
    }
  } else if (p.squarePaymentId) {
    refund = await square.refundPayment({
      squarePaymentId: p.squarePaymentId, amount: cents, key, reason,
    }, { env, fetchImpl });
  } else {
    throw new Error("This order has no payment to refund.");
  }

  return recordRefund(stores, order, refund, "farm", now);
};

// The farm cancels: any status but fulfilled. Stock goes back, the
// fulfilment is cancelled in Square, the money goes back when asked
// (--refund), the customer is told.
export const cancelOrder = async (stores, id, {
  now = new Date(), env = process.env, mail = sendMail,
  square = squareApi, paypal = paypalApi, refund = false, amount, reason,
  fetchImpl,
} = {}) => {
  const order = need(await getOrder(stores, id), "order");

  if (["cancelled", "abandoned"].includes(order.status)) return order;

  if (refund && !order.refund) {
    await refundOrder(stores, id, {
      now, env, amount, reason, square, paypal, fetchImpl,
    });
  }

  const cancelled = await setStatus(stores, id, "cancelled", now, {
    source: "farm",
  });

  if (!order.cancelRequested) await adjust(stores, order.lines, 1);

  if (order.square && order.square.squareOrderId) {
    try {
      await square.cancelFulfilment(order.square.squareOrderId, {
        env, fetchImpl,
      });
    } catch (error) {
      console.error(`Square cancel failed: ${error.message}`);
    }
  }

  // A customer who already asked was already told.
  if (!order.cancelRequested) {
    const refunded = !!(await getOrder(stores, id)).refund;

    await sendForOrder(stores, cancelled, "orderCancelled",
      orderCancelled(cancelled, {
        refund: refunded, links: mailLinks(env),
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

// The range the farm confirms inside the customer's window: whole
// hours, at least PICKUP_HOURS long, inside the window's bounds
// (data/delivery.json, onFarm.windows). With nothing given, the first
// two hours of the window. -> { from, to } in 24-hour hours.
export const PICKUP_HOURS = 2;

export const pickupRange = (windowName, { at, until } = {}) => {
  const bounds = (terms.onFarm.windows || {})[windowName];

  if (!bounds) throw new Error(`Unknown pickup window "${windowName}".`);

  const from = at === undefined || at === "" ? bounds.from : Number(at);
  const to = until === undefined || until === ""
    ? from + PICKUP_HOURS : Number(until);

  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new Error("Hours are whole numbers on the 24-hour clock: " +
      "--at 9 --until 11.");
  }
  if (from < bounds.from || to > bounds.to) {
    throw new Error(`The ${windowName} window runs ${bounds.from}:00 to ` +
      `${bounds.to}:00.`);
  }
  if (to - from < PICKUP_HOURS) {
    throw new Error(`Give them at least ${PICKUP_HOURS} hours.`);
  }

  return { from, to };
};

// The on-farm pickups still waiting on the farm, oldest first: what
// `bin/nff orders confirm` with no order number works through.
export const pickupsNeedingConfirmation = async (stores) =>
  (await openOrders(stores))
    .filter((o) => o.fulfilment.method === "onfarm" && needsAgreement(o)
      && !questionOpen(o))
    .sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1));

// -> the order, agreed, with the confirmed range on
// `fulfilment.onfarm.confirmed`. Sends "confirmed" if it is already
// paid; the second of paid and agreed sends it, whichever that is.
// Confirming after a deny closes the question: the time works after
// all.
export const confirmPickup = async (stores, id, {
  at, until, now = new Date(), env = process.env, mail = sendMail,
} = {}) => {
  const order = await openPickup(stores, id);

  if (!needsAgreement(order) && !questionOpen(order)) return order;

  const confirmed = pickupRange(order.fulfilment.onfarm.window, { at, until });
  const agreed = await amendOrder(stores, id, {
    fulfilment: {
      ...order.fulfilment,
      state: "agreed",
      agreedAt: now.toISOString(),
      onfarm: { ...order.fulfilment.onfarm, confirmed },
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
