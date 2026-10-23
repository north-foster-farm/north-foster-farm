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
import terms from "./terms.mjs";
import discountCodes from "../../../data/discount-codes.json" with {
  type: "json",
};
import { dollars } from "../../../assets/scripts/order/lib/totals.mjs";
import { indexCatalog } from "../../../assets/scripts/order/lib/catalog.mjs";
import { modelled } from "../../../assets/scripts/order/lib/dates.mjs";
import {
  CONTACT, phoneOk, validateOrder,
} from "../../../assets/scripts/order/lib/validate.mjs";
import {
  applyChange, canChange, planChange, publicOrder,
} from "./account.mjs";
import { refundOrder } from "./admin.mjs";
import { attemptKey, CheckoutError, METHODS } from "./checkout.mjs";
import { alert } from "./health.mjs";
import { retry } from "./http.mjs";
import { now as clock } from "./clock.mjs";
import { log } from "./log.mjs";
import { sendMail } from "./mail.mjs";
import { notifyFarm, sendForOrder } from "./payments.mjs";
import { pickupSchedule } from "./pickups.mjs";
import * as paypalApi from "./paypal.mjs";
import { DECLINE_MESSAGES as PAYPAL_DECLINES } from "./paypal.mjs";
import {
  amendOrder, answerQuestion, deleteCheckout, getCheckout, getCustomer,
  getOrder, keptFee, moneyPatch, paidTotal, paymentRef, paymentsOf,
  questionOpen, refundedTotal, refundsOf, saveCheckout,
} from "./records.mjs";
import { mailLinks, orderUrlFor } from "./site.mjs";
import * as squareApi from "./square.mjs";
import { DECLINE_MESSAGES as SQUARE_DECLINES } from "./square.mjs";
import { adjust, checkLines } from "./stock.mjs";
import { farmOrderChanged, orderChanged } from "./templates.mjs";

const index = indexCatalog(catalog);

export const KEY = /^[A-Za-z0-9-]{16,64}$/;

const fail = (status, errors, extra = {}) =>
  ({ ok: false, status, errors, ...extra });

