// Orders the farm makes itself (#181; James, 2026-10-22): a customer
// who paid in person or by Venmo without the site, or who will pay
// later, on the account page or at the door. Customers never make
// these; `bin/nff orders create` and `orders pay` do.
//
// A farm-made order is priced and checked by the same code as the
// order page (validateOrder, with the farm's own overrides), gets its
// Square customer and order the way checkout gets them, and is
// recorded `unpaid` with no payment, or `paid` at once when the money
// is already in hand (`createFarmOrder` with `paid`). The tender the
// farm records (`payFarmOrder`), or the card the customer pays with
// later (`payOrder`), goes to Square on the order's own Square order,
// never a second one: cash as Square's cash payment, a check as an
// EXTERNAL payment of type CHECK, Venmo as the SOCIAL tender the site
// records for its own Venmo captures, a card or wallet as itself. One
// payment settles the order: Square takes a payment that completes
// at once only for the whole of its order, so there are no part
// payments here (splitting one needs autocomplete off and PayOrder).
//
// Two requests must never take the money twice or lose each other's
// write (security review, 2026-10-26). Before any charge a pending
// marker is written with a create-only write and refused to any other
// submission while it stands; the Square key comes from the
// submission and its attempt, so a retry finds the payment Square
// already holds, and a later attempt asks Square first; and every
// write to the record is a compare-and-swap against a fresh read,
// which records a payment once and moves the status to paid only
// from unpaid. When nothing is due the order is paid and gets the
// usual confirmation; an order already closed (delivered first) is
// completed in Square then, since Square refuses to complete an order
// nobody paid for.
//
// Nothing here changes what the checkout sends to Square.

import { randomUUID } from "node:crypto";

import catalog from "../../../data/catalog.json" with { type: "json" };
import discountCodes from "../../../data/discount-codes.json" with {
  type: "json",
};
import { indexCatalog } from "../../../assets/scripts/order/lib/catalog.mjs";
import {
  validateOrder,
} from "../../../assets/scripts/order/lib/validate.mjs";
import { orderId } from "../orders.mjs";
import { publicOrder } from "./account.mjs";
import { METHODS, announceNew, attemptKey } from "./checkout.mjs";
import { now as clock } from "./clock.mjs";
import { completeInSquare } from "./complete.mjs";
import { KEY } from "./edit.mjs";
import {
  groupOf, joinGroup, memberKeyOf, memberTerms, roundFor,
} from "./groups.mjs";
import { alert, mark } from "./health.mjs";
import { retry } from "./http.mjs";
import { log } from "./log.mjs";
import { sendMail } from "./mail.mjs";
import { pickupSchedule } from "./pickups.mjs";
import {
  dueOn, getCustomer, getOrder, paymentsOf, reserveOrderId, saveOrder,
  touchCustomer, updateOrder,
} from "./records.mjs";
import * as squareApi from "./square.mjs";
import { DECLINE_MESSAGES } from "./square.mjs";
import terms from "./terms.mjs";
import { adjust, checkLines } from "./stock.mjs";

const index = indexCatalog(catalog);

// The ways money reaches the farm without the site, and how each is
// told to Square. `ref` is what the farm knows the payment by: a
// Venmo transaction, a check number.
export const TENDERS = {
  cash: {
    via: "cash", method: "cash",
    source: () => ({ cash: true }),
  },
  check: {
    via: "check", method: "check",
    source: (ref) => ({
      external: { type: "CHECK", source: "Check", sourceId: ref || null },
    }),
  },
  venmo: {
    via: "venmo", method: "venmo",
    source: (ref) => ({
      external: { type: "SOCIAL", source: "Venmo", sourceId: ref || null },
    }),
  },
};

// A pending payment's marker stands this long: a request that died
// with the money taken is finished by the jobs' or the farm's hand
// before then, and a stale marker never locks an order for good.
export const PENDING_MS = 10 * 60_000;

