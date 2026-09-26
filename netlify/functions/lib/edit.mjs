// Changing what is in a paid order (#160). The customer sends the
// order as it should now be, and it is validated and priced exactly as
// a new order is, at today's catalog prices. What the page does not
// carry (the notes, the pickup phone, the drop-off details) is filled
// in from the record first. Then, by the new total against what is
// paid and not refunded:
//
//   more   the difference is charged through the same card and wallet
//          flow, on a Square order of its own that lists what was
//          added (square.mjs, buildChangeOrder)
//   less   the difference goes back through whichever processor took
//          the money, newest payment first (admin.mjs, refundOrder)
//   same   only the record and Square's fulfilment change
//
// Stock moves by the change alone, and a line already in the order may
// stay even if it has sold out since. A switch between delivery and
// pickup moves the fulfilment to a new Square order, since Square
// cannot change a fulfilment's type: the old one is cancelled.
//
// Every edit carries its own idempotency key. It is written to the
// record as pending before any money moves, so a retry finishes the
// same edit and never charges or refunds twice.

import catalog from "../../../data/catalog.json" with { type: "json" };
import terms from "../../../data/delivery.json" with { type: "json" };
import discountCodes from "../../../data/discount-codes.json" with {
  type: "json",
};
import { indexCatalog } from "../../../assets/scripts/order/lib/catalog.mjs";
import {
  validateOrder,
} from "../../../assets/scripts/order/lib/validate.mjs";
import { canChange, publicOrder } from "./account.mjs";
import { refundOrder } from "./admin.mjs";
import { attemptKey, METHODS } from "./checkout.mjs";
import { alert } from "./health.mjs";
import { retry } from "./http.mjs";
import { log } from "./log.mjs";
import { sendMail } from "./mail.mjs";
import {
  amendOrder, getOrder, moneyPatch, paidTotal, paymentsOf, refundedTotal,
  refundsOf,
} from "./records.mjs";
import * as squareApi from "./square.mjs";
import { DECLINE_MESSAGES as SQUARE_DECLINES } from "./square.mjs";
import { adjust, checkLines } from "./stock.mjs";

const index = indexCatalog(catalog);

export const KEY = /^[A-Za-z0-9-]{16,64}$/;

const fail = (status, errors, extra = {}) =>
  ({ ok: false, status, errors, ...extra });

// The record as a payload, so a partial one from the page validates as
// a whole order. The customer is the record's: an edit never moves an
// order to another email.
export const payloadFor = (order, body = {}) => {
  const f = order.fulfilment;
  const next = body.fulfilment && typeof body.fulfilment === "object"
    ? body.fulfilment
    : {};
  const method = next.method || f.method;
  const same = method === f.method;
  const old = (key) => (same && f[key]) || {};

  return {
    customer: {
      ...order.customer,
      firstName: order.customer.firstName
        || order.customer.name.split(/\s+/)[0],
      lastName: order.customer.lastName
        || order.customer.name.split(/\s+/).slice(1).join(" "),
    },
    fulfilment: {
      method,
      date: next.date || (same ? f.date : null),
      onfarm: { ...old("onfarm"), ...(next.onfarm || {}) },
      delivery: { ...old("delivery"), ...(next.delivery || {}) },
    },
    lines: Array.isArray(body.lines)
      ? body.lines
      : order.lines.map(({ sku, qty }) => ({ sku, qty })),
    code: body.code !== undefined ? body.code : order.code,
    notes: order.notes,
    source: order.source,
    claimedTotal: body.claimedTotal,
  };
};