// The record as a payload, so a partial one from the page validates as
// a whole order. The name and email are the record's: an edit never
// moves an order to another person. The phone and the text-or-call can
// change (delivery needs a phone).
export const payloadFor = (order, body = {}) => {
  const c = body.customer && typeof body.customer === "object"
    ? body.customer
    : {};
  const f = modelled(terms, order.fulfilment);
  const next = body.fulfilment && typeof body.fulfilment === "object"
    ? body.fulfilment
    : {};
  const method = next.method || f.method;
  const same = method === f.method;
  const old = (key) => (same && f[key]) || {};
  const to = next.onfarm || {};
  const was = old("onfarm");
  // A legacy `confirmed` range belongs to the window it was set for.
  const moved = (to.window && to.window !== was.window)
    || (next.date && next.date !== f.date);
  const kept = { ...was, confirmed: undefined };

  return {
    customer: {
      ...order.customer,
      firstName: order.customer.firstName
        || order.customer.name.split(/\s+/)[0],
      lastName: order.customer.lastName
        || order.customer.name.split(/\s+/).slice(1).join(" "),
      phone: c.phone || order.customer.phone,
      contact: c.contact || order.customer.contact,
    },
    fulfilment: {
      method,
      date: next.date || (same && !next.occurrence ? f.date : null),
      ...(next.site) && { site: next.site },
      ...(next.occurrence || (same && f.occurrence)) && {
        occurrence: next.occurrence || f.occurrence,
      },
      onfarm: { ...(moved ? kept : was), ...to },
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

// What of that counts toward the order as it becomes: a fee a missed
// delivery kept paid for that trip, not this one (#193). So a switch
// to pickup refunds nothing of it, and a delivery on another day
// charges the fee again after the customer's miss (C1).
export const creditOn = (order) => heldOn(order) - keptFee(order);

// Validated, priced and checked, before any money: the new order, and
// the change against the record. `hold` prices the lines the order
// already has at the prices it was placed at, so a catalog price that
// moved since shows no difference (the farm's change, #307). -> { ok,
// order, next, change } or a failure shaped like the order endpoint's.
export const planEdit = async (stores, order, body, {
  now, index, terms, codes, group, validate, schedule, env, hold = false,
  farm = false,
}) => {
  if (hold) {
    index = new Map(index);
    for (const l of order.lines) {
      if (index.has(l.sku)) {
        index.set(l.sku, { ...index.get(l.sku), price: l.unitPrice });
      }
    }
  }

  // An order placed with a pass (#182) keeps its waiver through every
  // change, the fee's too if the pass waives it; the pass is already
  // used up by this order.
  const result = validate(payloadFor(order, body), {
    index, terms, now, group, codes, schedule, placed: order.submittedAt,
    farm,
    kept: modelled(terms, order.fulfilment).occurrence || null,
    held: Object.fromEntries(order.lines.map((l) => [l.sku, l.qty])),
    waive: {
      minimum: !!order.pass,
      fee: !!order.passWaivesFee,
    },
  });

  if (!result.ok) {
    return fail(result.status, result.errors, { dates: result.dates });
  }

  const next = result.order;
  const change = diffLines(order.lines, next.lines);
  // Square's inventory is read only for what the change adds.
  const stock = change.added.length
    ? await checkLines(stores, change.added, { env, check: "edit" })
    : { ok: true, errors: {}, items: {} };

  if (!stock.ok) return fail(422, stock.errors, { stock: stock.items });
  if (next.flags.totalMismatch) {
    return fail(422, {
      total: "The total changed while you were on this page. Check it " +
        "and try again.",
    }, { totals: next.totals });
  }

  const switched = next.fulfilment.method !== order.fulfilment.method
    || (next.fulfilment.site || null) !== (order.fulfilment.site || null);

  change.difference = next.totals.total - creditOn(order);
  change.switched = switched;
  // A switch needs a Square order to carry the new fulfilment, even
  // when there is nothing to pay.
  change.carries = switched;

  // The farm can move the address alone; a pickup has none.
  const there = (o) => ["address1", "address2", "town", "zip"]
    .map((k) => (o.fulfilment.delivery || {})[k] || "").join("|");
  const moved = next.fulfilment.method === "delivery"
    && there(next) !== there(order);

  if (!change.delta.length && !switched && change.difference === 0
    && !moved && next.fulfilment.date === order.fulfilment.date) {
    return fail(422, { order: "Nothing has changed." });
  }

  return { ok: true, order, next, change };
};

// The record as it becomes. Every way is booked as it stands (W11d):
// the validator already held a new pickup time to the schedule.
const changedRecord = (order, next, change, key, now, by = "customer") => {
  const f = next.fulfilment;
  const was = order.fulfilment;
  const moved = f.method === "onfarm" && (change.switched
    || f.date !== was.date
    || (f.onfarm || {}).window !== (was.onfarm || {}).window);
  const fulfilment = { ...f, state: "agreed",
    agreedAt: moved ? null : was.agreedAt || null };
  // Another day or another way answers what the farm asked (a missed
  // delivery, #193).
  const answered = change.switched || f.date !== was.date || moved;

  return {
    ...answered && questionOpen(order) && {
      question: answerQuestion(order,
        change.switched ? "switch" : "reschedule", by, now),
    },
    customer: { ...order.customer, phone: next.customer.phone,
      contact: next.customer.contact },
    lines: next.lines,
    totals: next.totals,
    code: next.code,
    flags: { ...(order.flags || {}), zipUnlisted: next.flags.zipUnlisted },
    fulfilment,
    edits: [...(order.edits || []), {
      key, at: now.toISOString(), state: "pending", by,
      difference: change.difference, switched: change.switched,
      before: {
        lines: order.lines, totals: order.totals, method: was.method,
        site: was.site, occurrence: was.occurrence, date: was.date,
      },
    }],
  };
};

const editOf = (order, key) => (order.edits || []).find((e) => e.key === key);

// The money of a started edit is in the record (edit.paid writes it
// with the payment), so a retry of its key must never take it again.
const paidFor = (order, key) => Boolean(editOf(order, key))
  && paymentsOf(order).some((p) => p.edit === key);

// The plan of an edit already saved as pending: the record holds the
// change, so a retry by its key only finishes what was left undone.
// `delta` is empty because the record does not keep it: a first run that
// died between edit.started or edit.paid and the stock adjustment leaves
// stock unadjusted, for the farm to fix by hand.
const pendingPlan = (order, edit) => ({
  ok: true, order, next: order, change: {
    difference: edit.difference, delta: [], switched: edit.switched,
    carries: edit.switched,
  },
});

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
// `charge` takes the difference; by default the card or wallet in
// `payment`, and for Venmo the capture (finishEditVenmo). `by` is
// "farm" for a change made from the CLI: the history says so, and the
// farm is not emailed about its own change.
export const applyEdit = async (stores, plan, {
  key, attempt = 1, payment, charge = chargeSquare, by = "customer",
}, {
  square = squareApi, paypal, env = process.env, fetchImpl, sleep,
  mail = sendMail, now = clock(),
} = {}) => {
  const { next, change } = plan;
  const id = plan.order.id;
  const k = attemptKey(key, attempt);
  let order = await getOrder(stores, id);
  const started = editOf(order, key);

  if (started && started.state === "done") return order;

  const patch = started ? {} : changedRecord(order, next, change, key, now, by);
  const after = { ...order, ...patch };
  let changeOrderId = null;

  const paid = Boolean(started) && paidFor(order, key);

  if (paid) {
    // Taken by the first run: carry on from the saved payment.
    const change0 = ((order.square && order.square.changes) || [])
      .filter((c) => c.amount === change.difference).at(-1);

    changeOrderId = change0 ? change0.squareOrderId : null;
  } else if (change.difference > 0) {
    // The money first: a declined card leaves the order as it was.
    const charged = await charge(after, change, k, payment, {
      square, paypal, env, fetchImpl, sleep, mail, now, stores,
    });
    const payments = paymentsOf(order);

    changeOrderId = charged.squareOrderId;
    order = await amendOrder(stores, id, {
      ...patch,
      ...moneyPatch(order, {
        payments: payments.some((p) => paymentRef(p)
          === paymentRef(charged.payment))
          ? payments
          : [...payments, {
            at: now.toISOString(), amount: change.difference, edit: key,
            ...charged.payment,
          }],
      }),
      // A Square copy that failed has no change order to list.
      square: order.square && changeOrderId ? { ...order.square, changes: [
        ...(order.square.changes || [])
          .filter((c) => c.squareOrderId !== changeOrderId),
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
    by === "farm" ? "farm.changed" : "edit.done", now);
  order = await syncFulfilment(stores, order, change, {
    changeOrderId, k, square, env, fetchImpl, mail, now,
  });

  // Keyed by the edit, so a retry or the jobs never send twice.
  const links = mailLinks(env);

  order = await sendForOrder(stores, order, `orderChanged-${key}`,
    orderChanged(order, {
      orderUrl: orderUrlFor(env, id), links, difference: change.difference,
      before: editOf(order, key).before,
    }), { mail, env, now });

  if (by === "farm") return order;

  return notifyFarm(stores, order, `farmOrderChanged-${key}`,
    farmOrderChanged(order, {
      before: editOf(order, key).before, difference: change.difference,
      links,
    }), { mail, env, now });
};

// The difference by Venmo, in the new order's two steps. The first
// keeps the plan as a checkout (records.mjs) with the PayPal order for
// the difference; the second, from the page or from the jobs when the
// page never came back (rescueCheckout), captures it and applies the
// plan it kept, provided the record has not changed since.
export const startEditVenmo = async (stores, plan, { key, attempt = 1 }, {
  paypal = paypalApi, env = process.env, fetchImpl, sleep, now = clock(),
} = {}) => {
  const k = attemptKey(key, attempt);
  const after = { ...plan.order, totals: { ...plan.order.totals,
    total: plan.change.difference } };
  const { paypalOrderId } = await retry(
    () => paypal.createOrder(after, k, { env, fetchImpl, now }), { sleep }
  );

  await saveCheckout(stores, {
    key, attempt, at: now.toISOString(), paypalOrderId,
    order: after,
    edit: {
      id: plan.order.id, next: plan.next, change: plan.change,
      held: heldOn(plan.order),
    },
  });

  return { paypalOrderId };
};

// Captures the approved payment and notes it on a Square change order
// as an external tender, as a new Venmo order's Square copy is. A
// Square failure never loses the money: the payment is recorded
// without its copy and the farm is told.
const captureVenmo = (paypalOrderId) => async (after, change, k, _payment, {
  square, paypal = paypalApi, env, fetchImpl, sleep, mail, now, stores,
}) => {
  const capture = await retry(
    () => paypal.captureOrder(paypalOrderId, k, { env, fetchImpl, now }),
    { sleep }
  );

  if (capture.amount !== null && capture.amount !== change.difference) {
    log.error({
      event: "venmo.amount_mismatch", id: after.id, paypalOrderId,
      captured: capture.amount, total: change.difference,
    });
    await alert(stores, "venmo.amount_mismatch", {
      id: after.id, paypalOrderId, captured: capture.amount,
      total: change.difference,
    }, { env, mail, now });
  }

  let squareOrderId = null;
  let squarePaymentId = null;

  try {
    const created = await retry(() => square.createChangeOrder(
      after, change, k, { env, fetchImpl }
    ), { sleep });
    const paid = await retry(() => square.createPayment({
      order: { ...after, totals: { ...after.totals,
        total: change.difference } },
      squareOrderId: created.squareOrderId,
      customerId: created.customerId,
      key: k,
      source: {
        external: { source: "Venmo", sourceId: capture.paypalCaptureId },
      },
    }, { env, fetchImpl }), { sleep });

    squareOrderId = created.squareOrderId;
    squarePaymentId = paid.squarePaymentId;
  } catch (error) {
    log.error({
      event: "square.record_failed", id: after.id,
      error: String(error && error.message), detail: error && error.detail,
    });
    await alert(stores, "square.record_failed", {
      id: after.id, error: String(error && error.message),
    }, { env, mail, now });
  }

  return {
    squareOrderId,
    payment: {
      via: "venmo", method: "venmo", squarePaymentId, receiptUrl: null,
      paypalOrderId, paypalCaptureId: capture.paypalCaptureId,
      payer: capture.payer,
    },
  };
};

// -> the saved record. throws PayPalError, or a CheckoutError when
// the checkout is unknown or the record moved on since it began.
export const finishEditVenmo = async (stores, {
  id, key, attempt = 1, paypalOrderId,
}, options = {}) => {
  const order = await getOrder(stores, id);
  const checkout = await getCheckout(stores, key, paypalOrderId);
  const begun = editOf(order, key);

  // Finished already, by a lost first try or by the jobs.
  if (paymentsOf(order).some((p) => p.paypalOrderId === paypalOrderId)) {
    if (checkout) await deleteCheckout(stores, key, paypalOrderId);

    return order;
  }
  if (begun && paidFor(order, key)) {
    // Another Venmo payment took this edit's money: finish, charge nothing.
    const saved = await applyEdit(stores, pendingPlan(order, begun), {
      key, attempt,
    }, options);

    if (checkout) await deleteCheckout(stores, key, paypalOrderId);

    return saved;
  }
  if (!checkout || !checkout.edit || checkout.edit.id !== id
    || checkout.paypalOrderId !== paypalOrderId) {
    throw new CheckoutError("That payment doesn't match this change. " +
      "Start again.", { code: "checkout.unknown" });
  }
  if (heldOn(order) !== checkout.edit.held) {
    throw new CheckoutError("The order changed after the Venmo payment " +
      "started. Start the payment again.", { code: "checkout.changed" });
  }

  const saved = await applyEdit(stores, {
    order, next: checkout.edit.next, change: checkout.edit.change,
  }, {
    key, attempt: checkout.attempt || attempt,
    charge: captureVenmo(paypalOrderId),
  }, options);

  await deleteCheckout(stores, key, paypalOrderId);

  return saved;
};

// POST /api/account/orders/:id/edit, for the signed-in owner, until
// the cutoff. The body is the order as it should now be (any part of
// it; the rest comes from the record), plus `claimedTotal`,
// `idempotencyKey`, `attempt`, and `payment` when there is more to
// pay. -> { ok, order } or { ok: false, status, errors, ... }
export const editOrder = async (stores, customer, id, body, {
  now = clock(), group = null, ...options
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

  const payment = b.payment && typeof b.payment === "object" ? b.payment : {};
  const attempt = Number.isInteger(b.attempt) && b.attempt >= 1
    && b.attempt <= 50 ? b.attempt : 1;
  const opts = { now, ...options };
  const done = (saved, difference) => {
    log.info({ event: "order.edited", id, difference });

    return { ok: true, order: publicOrder(saved, now), difference };
  };

  // Venmo's second step applies the plan its first step kept.
  if (payment.method === "venmo" && payment.stage === "capture") {
    return guarded(stores, id, opts, async () => {
      const saved = await finishEditVenmo(stores, {
        id, key, attempt, paypalOrderId: String(payment.paypalOrderId || ""),
      }, opts);

      return done(saved, (paymentsOf(saved).at(-1) || {}).amount || 0);
    });
  }

  const started = editOf(order, key);
  const plan = started ? pendingPlan(order, started)
    : await planEdit(stores, order, b, {
      now, index, terms, codes: discountCodes.codes, group,
      validate: validateOrder, schedule: pickupSchedule(options.env),
      env: options.env,
    });

  if (!plan.ok) return plan;

  const { difference } = plan.change;

  if (difference > 0 && !paidFor(order, key)) {
    if (!METHODS[payment.method]) {
      return fail(422, { payment: "Choose how to pay." });
    }
    if (payment.method === "venmo") {
      if (payment.stage !== "create") {
        return fail(422, { payment: "Which Venmo step?" });
      }

      return guarded(stores, id, opts, async () => ({
        ok: true, difference,
        ...(await startEditVenmo(stores, plan, { key, attempt }, opts)),
      }));
    }
    if (!payment.sourceId) {
      return fail(422, { payment: "Enter your card details." });
    }
  }

  return guarded(stores, id, opts, async () => done(
    await applyEdit(stores, plan, {
      key, attempt,
      payment: {
        method: String(payment.method || ""),
        sourceId: String(payment.sourceId || ""),
        verificationToken: payment.verificationToken
          ? String(payment.verificationToken)
          : undefined,
      },
    }, opts),
    difference,
  ));
};

// The farm changes a paid order for the customer, from the CLI (#306),
// past the cutoff and by the same rules and messages as the customer's
// own change. The farm can also change the way the order is received
// (`fulfilment.method`) and the address, which the page cannot. A
// change of method or address goes through planEdit and applyEdit like
// the customer's edit; the rest (date, pickup time, drop-off details,
// notes) through planChange and applyChange like their quick change.
// The order keeps its own prices (`hold`), so only a change of items,
// which the CLI cannot make, or a fee of the new way can cost anything.
// The CLI moves no money: a change that costs or credits anything is
// refused. `body` is `{ fulfilment, customer, notes }`, as the edit
// takes it; `customer` may carry the phone and the text-or-call alone,
// or beside another change, but notes only alone or with a date, time
// or drop-off detail. `dryRun` plans and renders the email; nothing is
// saved or sent. `onKey` hears the idempotency key before anything is
// applied, so a retry after a crash can pass it back as `key`: a key
// whose edit is already done returns success and applies nothing of
// the new body. -> { ok, order, key?, outOfSync, email? } or
// { ok: false, status, errors }
export const farmEdit = async (stores, id, body, {
  now = clock(), env = process.env, mail = sendMail, square = squareApi,
  paypal, fetchImpl, sleep, key, dryRun = false, onKey,
} = {}) => {
  const order = await getOrder(stores, id);

  if (!order) return fail(404, { order: `We can't find order ${id}.` });
  if (order.status !== "paid" || order.cancelRequested) {
    return fail(409, { order: "This order can't be changed any more." });
  }
  if (!order.lines.every((l) => index.has(l.sku))) {
    return fail(409, { order: "This order holds an item the catalog no " +
      "longer has, so it can't be changed." });
  }

  const b = body && typeof body === "object" ? body : {};
  const f = b.fulfilment || {};
  const d = f.delivery || {};
  const links = mailLinks(env);
  const orderUrl = orderUrlFor(env, id);
  const structural = (f.method && f.method !== order.fulfilment.method)
    || (f.site !== undefined && f.site !== order.fulfilment.site)
    || ["address1", "address2", "town", "zip"].some((k) => d[k] !== undefined);
  // A flag the change itself set, for the CLI to say.
  const outOfSync = (after) => !!(after.flags || {}).squareOutOfSync
    && !(order.flags || {}).squareOutOfSync;
  const c = b.customer || {};
  const phone = c.phone !== undefined ? String(c.phone).trim() : undefined;
  const contact = c.contact !== undefined ? String(c.contact).trim()
    : undefined;

  if (!structural) {
    const plan = planChange(order, {
      date: f.date, onfarm: f.onfarm, delivery: d, notes: b.notes,
    }, { now, env, by: "farm" });

    const errors = { ...plan.errors };

    if (phone !== undefined && !phoneOk(phone)) {
      errors["customer.phone"] = "That phone number doesn't look right.";
    }
    if (contact !== undefined && !CONTACT.includes(contact)) {
      errors["customer.contact"] = "Text or call?";
    }
    if (Object.keys(errors).length) return fail(422, errors);
    if (phone !== undefined || contact !== undefined) {
      plan.patch = { ...plan.patch, customer: { ...order.customer,
        ...phone !== undefined && { phone },
        ...contact !== undefined && { contact } } };
    }
    if (dryRun) {
      const after = { ...order, ...plan.patch };

      return { ok: true, dryRun: true, order: after,
        email: orderChanged(after, { orderUrl, links }) };
    }

    const done = await applyChange(stores, order, plan, {
      now, env, mail, square, by: "farm",
    });

    return { ok: true, order: done, outOfSync: outOfSync(done) };
  }

  if (b.notes !== undefined) {
    return fail(422, { notes: "A change of method or address can't carry " +
      "the notes. Change them in a command of their own." });
  }

  const started = key && editOf(order, key);

  if (started && started.state === "done") {
    return { ok: true, order, key, outOfSync: false };
  }
  if (started) {
    if (dryRun) return { ok: true, dryRun: true, order, key };
    if (onKey) onKey(key);

    const finished = await applyEdit(stores, pendingPlan(order, started), {
      key, by: "farm", payment: {},
    }, { square, paypal, env, fetchImpl, sleep, mail, now });

    return { ok: true, order: finished, key, outOfSync: outOfSync(finished) };
  }

  const cust = await getCustomer(stores, order.customer.email);
  const plan = async (claimedTotal) => planEdit(stores, order,
    { ...b, claimedTotal }, {
      now, index, terms, codes: discountCodes.codes, hold: true,
      group: (cust && cust.discountGroup) || null, validate: validateOrder,
      schedule: pickupSchedule(env), env, farm: true,
    });
  let planned = await plan(undefined);

  // The page learns the total from the same code, then sends it back.
  if (!planned.ok && planned.errors.total && planned.totals) {
    planned = await plan(planned.totals.total);
  }
  if (!planned.ok) return planned;

  const { difference } = planned.change;

  if (difference !== 0) {
    return fail(422, { payment: difference > 0
      ? `This change adds ${dollars(difference)}, which only the customer ` +
        "can pay, on their order page."
      : `This change takes ${dollars(-difference)} off the order. The ` +
        "CLI moves no money: make the change on the order page, or " +
        "refund it by hand and run this again." });
  }

  const k = key || `farm-${id}-${now.getTime()}`;

  if (!KEY.test(k)) return fail(422, { key: "That key doesn't look right." });
  if (onKey) onKey(k);
  if (dryRun) {
    const after = { ...order, ...changedRecord(order, planned.next,
      planned.change, k, now, "farm") };

    return { ok: true, dryRun: true, order: after,
      email: orderChanged(after, {
        orderUrl, links, difference: 0, before: after.edits.at(-1).before,
      }) };
  }

  const done = await applyEdit(stores, planned, {
    key: k, by: "farm", payment: {},
  }, { square, paypal, env, fetchImpl, sleep, mail, now });

  return { ok: true, order: done, key: k, outOfSync: outOfSync(done) };
};

// A processor's failure as the page reads it, as the order endpoint
// answers: 402 a decline, 409 a checkout that no longer fits, 503 try
// again, 502 not.
const guarded = async (stores, id, { env, mail, now }, run) => {
  try {
    return await run();
  } catch (error) {
    if (error && error.declined) {
      return fail(402, {
        payment: SQUARE_DECLINES[error.code] || PAYPAL_DECLINES[error.code]
          || "The payment didn't go through. Try another way to pay.",
      }, { declined: true, code: error.code || null });
    }
    if (error && error.name === "CheckoutError") {
      return fail(409, { payment: error.message }, { code: error.code });
    }

    log.error({
      event: "order.edit_failed", id, error: String(error && error.message),
      detail: error && error.detail,
    });
    await alert(stores, "order.edit_failed", {
      id, error: String(error && error.message),
    }, { env, mail, now });

    return fail(error && error.retryable ? 503 : 502, {
      order: "We couldn't make that change. Try again in a minute.",
    }, { retryable: !!(error && error.retryable) });
  }
};