const fail = (errors) => ({ ok: false, errors });

const pendingKey = (id) => `pay-pending/${id}`;

const line = (order, event, now, extra = {}) => [
  ...(order.history || []), { at: now.toISOString(), event, ...extra },
];

// The record with one more payment, once, and paid if nothing is due
// and it was unpaid. A closed order (delivered first) keeps its
// status and notes the day it was paid. -> the change for updateOrder
// (lib/records.mjs), which writes it only against an unchanged record
// and answers its argument itself for no change.
const recordPayment = (payment, event, now) => (stored) => {
  const payments = paymentsOf(stored);

  if (payments.some((p) => p.squarePaymentId === payment.squarePaymentId)) {
    return stored;
  }
  // Nothing was due (a second payment reached Square), or the order
  // was cancelled while the money was being taken: the record is left
  // alone and the caller raises the alarm (recordOrAlert).
  if (dueOn(stored) === 0
    || ["cancelled", "abandoned"].includes(stored.status)) return stored;

  const next = {
    ...stored,
    payments: [...payments, payment],
    refunds: stored.refunds || [],
    payment: undefined,
    refund: undefined,
  };
  const settled = dueOn(next) === 0;
  const history = line(stored, event, now);

  if (settled && stored.status === "unpaid") {
    return {
      ...next, status: "paid", paidAt: now.toISOString(),
      history: line({ history }, "paid", now, { source: payment.by }),
    };
  }

  return {
    ...next,
    ...(settled && !stored.paidAt && { paidAt: now.toISOString() }),
    history,
  };
};

// Claims the order for one submission before any money moves: the
// marker is written with a create-only write and stands for PENDING_MS
// or until the payment is recorded. The same submission may come
// again under the same attempt (the page's retry, which Square's key
// makes safe); a later attempt, or any other submission, is refused
// while it stands. A stale marker is taken over with a swap on its
// etag, so of two takers exactly one wins. -> null to go ahead, or
// "taken".
const claim = async (stores, id, key, attempt, now) => {
  const k = pendingKey(id);
  const mine = { key, attempt, at: now.toISOString() };
  const found = await stores.orders.getTagged(k);
  const held = found && found.value;
  const fresh = held && now.getTime() - Date.parse(held.at) < PENDING_MS;

  if (fresh) {
    return held.key === key && attempt <= (held.attempt || 1) ? null : "taken";
  }
  if (held) {
    return (await stores.orders.swap(k, mine, found.etag)) ? null : "taken";
  }
  if (await stores.orders.create(k, mine)) return null;

  const again = await stores.orders.get(k);

  return again && again.key === key && again.attempt === attempt
    ? null : "taken";
};

const release = async (stores, id, key) => {
  const held = await stores.orders.get(pendingKey(id));

  if (held && held.key === key) await stores.orders.delete(pendingKey(id));
};

// A payment Square already holds for this order that the record lacks:
// money taken by a request that died before its write, under any
// key. Asked before every charge. The order's own Square order is
// read, since a farm-made order's copy is made days before the
// customer pays and checkout's search of the last two days (findPaid)
// would not see it; that search is the fallback for an order with no
// copy. -> { squarePaymentId, amount, type } (Square's tender type:
// CASH, OTHER for an external tender, CARD and the rest for the
// customer's), or null.
const foundInSquare = async (order, square, { env, fetchImpl, now }) => {
  const known = (id) => paymentsOf(order)
    .some((p) => p.squarePaymentId === id);
  const copy = order.square && order.square.squareOrderId;

  if (copy) {
    const held = await square.getOrder(copy, { env, fetchImpl });
    const tender = ((held && held.tenders) || [])
      .find((t) => (t.payment_id || t.id) && !known(t.payment_id || t.id));

    if (!tender) return null;

    return {
      squarePaymentId: tender.payment_id || tender.id,
      amount: tender.amount_money ? tender.amount_money.amount : null,
      type: tender.type || "CARD",
    };
  }

  const found = await square.findPaid(order, { env, fetchImpl, now });

  return found && found.squarePaymentId && !known(found.squarePaymentId)
    ? { ...found, type: found.external ? "OTHER" : "CARD" } : null;
};