// What changed in the lines. `added` and `removed` carry the new
// order's price and names; `delta` is what stock moves by.
export const diffLines = (before, after) => {
  const was = new Map(before.map((l) => [l.sku, l.qty]));
  const now = new Map(after.map((l) => [l.sku, l]));
  const skus = new Set([...was.keys(), ...now.keys()]);
  const added = [];
  const removed = [];
  const delta = [];

  for (const sku of skus) {
    const qty = (now.get(sku) ? now.get(sku).qty : 0) - (was.get(sku) || 0);

    if (!qty) continue;
    delta.push({ sku, qty });

    const line = now.get(sku) || before.find((l) => l.sku === sku);

    (qty > 0 ? added : removed).push({ ...line, qty: Math.abs(qty) });
  }

  return { added, removed, delta };
};

// What the customer has paid and not had back.
export const heldOn = (order) => paidTotal(order) - refundedTotal(order);

// Validated, priced and checked, before any money: the new order, and
// the change against the record. -> { ok, order, next, change } or a
// failure shaped like the order endpoint's.
export const planEdit = async (stores, order, body, {
  now, index, terms, codes, group, validate,
}) => {
  const result = validate(payloadFor(order, body), {
    index, terms, now, group, codes,
  });

  if (!result.ok) {
    return fail(result.status, result.errors, { dates: result.dates });
  }

  const next = result.order;
  const change = diffLines(order.lines, next.lines);
  const stock = await checkLines(stores, change.added);

  if (!stock.ok) return fail(422, stock.errors, { stock: stock.items });
  if (next.flags.totalMismatch) {
    return fail(422, {
      total: "The total changed while you were on this page. Check it " +
        "and try again.",
    }, { totals: next.totals });
  }

  const switched = next.fulfilment.method !== order.fulfilment.method;

  change.difference = next.totals.total - heldOn(order);
  change.switched = switched;
  // A switch needs a Square order to carry the new fulfilment, even
  // when there is nothing to pay.
  change.carries = switched;

  if (!change.delta.length && !switched && change.difference === 0
    && next.fulfilment.date === order.fulfilment.date) {
    return fail(422, { order: "Nothing has changed." });
  }

  return { ok: true, order, next, change };
};

// The record as it becomes. An on-farm pickup whose day, window or
// method changed waits for the farm's agreement again; anything else
// keeps the state it had.
const changedRecord = (order, next, change, key, now) => {
  const f = next.fulfilment;
  const was = order.fulfilment;
  const moved = f.method === "onfarm" && (change.switched
    || f.date !== was.date
    || (f.onfarm || {}).window !== (was.onfarm || {}).window);
  const fulfilment = moved
    ? { ...f, state: "requested", agreedAt: null,
      onfarm: { ...f.onfarm, confirmed: null } }
    : { ...f, state: f.method === "onfarm" ? was.state : "agreed",
      agreedAt: was.agreedAt || null };

  return {
    lines: next.lines,
    totals: next.totals,
    code: next.code,
    flags: { ...(order.flags || {}), zipUnlisted: next.flags.zipUnlisted },
    fulfilment,
    edits: [...(order.edits || []), {
      key, at: now.toISOString(), state: "pending",
      difference: change.difference, switched: change.switched,
      before: { lines: order.lines, totals: order.totals, method: was.method },
    }],
  };
};

const editOf = (order, key) => (order.edits || []).find((e) => e.key === key);

const markEdit = (order, key, patch) => ({
  edits: (order.edits || []).map((e) => (e.key === key ? { ...e, ...patch }
    : e)),
});

// Takes the difference for a change by card or wallet: a Square order
// of what was added, and a payment of the difference against it.
// -> { payment, squareOrderId }
const chargeSquare = async (order, change, k, payment, {
  square, env, fetchImpl, sleep,
}) => {
  const created = await retry(() => square.createChangeOrder(
    order, change, k, { env, fetchImpl }
  ), { sleep });
  const pseudo = { ...order, totals: { ...order.totals,
    total: change.difference } };
  let paid;

  try {
    paid = await retry(() => square.createPayment({
      order: pseudo,
      squareOrderId: created.squareOrderId,
      customerId: created.customerId,
      key: k,
      source: {
        sourceId: payment.sourceId,
        verificationToken: payment.verificationToken,
      },
    }, { env, fetchImpl }), { sleep });
  } catch (error) {
    if (error && error.declined) {
      try {
        await square.cancelOrder(created.squareOrderId, { env, fetchImpl });
      } catch {
        // Best effort, as for a new order.
      }
    }
    throw error;
  }

  return {
    squareOrderId: created.squareOrderId,
    payment: {
      via: "square",
      method: METHODS[payment.method] ? payment.method : "card",
      squarePaymentId: paid.squarePaymentId,
      receiptUrl: paid.receiptUrl,
      brand: paid.brand,
      last4: paid.last4,
      wallet: paid.wallet,
    },
  };
};

