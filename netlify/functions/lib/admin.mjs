// What the farm does from the CLI: decide addresses, set pricing
// groups, close and cancel orders, settle returns, count stock. The
// same records and rules as the customer-facing functions, with the
// farm's authority. bin/nff is the thin front.

import terms from "../../../data/delivery.json" with { type: "json" };
import { dollars } from "../../../assets/scripts/order/lib/totals.mjs";
import {
  addDays, today, weekday,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { adjust, getCounts, setCount } from "./stock.mjs";
import { normalizeEmail, validEmail } from "./auth.mjs";
import { company } from "./company.mjs";
import { sendMail } from "./mail.mjs";
import * as newsApi from "./news.mjs";
import { recordRefund, sendForOrder } from "./payments.mjs";
import * as paypalApi from "./paypal.mjs";
import {
  OPEN, allCustomers, allOrders, amendOrder, answerQuestion, byEmailKey,
  cartKey, deleteCustomer, deleteOrder, getCustomer, getOrder, keptFee,
  listCheckouts, ordersFor, paidTotal, paymentRef, paymentsOf, questionOpen,
  refundedTotal, saveCustomer, setStatus, settledRefunds,
} from "./records.mjs";
import { mailLinks, orderUrlFor } from "./site.mjs";
import * as squareApi from "./square.mjs";
import {
  addressDecision, missedDelivery, movedDelivery, orderCancelled,
  orderChanged,
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

// A customer's email changed, from the CLI (#238): the record, every
// order and its index, support messages, unsubscribe and farm-news
// links, the Resend contact and the Square customer move to the new
// address; sessions end and waiting sign-in links are voided, so the
// next sign-in is with the new one. Refuses when the new address has
// a record, or while a Venmo payment for the old one is under way.
// With `apply` false it only reports what it would do.
export const renameCustomer = async (stores, from, to, {
  apply = false, env = process.env, fetchImpl = globalThis.fetch,
  square = squareApi, news = newsApi, now = new Date(),
} = {}) => {
  const old = normalizeEmail(from);
  const next = normalizeEmail(to);

  if (!validEmail(next)) throw new Error(`"${to}" isn't an email address.`);
  if (old === next) throw new Error("The two addresses are the same.");

  const customer = need(await getCustomer(stores, old), "customer");

  if (await getCustomer(stores, next)) {
    throw new Error(`${next} already has an account. Nothing changed.`);
  }
  if ((await listCheckouts(stores)).some(
    (c) => normalizeEmail(c.order && c.order.customer
      && c.order.customer.email) === old
  )) {
    throw new Error(`A Venmo payment from ${old} is under way. Try again ` +
      "once it has finished or lapsed (a day at most).");
  }

  const orders = await ordersFor(stores, old);
  const auth = [];

  for (const prefix of ["session/", "token/", "unsub/", "news/"]) {
    for (const { key } of await stores.auth.list(prefix)) {
      const value = await stores.auth.get(key);

      if (value && normalizeEmail(value.email) === old) {
        auth.push({ key, value });
      }
    }
  }

  const support = await stores.customers.list(`support/${old}/`);
  const count = (prefix) => auth.filter((a) => a.key.startsWith(prefix))
    .length;
  const report = {
    apply, from: old, to: next,
    orders: orders.map((o) => o.id),
    supportMessages: support.length,
    sessionsEnded: count("session/"),
    signInLinksVoided: count("token/"),
    linksRepointed: count("unsub/") + count("news/"),
  };
  // The outside services are asked even on a dry run: reads only.
  const outside = async (name, fn) => {
    try {
      report[name] = await fn();
    } catch (error) {
      report[name] = `not reached: ${error.message}`;
    }
  };

  if (!apply) {
    await outside("resend", () => news.moveContact(old, next, {
      env, fetchImpl,
    }));
    await outside("square", () => square.renameCustomerEmail(old, next, {
      env, fetchImpl,
    }));

    return report;
  }

  await saveCustomer(stores, { ...customer, email: next });
  for (const order of orders) {
    await amendOrder(stores, order.id, {
      customer: { ...order.customer, email: next },
    }, "email changed", now);
    await stores.orders.delete(byEmailKey(old, order.id));
  }
  for (const { key } of support) {
    await stores.customers.set(`support/${next}/${key.split("/").pop()}`,
      await stores.customers.get(key));
    await stores.customers.delete(key);
  }
  for (const { key, value } of auth) {
    if (/^(session|token)\//.test(key)) {
      await stores.auth.delete(key);
    } else {
      await stores.auth.set(key, { ...value, email: next });
    }
  }
  const cart = await stores.customers.get(cartKey(old));

  if (cart) await stores.customers.set(cartKey(next), cart);
  await deleteCustomer(stores, old);
  await outside("resend", () => news.moveContact(old, next, {
    env, fetchImpl, apply: true,
  }));
  await outside("square", () => square.renameCustomerEmail(old, next, {
    env, fetchImpl, apply: true,
  }));

  return report;
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
// effort). Anything not yet refunded can go back, in as many calls as
// the farm likes; an order changed after paying has several payments,
// and a refund comes out of the newest first. -> the order.
export const refundOrder = async (stores, id, {
  now = new Date(), env = process.env, amount, reason = "",
  square = squareApi, paypal = paypalApi, fetchImpl,
  // An edit's refund carries the edit's key, so a retry refunds once,
  // and is recorded as the edit's (`edit`).
  key: base, source = "farm", edit,
} = {}) => {
  const order = need(await getOrder(stores, id), "order");

  if (!["paid", "cancelled", "fulfilled"].includes(order.status)) {
    throw new Error(`This order is ${order.status}.`);
  }

  const payments = paymentsOf(order);
  const kept = keptFee(order);
  const left = paidTotal(order) - refundedTotal(order) - kept;

  if (!payments.length) throw new Error("This order has no payment to refund.");
  if (left <= 0 && kept && refundedTotal(order) < paidTotal(order)) {
    throw new Error(`Only the delivery fee is left (${dollars(kept)}), ` +
      "and an attempted delivery keeps it.");
  }
  if (left <= 0) {
    throw new Error(`Already refunded in full (${
      dollars(refundedTotal(order))}).`);
  }

  const cents = amount === undefined ? left : amount;

  if (!Number.isInteger(cents) || cents <= 0 || cents > left) {
    throw new Error(`The refund must be between $0.01 and ${dollars(left)}.`);
  }

  // What each payment still holds: its amount less the refunds out of
  // it. A refund from before refunds named their payment came out of
  // the first.
  const refunds = settledRefunds(order);
  const outOf = (r) => r.payment || paymentRef(payments[0]);
  const holds = (p) => p.amount - refunds
    .filter((r) => outOf(r) === paymentRef(p))
    .reduce((s, r) => s + (r.amount || 0), 0);
  const stamp = now.getTime();
  let owed = cents;
  let saved = order;

  for (let i = payments.length - 1; i >= 0 && owed > 0; i -= 1) {
    const p = payments[i];
    const take = Math.min(owed, holds(p));

    if (take <= 0) continue;

    const key = `${base || `refund-${id}-${stamp}`}-${i}`;
    let refund;

    if (p.via === "venmo" && p.paypalCaptureId) {
      refund = await paypal.refundCapture({
        paypalCaptureId: p.paypalCaptureId, amount: take, key,
        note: reason || `${company.name} order ${id}`,
      }, { env, fetchImpl, now });
      if (p.squarePaymentId) {
        try {
          const copy = await square.refundPayment({
            squarePaymentId: p.squarePaymentId, amount: take, key, reason,
          }, { env, fetchImpl });

          refund.squareRefundId = copy.squareRefundId;
        } catch (error) {
          console.error(`Square could not note the refund: ${error.message}`);
        }
      }
    } else if (p.squarePaymentId) {
      refund = await square.refundPayment({
        squarePaymentId: p.squarePaymentId, amount: take, key, reason,
      }, { env, fetchImpl });
    } else {
      continue;
    }

    saved = await recordRefund(stores, order, {
      ...refund, amount: take, payment: paymentRef(p), edit,
    }, source, now);
    owed -= take;
  }

  return saved;
};

// A cancel, the farm's or the customer's: any status but fulfilled.
// Stock goes back, the fulfilment is cancelled in Square, the money
// goes back unless the farm says otherwise (--no-refund: W11a-1,
// T1c), the customer is told. The farm's `reason`, one of the
// templates' CANCEL_REASONS keys, or its `reasonText` is the
// customer's line why (T2a); either also goes on the refund. A
// booked pickup time the farm can't keep is cancelled the same way;
// nothing is denied (W11d, T2d).
export const cancelOrder = async (stores, id, {
  now = new Date(), env = process.env, mail = sendMail,
  square = squareApi, paypal = paypalApi, refund = true, amount, reason,
  reasonText = "", fetchImpl, source = "farm", key,
} = {}) => {
  const order = need(await getOrder(stores, id), "order");

  if (["cancelled", "abandoned"].includes(order.status)) return order;

  // Whatever has not gone back yet, less a fee an attempted delivery
  // keeps; a refund made earlier stays as it was.
  const refundNow = refund
    && paidTotal(order) - keptFee(order) > refundedTotal(order);

  if (refundNow) {
    await refundOrder(stores, id, {
      now, env, amount, reason: reasonText || reason, square, paypal,
      fetchImpl, source, key,
    });
  }

  const cancelled = await setStatus(stores, id, "cancelled", now, {
    source,
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

  // A customer who already asked was already told. The email states
  // the money (T1a): what went back just now, or else what went back
  // before, dated.
  if (!order.cancelRequested) {
    const earlier = settledRefunds(order);
    const justNow = refundedTotal(cancelled) - refundedTotal(order);

    await sendForOrder(stores, cancelled, "orderCancelled",
      orderCancelled(cancelled, {
        refunded: justNow || refundedTotal(order),
        refundedOn: justNow || !earlier.length ? null
          : earlier[earlier.length - 1].at,
        by: source === "customer" ? "customer" : "farm",
        reason, reasonText, links: mailLinks(env),
      }), { mail, env, now });
  }

  return getOrder(stores, id);
};

// Why a delivery could not be left (C6a). The fee follows the cause,
// not the bare miss (James, C1): a customer's miss keeps it, the
// farm's or the weather's waives it. No address we could find counts
// as the customer's, since the truck can't tell it from our own
// wrong turn; waive it when in doubt (C6b).
export const CUSTOMER_CAUSES = ["no-cooler", "no-access", "no-address"];
export const ATTEMPT_CAUSES = [...CUSTOMER_CAUSES, "weather", "farm"];

// The farm tried to deliver and could not: no cooler, nobody reached
// (James, F1). The attempt records its cause and the fee kept, in
// cents: 0 when waived, so a refund, a cancellation, a switch to
// pickup and every email read one fact. A customer's miss can be
// waived anyway, with the reason, at the same moment (C2). `note` is
// that private reason; `detail` is what the customer's email adds
// about where we couldn't get to (no-access). Marking twice keeps the
// first.
//
// A customer's miss, waived or not, asks them what to do (F2): the
// order holds a `missed` question until they reschedule, switch or
// cancel, or until the hold runs out (C8, `until`), and the
// missed-delivery email says so. -> the order.
export const markAttempted = async (stores, id, {
  cause, waive = "", detail = "", now = new Date(), env = process.env,
  mail = sendMail, square = squareApi, fetchImpl,
} = {}) => {
  const order = need(await getOrder(stores, id), "order");

  if (order.attempted) return order;
  if (!ATTEMPT_CAUSES.includes(cause)) {
    throw new Error(`Why did the delivery fail? One of: ${
      ATTEMPT_CAUSES.join(", ")}.`);
  }
  if (order.fulfilment.method !== "delivery") {
    throw new Error("Only a delivery can be attempted.");
  }
  if (order.status !== "paid") {
    throw new Error(`This order is ${order.status}.`);
  }

  const note = waive.trim();
  const theirs = CUSTOMER_CAUSES.includes(cause);
  const waived = !theirs || !!note;
  const marked = await amendOrder(stores, id, {
    attempted: {
      at: now.toISOString(),
      date: order.fulfilment.date,
      cause,
      fee: waived ? 0 : order.totals.deliveryFee || 0,
      waived,
      note,
      detail: detail.trim(),
    },
    ...theirs && {
      question: {
        kind: "missed", reason: "", openedAt: now.toISOString(),
        until: addDays(order.fulfilment.date, terms.delivery.holdDays),
        answeredAt: null, answer: null, by: null,
      },
    },
  }, "delivery.attempted", now);

  // Ours or the weather's: moved to the next delivery day, no fee, no
  // question (C7).
  if (!theirs) {
    return moveDelivery(stores, id, nextDeliveryDay(order.fulfilment.date),
      { now, env, mail, square, fetchImpl, email: "movedDelivery" });
  }

  return sendForOrder(stores, marked, "missedDelivery",
    missedDelivery(marked, {
      pickUrl: orderUrlFor(env, id), links: mailLinks(env),
    }), { mail, env, now });
};

const isDeliveryDay = (date) => weekday(date) === terms.delivery.weekday
  && !terms.holidays.includes(date);

// The first delivery day after `date`.
export const nextDeliveryDay = (date) => {
  let d = addDays(date, 1);

  while (!isDeliveryDay(d)) d = addDays(d, 1);

  return d;
};

// A delivery moved to another delivery day by the farm, past any
// cutoff: the record, Square's fulfilment, and the customer told.
// It answers a missed delivery's question, unless that miss was the
// customer's and kept the fee: the next trip charges the fee again
// (C1), which only the customer can pay, on the order page. `email`
// names the template: orderChanged, or movedDelivery after the farm's
// or the weather's miss (C7). -> the order.
export const moveDelivery = async (stores, id, date, {
  now = new Date(), env = process.env, mail = sendMail, square = squareApi,
  fetchImpl, email = "orderChanged",
} = {}) => {
  const order = need(await getOrder(stores, id), "order");

  if (order.fulfilment.method !== "delivery") {
    throw new Error("Only a delivery can be moved.");
  }
  if (order.status !== "paid") {
    throw new Error(`This order is ${order.status}.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !isDeliveryDay(date)
    || date <= today(now, terms.timeZone)) {
    throw new Error("Move it to a delivery day after today (YYYY-MM-DD).");
  }
  if (questionOpen(order) && order.question.kind === "missed"
    && keptFee(order) > 0) {
    throw new Error("The customer missed this delivery, so another trip " +
      `charges the fee of ${dollars(keptFee(order))} again, which only ` +
      "they can pay: they choose the day with Change items on their " +
      "account page, which the missed-delivery email links to.");
  }

  const moved = await amendOrder(stores, id, {
    fulfilment: { ...order.fulfilment, date },
    question: answerQuestion(order, "reschedule", "farm", now),
  }, "delivery.moved", now);
  const holder = order.square
    && (order.square.fulfilmentOrderId || order.square.squareOrderId);
  let saved = moved;

  if (holder) {
    try {
      await square.updateFulfilment(holder, moved, { env, fetchImpl });
    } catch (error) {
      console.error(`Square could not follow the move: ${error.message}`);
      saved = await amendOrder(stores, id, {
        flags: { ...(moved.flags || {}), squareOutOfSync: true },
      }, "square.out_of_sync", now);
    }
  }

  const links = mailLinks(env);
  const orderUrl = orderUrlFor(env, id);
  const message = email === "movedDelivery"
    ? movedDelivery(saved, { pickUrl: orderUrl, links })
    : orderChanged(saved, { orderUrl, links });

  return sendForOrder(stores, saved, `${email}-${date}`, message,
    { mail, env, now });
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