// The record of a payment found in Square, labelled by what Square
// says it was: cash or an external tender is the farm's, taken by
// hand (a lost farm write a customer's request found must not read
// as the customer's card, which would let them cancel for a card
// refund); anything else is the customer's, under their submission.
const asPayment = (found, { method, key, due, now }) => {
  const base = {
    at: now.toISOString(), amount: found.amount || due,
    squarePaymentId: found.squarePaymentId,
    receiptUrl: found.receiptUrl || null, brand: found.brand || null,
    last4: found.last4 || null, wallet: found.wallet || null,
  };

  if (found.type === "CASH") {
    return { ...base, via: "cash", method: "cash", ref: null, by: "farm" };
  }
  if (found.type === "OTHER") {
    return {
      ...base, via: "external", method: "external", ref: null, by: "farm",
    };
  }

  return { ...base, via: "square", method, pay: key, by: "customer" };
};

// Writes the payment to the record, once. A payment the record will
// not take (nothing was due, so the money reached Square twice; or
// the order was cancelled while the money was being taken) is the
// farm's to refund, and it hears at once; the caller then neither
// marks the day nor sends the confirmation. -> { order, taken }.
const recordOrAlert = async (stores, id, payment, event, {
  env, mail, now,
}) => {
  const next = await updateOrder(stores, id, recordPayment(payment, event,
    now));
  const taken = paymentsOf(next)
    .some((p) => p.squarePaymentId === payment.squarePaymentId);

  if (!taken) {
    const detail = {
      id, amount: payment.amount, squarePaymentId: payment.squarePaymentId,
      status: next ? next.status : "gone",
    };

    log.error({ event: "order.paid_twice", ...detail });
    await alert(stores, "order.paid_twice", detail, { env, mail, now });
  }

  return { order: next, taken };
};

// Whether a payment of the order is under way: a fresh claim stands
// (#181). The farm's cancel waits for it, so money is never taken on
// an order being cancelled.
export const paymentPending = async (stores, id, now = clock()) => {
  const held = await stores.orders.get(pendingKey(id));

  return !!held && now.getTime() - Date.parse(held.at) < PENDING_MS;
};

// What the farm's command says when the record refused the money.
const refusedTender = (order, payment) => fail({
  order: `This order is ${order ? order.status : "gone"}, so the ` +
    `payment was not recorded: refund Square payment ${
      payment.squarePaymentId} (${payment.amount} cents) in Square.`,
});