// Square's view after the money: the fulfilment the farm packs from
// follows the change, on the order that carries it. Failures are the
// farm's to fix by hand; the customer's change stands.
const syncFulfilment = async (stores, saved, change, { changeOrderId, k,
  square, env, fetchImpl, mail, now }) => {
  const holder = saved.square && (saved.square.fulfilmentOrderId
    || saved.square.squareOrderId);

  if (!holder) return saved;

  try {
    if (!change.carries) {
      await square.updateFulfilment(holder, saved, { env, fetchImpl });

      return saved;
    }

    let carrier = changeOrderId;

    if (!carrier) {
      const created = await square.createChangeOrder(saved, change, k, {
        env, fetchImpl,
      });

      carrier = created.squareOrderId;
      await square.payZeroOrder(carrier, k, { env, fetchImpl });
    }
    await square.cancelFulfilment(holder, { env, fetchImpl });

    return amendOrder(stores, saved.id, {
      square: { ...saved.square, fulfilmentOrderId: carrier },
    }, "square.fulfilment_moved", now);
  } catch (error) {
    log.error({
      event: "square.update_failed", id: saved.id,
      error: String(error && error.message),
    });
    await alert(stores, "square.edit_failed", {
      id: saved.id, error: String(error && error.message),
    }, { env, mail, now });

    return amendOrder(stores, saved.id, {
      flags: { ...(saved.flags || {}), squareOutOfSync: true },
    }, "square.out_of_sync", now);
  }
};

// The whole edit, once planned: the record marked pending, the money,
// the record finished, stock and Square brought into line.
// -> the saved record.
// throws SquareError { declined, code } or { retryable }, like the
// order endpoint's payments; a refund failure throws as the CLI's does.
export const applyEdit = async (stores, plan, { key, attempt = 1, payment },
  {
    square = squareApi, paypal, env = process.env, fetchImpl, sleep,
    mail = sendMail, now = new Date(),
  } = {}) => {
  const { next, change } = plan;
  const id = plan.order.id;
  const k = attemptKey(key, attempt);
  let order = await getOrder(stores, id);
  const started = editOf(order, key);

  if (started && started.state === "done") return order;

  const patch = started ? {} : changedRecord(order, next, change, key, now);
  const after = { ...order, ...patch };
  let changeOrderId = null;

  if (change.difference > 0) {
    // The money first: a declined card leaves the order as it was.
    const charged = await chargeSquare(after, change, k, payment, {
      square, env, fetchImpl, sleep,
    });
    const payments = paymentsOf(order);

    changeOrderId = charged.squareOrderId;
    order = await amendOrder(stores, id, {
      ...patch,
      ...moneyPatch(order, {
        payments: payments.some((p) => p.squarePaymentId
          === charged.payment.squarePaymentId)
          ? payments
          : [...payments, {
            at: now.toISOString(), amount: change.difference, edit: key,
            ...charged.payment,
          }],
      }),
      square: order.square ? { ...order.square, changes: [
        ...(order.square.changes || []),
        { squareOrderId: changeOrderId, at: now.toISOString(),
          amount: change.difference },
      ] } : order.square,
    }, "edit.paid", now);
  } else if (!started) {
    // Nothing to charge: the change is recorded first, so a refund that
    // fails is retried by the same key rather than lost.
    order = await amendOrder(stores, id, patch, "edit.started", now);
  }
  if (!started) await adjust(stores, change.delta, -1);

  if (change.difference < 0) {
    const done = refundsOf(order).filter((r) => r.edit === key)
      .reduce((s, r) => s + r.amount, 0);
    const owed = -change.difference - done;

    if (owed > 0) {
      await refundOrder(stores, id, {
        now, env, amount: owed, reason: `Order ${id} changed`,
        key: `edit-${k}`, source: "customer", edit: key,
        square, paypal, fetchImpl,
      });
    }
    order = await getOrder(stores, id);
  }

  order = await amendOrder(stores, id, markEdit(order, key, { state: "done" }),
    "edit.done", now);

  return syncFulfilment(stores, order, change, {
    changeOrderId, k, square, env, fetchImpl, mail, now,
  });
};

