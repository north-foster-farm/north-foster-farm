// Orders the farm makes itself (#181; James, 2026-10-22): a customer
// who paid in person or by Venmo without the site, or who will pay
// later, on the account page or at the door. Customers never make
// these; `bin/nff orders create` and `orders pay` do.
//
// A farm-made order is priced and checked by the same code as the
// order page (validateOrder, with the farm's own overrides), gets its
// Square customer and order the way checkout gets them, and is
// recorded `unpaid` with no payment, or `paid` at once when the money
// is already in hand (`createFarmOrder` with `paid`). Each tender the
// farm records (`payFarmOrder`) goes to Square on the order's own
// Square order, never a second one: cash as Square's cash payment, a
// check as an EXTERNAL payment of type CHECK, and Venmo as the SOCIAL
// tender the site records for its own Venmo captures. The amount is
// whole cents, never more than what is due, and the Square call
// carries an idempotency key from the order and the count of its
// payments, so a retry after a lost answer finds the tender Square
// already holds instead of taking it twice. When nothing is due the
// order is paid and gets the usual confirmation; an order already
// closed (delivered first) is completed in Square then, since Square
// refuses to complete an order nobody paid for.
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
import { announceNew, attemptKey } from "./checkout.mjs";
import { now as clock } from "./clock.mjs";
import { completeInSquare } from "./complete.mjs";
import { mark } from "./health.mjs";
import { log } from "./log.mjs";
import { sendMail } from "./mail.mjs";
import { pickupSchedule } from "./pickups.mjs";
import {
  amendOrder, dueOn, getCustomer, getOrder, moneyPatch, paymentsOf,
  reserveOrderId, saveOrder, setStatus, touchCustomer,
} from "./records.mjs";
import * as squareApi from "./square.mjs";
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

const fail = (errors) => ({ ok: false, errors });

// A whole number of cents between 1 and `most`, or why not.
const centsOrError = (amount, most) => {
  if (amount === undefined || amount === null) return { cents: most };
  if (!Number.isInteger(amount) || amount < 1) {
    return { error: "The amount is whole cents, at least one." };
  }
  if (amount > most) {
    return { error: `The amount is more than what is due (${most} cents).` };
  }

  return { cents: amount };
};

// Validates and prices the farm's order as the page would, with the
// farm's overrides (any date the schedule knows, no delivery minimum).
// -> { ok: true, order } (no id yet) or { ok: false, errors }.
export const planFarmOrder = async (stores, body, {
  now = clock(), env = process.env,
} = {}) => {
  const b = body && typeof body === "object" ? body : {};
  const email = String((b.customer || {}).email || "").trim().toLowerCase();
  const customer = email ? await getCustomer(stores, email) : null;
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
    index, terms, now, codes: discountCodes.codes,
    group: (customer && customer.discountGroup) || null,
    schedule: pickupSchedule(env), farm: true,
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
    },
  };
};

// Makes the order: the id, the Square customer and order, the record
// (`unpaid`, with the Square ids and no payment), the stock and the
// customer record. With `paid` the tender is recorded at once, as
// `payFarmOrder` would. `key` is the submission's: the same key again
// finds the order it made (a retry after a lost answer), never a
// second one. `dryRun` prices and checks, and changes nothing.
// -> { ok: true, order, dryRun? } or { ok: false, errors }.
export const createFarmOrder = async (stores, body, {
  paid = null, key = `farm-${randomUUID()}`, dryRun = false,
  now = clock(), env = process.env, mail = sendMail, square = squareApi,
  fetchImpl,
} = {}) => {
  if (paid && !TENDERS[paid.tender]) {
    return fail({ paid: `The tender is one of: ${
      Object.keys(TENDERS).join(", ")}.` });
  }

  const planned = await planFarmOrder(stores, body, { now, env });

  if (!planned.ok) return planned;

  const draft = planned.order;

  if (paid) {
    const { error } = centsOrError(paid.amount, draft.totals.total);

    if (error) return fail({ amount: error });
  }
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
  await adjust(stores, order.lines, -1);
  await mark(stores, "order", { id }, now);
  log.info({ event: "order.farm_made", id, paid: !!paid });

  if (!paid) return { ok: true, order: saved };

  return payFarmOrder(stores, id, paid, {
    now, env, mail, square, fetchImpl,
  });
};

// Records a tender on an order the farm made, in Square and on the
// record. `amount` in cents, what is due unless said, never more.
// -> { ok: true, order, payment } or { ok: false, errors }.
export const payFarmOrder = async (stores, id, {
  tender, amount, ref = "",
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

  const { cents, error } = centsOrError(amount, due);

  if (error) return fail({ amount: error });

  const payments = paymentsOf(order);
  const base = (order.meta && order.meta.idempotencyKey) || order.id;
  const k = attemptKey(`${base}-pay`, payments.length + 1);
  let holder = order.square;

  // An order with no Square copy yet (one made before Square could
  // be reached) gets one now, so the tender has an order to sit on.
  if (!holder || !holder.squareOrderId) {
    const created = await square.createOrder(order, k, { env, fetchImpl });

    holder = {
      squareOrderId: created.squareOrderId, customerId: created.customerId,
    };
  }

  const paid = await square.createPayment({
    order,
    squareOrderId: holder.squareOrderId,
    customerId: holder.customerId,
    key: k,
    amount: cents,
    source: how.source(ref),
  }, { env, fetchImpl });

  // Square answered a retry with the payment it already holds: it is
  // on the record once.
  const known = payments.some(
    (p) => p.squarePaymentId === paid.squarePaymentId
  );
  const payment = {
    at: now.toISOString(), amount: cents, via: how.via, method: how.method,
    squarePaymentId: paid.squarePaymentId, receiptUrl: paid.receiptUrl,
    ref: ref || null, by: "farm",
  };
  let current = known ? order : await amendOrder(stores, id, {
    ...moneyPatch(order, { payments: [...payments, payment] }),
    square: holder,
  }, "farm.paid", now);

  if (dueOn(current) > 0) {
    log.info({ event: "order.farm_paid", id, amount: cents, via: how.via,
      due: dueOn(current) });

    return { ok: true, order: current, payment };
  }

  // Settled. An open unpaid order is paid now; one already closed
  // (delivered first) keeps its status, notes the day it was paid and
  // is completed in Square, which refused it unpaid.
  if (current.status === "unpaid") {
    current = await setStatus(stores, id, "paid", now, { source: "farm" });
  } else if (!current.paidAt) {
    current = await amendOrder(stores, id, { paidAt: now.toISOString() },
      "paid", now);
    if (current.status === "fulfilled") {
      current = await completeInSquare(stores, current, {
        now, env, mail, square, fetchImpl,
      }) || current;
    }
  }
  await mark(stores, "paid", { id, via: how.via }, now);
  log.info({ event: "order.farm_paid", id, amount: cents, via: how.via,
    due: 0 });

  const announced = await announceNew(stores, current, { mail, env, now });

  return { ok: true, order: announced || current, payment };
};