// Validates and prices the farm's order as the page would, with the
// farm's overrides (any date the schedule knows; the delivery minimum
// only when waived). -> { ok: true, order } (no id yet) or
// { ok: false, errors }.
// `group` is a buying group (#471) the order belongs to, else the
// customer's own membership decides; `kept` is an occurrence the
// order may hold though it is no longer offered (a walk-in sale at a
// round, recorded after it); `walkIn` marks such a sale on the tag.
export const planFarmOrder = async (stores, body, {
  now = clock(), env = process.env, group = null, kept = null,
  walkIn = false,
} = {}) => {
  const b = body && typeof body === "object" ? body : {};
  const email = String((b.customer || {}).email || "").trim().toLowerCase();
  const customer = email ? await getCustomer(stores, email) : null;
  const buying = group || groupOf(memberKeyOf(customer));
  // The page drops a SKU it does not know; the farm typed it, so it
  // hears.
  const unknown = (Array.isArray(b.lines) ? b.lines : [])
    .map((l) => String((l && l.sku) || ""))
    .filter((sku) => !index.has(sku));

  if (unknown.length) {
    return fail(Object.fromEntries(unknown.map((sku) => [
      `lines.${sku}`, `No such SKU: ${sku}.`,
    ])));
  }

  const options = {
    index, terms: memberTerms(terms, buying), now, codes: discountCodes.codes,
    group: (customer && customer.discountGroup) || null,
    lock: buying ? buying.priceLock || null : null,
    schedule: pickupSchedule(env), farm: true, kept,
    // The delivery minimum binds the farm too unless it says so
    // (`--waive-minimum`), so a $20 delivery is never an accident.
    waive: { minimum: b.waiveMinimum === true },
  };
  let result = validateOrder(b, options);

  // The total is ours to claim: the page learns it the same way.
  if (result.ok) {
    result = validateOrder({ ...b, claimedTotal: result.order.totals.total },
      options);
  }
  if (!result.ok) return fail(result.errors);

  const stock = await checkLines(stores, result.order.lines, { env });

  if (!stock.ok) return fail(stock.errors);

  return {
    ok: true,
    order: {
      ...result.order,
      fulfilment: { ...result.order.fulfilment, state: "agreed" },
      // The group tag (#471), as POST /api/orders gives it.
      group: buying
        ? {
          key: buying.key,
          round: roundFor(buying, terms, result.order.fulfilment.date),
          viaCode: false,
          ...(walkIn ? { walkIn: true } : {}),
        }
        : null,
    },
  };
};

// Makes the order: the id, the Square customer and order, the record
// (`unpaid`, with the Square ids and no payment), the stock and the
// customer record. With `paid` the tender is recorded at once, as
// `payFarmOrder` would; if that fails the order stands unpaid and
// the error names it and the command that finishes it. `key` is the
// submission's: the same key again finds the order it made (a retry
// after a lost answer), never a second one. `dryRun` prices and
// checks, and changes nothing.
// -> { ok: true, order, dryRun? } or { ok: false, errors, order? }.
export const createFarmOrder = async (stores, body, {
  paid = null, key = `farm-${randomUUID()}`, dryRun = false,
  now = clock(), env = process.env, mail = sendMail, square = squareApi,
  fetchImpl, group = null, kept = null, walkIn = false,
} = {}) => {
  if (paid && !TENDERS[paid.tender]) {
    return fail({ paid: `The tender is one of: ${
      Object.keys(TENDERS).join(", ")}.` });
  }

  const planned = await planFarmOrder(stores, body, {
    now, env, group, kept, walkIn,
  });

  if (!planned.ok) return planned;

  const draft = planned.order;

  if (dryRun) return { ok: true, dryRun: true, order: draft };

  const id = await reserveOrderId(stores, key, (n) => orderId(key, now, n),
    now);
  const found = await getOrder(stores, id);

  if (found) return { ok: true, order: found, found: true };

  const order = {
    id,
    submittedAt: now.toISOString(),
    ...draft,
    meta: {
      formVersion: catalog.version, idempotencyKey: key, attempt: 1,
      source: "farm",
    },
  };
  const k = attemptKey(key, 1);
  const created = await square.createOrder(order, k, { env, fetchImpl });
  const saved = await saveOrder(stores, {
    ...order,
    status: "unpaid",
    square: {
      squareOrderId: created.squareOrderId || null,
      customerId: created.customerId || null,
    },
    payments: [],
    refunds: [],
  }, now);

  await touchCustomer(stores, order.customer, now, { orderId: id });
  // A buying group's order makes its customer a member (#471), as a
  // paid order with the code does.
  if (order.group && order.group.key) {
    await joinGroup(stores, order.customer.email, order.group.key, {
      now, via: walkIn ? "walk-in" : "farm",
    });
  }
  await adjust(stores, order.lines, -1);
  await mark(stores, "order", { id }, now);
  log.info({ event: "order.farm_made", id, paid: !!paid });

  if (!paid) return { ok: true, order: saved };

  try {
    const r = await payFarmOrder(stores, id, paid, {
      now, env, mail, square, fetchImpl,
    });

    if (r.ok) return r;

    return { ...r, order: saved, errors: {
      paid: `Order ${id} was made and is unpaid; the payment was not ` +
        `recorded: ${Object.values(r.errors).join(" ")} Record it with: ` +
        `bin/nff orders pay ${id} --${paid.tender}`,
    } };
  } catch (error) {
    return { ok: false, order: saved, errors: {
      paid: `Order ${id} was made and is unpaid; the payment failed: ${
        error && error.message}. Record it with: bin/nff orders pay ${id} ` +
        `--${paid.tender}`,
    } };
  }
};