// POST /api/account/orders/:id/edit, for the signed-in owner, until
// the cutoff. The body is the order as it should now be (any part of
// it; the rest comes from the record), plus `claimedTotal`,
// `idempotencyKey`, `attempt`, and `payment` when there is more to
// pay. -> { ok, order } or { ok: false, status, errors, ... }
export const editOrder = async (stores, customer, id, body, {
  now = new Date(), group = null, ...options
} = {}) => {
  const order = await getOrder(stores, id);

  if (!order || order.customer.email !== customer.email) {
    return fail(404, { order: "We can't find that order." });
  }
  if (!canChange(order, now)) {
    return fail(409, { order: "This order can't be changed any more." });
  }

  const b = body && typeof body === "object" ? body : {};
  const key = String(b.idempotencyKey || "");

  if (!KEY.test(key)) {
    return fail(422, { idempotencyKey: "Missing submission key." });
  }
  // A retry of an edit already made answers with the record.
  if (editOf(order, key) && editOf(order, key).state === "done") {
    return { ok: true, order: publicOrder(order, now) };
  }

  const plan = await planEdit(stores, order, b, {
    now, index, terms, codes: discountCodes.codes, group,
    validate: validateOrder,
  });

  if (!plan.ok) return plan;

  const payment = b.payment && typeof b.payment === "object" ? b.payment : {};

  if (plan.change.difference > 0) {
    if (!METHODS[payment.method]) {
      return fail(422, { payment: "Choose how to pay." });
    }
    if (payment.method === "venmo") {
      return fail(422, { payment: "Pay the difference by card for now." });
    }
    if (!payment.sourceId) {
      return fail(422, { payment: "Enter your card details." });
    }
  }

  const attempt = Number.isInteger(b.attempt) && b.attempt >= 1
    && b.attempt <= 50 ? b.attempt : 1;

  try {
    const saved = await applyEdit(stores, plan, {
      key, attempt,
      payment: {
        method: String(payment.method || ""),
        sourceId: String(payment.sourceId || ""),
        verificationToken: payment.verificationToken
          ? String(payment.verificationToken)
          : undefined,
      },
    }, { now, ...options });

    log.info({
      event: "order.edited", id, difference: plan.change.difference,
      switched: plan.change.switched,
    });

    return {
      ok: true,
      order: publicOrder(saved, now),
      difference: plan.change.difference,
    };
  } catch (error) {
    if (error && error.declined) {
      return fail(402, {
        payment: SQUARE_DECLINES[error.code]
          || "The payment didn't go through. Try another way to pay.",
      }, { declined: true, code: error.code || null });
    }

    log.error({
      event: "order.edit_failed", id, error: String(error && error.message),
      detail: error && error.detail,
    });
    await alert(stores, "order.edit_failed", {
      id, difference: plan.change.difference,
      error: String(error && error.message),
    }, { env: options.env, mail: options.mail, now });

    return fail(error && error.retryable ? 503 : 502, {
      order: "We couldn't make that change. Nothing was charged; try " +
        "again in a minute.",
    }, { retryable: !!(error && error.retryable) });
  }
};