// Records the tender that settles an order the farm made, in Square
// and on the record: the whole of what is due, one payment.
// -> { ok: true, order, payment } or { ok: false, errors }.
export const payFarmOrder = async (stores, id, {
  tender, ref = "",
} = {}, {
  now = clock(), env = process.env, mail = sendMail, square = squareApi,
  fetchImpl,
} = {}) => {
  const how = TENDERS[tender];

  if (!how) {
    return fail({ tender: `The tender is one of: ${
      Object.keys(TENDERS).join(", ")}.` });
  }

  const order = await getOrder(stores, id);

  if (!order) return fail({ order: `No order ${id}.` });
  if (["cancelled", "abandoned"].includes(order.status)) {
    return fail({ order: `This order is ${order.status}.` });
  }

  const due = dueOn(order);

  if (due === 0) return fail({ order: "Nothing is due on this order." });

  // One claim per tender the farm records; a customer paying at the
  // same moment holds the order against it, and the farm hears.
  const key = `farm-pay-${id}-${paymentsOf(order).length + 1}`;
  const taken = await claim(stores, id, key, 1, now);

  if (taken) {
    return fail({ order: "A payment for this order is under way. Give " +
      "it a minute, then look at the order again." });
  }

  try {
    // The order as it is now that the claim holds: a payment that
    // landed between the first read and the claim settles it.
    const fresh = await getOrder(stores, id);

    if (!fresh || ["cancelled", "abandoned"].includes(fresh.status)) {
      return fail({ order: `This order is ${fresh ? fresh.status
        : "gone"}.` });
    }
    if (dueOn(fresh) === 0) {
      return fail({ order: "Nothing is due on this order." });
    }

    const k = attemptKey(key, 1);
    let holder = fresh.square;

    // Money Square already holds for the order (a write that died
    // after the charge, under any key) is recorded, not taken again,
    // and the farm is told.
    if (holder && holder.squareOrderId) {
      const found = await foundInSquare(fresh, square, { env, fetchImpl,
        now });

      if (found) {
        // A card tender here is a customer's lost write, not the
        // farm's tender; asPayment reads cash and external as the farm's.
        const payment = asPayment(found, { method: "card", due, now });
        const { order: current, taken } = await recordOrAlert(stores, id,
          payment, "farm.paid", { env, mail, now });

        if (!taken) return refusedTender(current, payment);

        const done = await finish(stores, current, payment, {
          now, env, mail, square, fetchImpl,
        });

        return { ...done, found: true };
      }
    }

    // An order with no Square copy yet (one made before Square could
    // be reached) gets one now, on the record before any money, so the
    // tender has an order to sit on and the copy is never lost.
    if (!holder || !holder.squareOrderId) {
      const created = await square.createOrder(fresh, k, { env, fetchImpl });

      holder = {
        squareOrderId: created.squareOrderId, customerId: created.customerId,
      };
      await updateOrder(stores, id, (stored) => ({
        ...stored, square: holder,
      }));
    }

    const paid = await square.createPayment({
      order: fresh,
      squareOrderId: holder.squareOrderId,
      customerId: holder.customerId,
      key: k,
      amount: due,
      source: how.source(ref),
    }, { env, fetchImpl });
    const payment = {
      at: now.toISOString(), amount: due, via: how.via, method: how.method,
      squarePaymentId: paid.squarePaymentId, receiptUrl: paid.receiptUrl,
      ref: ref || null, by: "farm",
    };
    const { order: current, taken } = await recordOrAlert(stores, id,
      payment, "farm.paid", { env, mail, now });

    if (!taken) return refusedTender(current, payment);

    return finish(stores, current, payment, { now, env, mail, square,
      fetchImpl });
  } finally {
    await release(stores, id, key);
  }
};

// After the money is on the record: a closed order (delivered first)
// is completed in Square now, the day is marked, and the confirmation
// goes if the order is settled.
const finish = async (stores, order, payment, {
  now, env, mail, square, fetchImpl,
}) => {
  let current = order;

  if (dueOn(current) > 0) {
    log.info({ event: "order.farm_paid", id: current.id,
      amount: payment.amount, via: payment.via, due: dueOn(current) });

    return { ok: true, order: current, payment };
  }
  if (current.status === "fulfilled") {
    current = await completeInSquare(stores, current, {
      now, env, mail, square, fetchImpl,
    }) || current;
  }
  await mark(stores, "paid", { id: current.id, via: payment.via }, now);
  log.info({ event: "order.farm_paid", id: current.id,
    amount: payment.amount, via: payment.via, due: 0 });

  const announced = await announceNew(stores, current, { mail, env, now });

  return { ok: true, order: announced || current, payment };
};

// --- The customer pays later -----------------------------------------

const refuse = (status, errors, extra = {}) =>
  ({ ok: false, status, errors, ...extra });

// A processor's failure as the page reads it, as the order and edit
// endpoints answer: 402 a decline, 503 try again, 502 not.
const asAnswer = async (stores, id, error, { env, mail, now }) => {
  if (error && error.declined) {
    return refuse(402, {
      payment: DECLINE_MESSAGES[error.code]
        || "The payment didn't go through. Try another way to pay.",
    }, { declined: true, code: error.code || null });
  }

  log.error({
    event: "order.pay_failed", id, error: String(error && error.message),
    detail: error && error.detail,
  });
  await alert(stores, "order.pay_failed", {
    id, error: String(error && error.message),
  }, { env, mail, now });

  return refuse(error && error.retryable ? 503 : 502, {
    order: "We couldn't take the payment. Try again in a minute.",
  }, { retryable: !!(error && error.retryable) });
};

// Square's own names for money taken outside the site: never from a
// browser.
const RESERVED_SOURCES = new Set(["CASH", "EXTERNAL"]);

// POST /api/account/orders/<id>/pay (#181): the signed-in customer
// pays what is due on an order the farm made for them, with the
// SDK's token for a card or a wallet, on the order's own Square order.
// Venmo is not offered for paying later. A key whose payment is on
// the record answers with the record and charges nothing; a later
// attempt of the same key asks Square for the money it already took
// and records that instead of charging again. -> { ok, order (public),
// difference } or { ok: false, status, errors }.
export const payOrder = async (stores, customer, id, body, {
  now = clock(), env = process.env, mail = sendMail, square = squareApi,
  fetchImpl, sleep,
} = {}) => {
  const order = await getOrder(stores, id);

  if (!order || order.customer.email !== customer.email) {
    return refuse(404, { order: "We can't find that order." });
  }

  const b = body && typeof body === "object" ? body : {};
  const key = String(b.idempotencyKey || "");

  if (!KEY.test(key)) {
    return refuse(422, { idempotencyKey: "Missing submission key." });
  }
  if (paymentsOf(order).some((p) => p.pay === key)) {
    return { ok: true, order: publicOrder(order, now), difference: 0 };
  }

  const due = dueOn(order);

  if (order.status !== "unpaid" || due === 0) {
    return refuse(409, { order: "Nothing is due on this order." });
  }

  const payment = b.payment && typeof b.payment === "object" ? b.payment : {};
  const method = String(payment.method || "");
  const sourceId = String(payment.sourceId || "");

  if (!METHODS[method] || method === "venmo") {
    return refuse(422, { payment: "Choose how to pay." });
  }
  if (!sourceId || RESERVED_SOURCES.has(sourceId.toUpperCase())) {
    return refuse(422, { payment: "Enter your card details." });
  }

  const attempt = Number.isInteger(b.attempt) && b.attempt >= 1
    && b.attempt <= 50 ? b.attempt : 1;
  const taken = await claim(stores, id, key, attempt, now);

  if (taken) {
    // Draft wording.
    return refuse(409, { order: "A payment for this order is already " +
      "under way. Give it a minute, then look at your orders." });
  }

  const opts = { env, fetchImpl, now };
  const record = (p, event) => recordOrAlert(stores, id, p, event,
    { env, mail, now });
  // The money is in. A record that took it is settled: the day is
  // marked and the confirmation goes. One that refused it (settled or
  // cancelled meanwhile; the farm was alerted to refund) gets neither,
  // and the claim is released either way.
  const settle = async ({ order: current, taken }) => {
    await release(stores, id, key);
    if (!taken) {
      return {
        ok: true, order: publicOrder(current, now), difference: due,
        refused: true,
      };
    }
    await mark(stores, "paid", { id, via: "square" }, now);
    log.info({ event: "order.paid_later", id, amount: due, method });

    const announced = await announceNew(stores, current, { mail, env, now });

    return {
      ok: true, order: publicOrder(announced || current, now), difference: due,
    };
  };

  try {
    // The order as it is now that the claim holds: a payment that
    // landed between the first read and the claim (another tab, the
    // farm's own tender) settles it, and this one charges nothing.
    const fresh = await getOrder(stores, id);

    if (fresh && paymentsOf(fresh).some((p) => p.pay === key)) {
      await release(stores, id, key);

      return { ok: true, order: publicOrder(fresh, now), difference: 0 };
    }
    if (!fresh || fresh.status !== "unpaid" || dueOn(fresh) === 0) {
      await release(stores, id, key);

      return refuse(409, { order: "Nothing is due on this order." });
    }

    const k = attemptKey(key, attempt);
    let holder = fresh.square;

    // Money Square already holds for the order (a request that died
    // after the charge, under any key: a later attempt, a fresh
    // submission, the farm's own tender) is recorded, not taken again.
    // An order with no Square copy yet has nothing to ask.
    if (holder && holder.squareOrderId) {
      const found = await retry(() => foundInSquare(fresh, square, opts),
        { sleep });

      if (found) {
        return settle(await record(asPayment(found, {
          method, key, due, now,
        }), "customer.paid"));
      }
    }
    if (!holder || !holder.squareOrderId) {
      const created = await retry(() => square.createOrder(fresh, k, opts),
        { sleep });

      holder = {
        squareOrderId: created.squareOrderId, customerId: created.customerId,
      };
      await updateOrder(stores, id, (stored) => ({
        ...stored, square: holder,
      }));
    }

    const paid = await retry(() => square.createPayment({
      order: fresh,
      squareOrderId: holder.squareOrderId,
      customerId: holder.customerId,
      key: k,
      amount: due,
      source: {
        sourceId,
        verificationToken: payment.verificationToken
          ? String(payment.verificationToken) : undefined,
      },
    }, opts), { sleep });

    return settle(await record({
      at: now.toISOString(), amount: due, via: "square", method,
      squarePaymentId: paid.squarePaymentId, receiptUrl: paid.receiptUrl,
      brand: paid.brand, last4: paid.last4, wallet: paid.wallet, pay: key,
      by: "customer",
    }, "customer.paid"));
  } catch (error) {
    await release(stores, id, key);

    return asAnswer(stores, id, error, { env, mail, now });
  }
};
