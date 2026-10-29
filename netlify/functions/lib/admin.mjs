// What the farm does from the CLI: decide addresses, set pricing
// groups, close and cancel orders, settle returns, count stock. The
// same records and rules as the customer-facing functions, with the
// farm's authority. bin/nff is the thin front.

import terms from "../../../data/delivery.json" with { type: "json" };
import { dollars } from "../../../assets/scripts/order/lib/totals.mjs";
import {
  addDays, today, weekday,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import {
  adjust, getCounts, hiddenCounts, hiddenInStock, setCount,
} from "./stock.mjs";
import { normalizeEmail, validEmail } from "./auth.mjs";
import { deleteAuth, putAuth } from "./auth-records.mjs";
import { company } from "./company.mjs";
import { DELIVERING } from "./health.mjs";
import { completeInSquare } from "./complete.mjs";
import { restoreCredit } from "./credit.mjs";
import { audit, noteJoin } from "./group-log.mjs";
import { GROUPS, groupOf, memberKeyOf } from "./groups.mjs";
import { log } from "./log.mjs";
import { devEmails, sendMail } from "./mail.mjs";
import { maskEmail, maskIn } from "./mask.mjs";
import * as newsApi from "./news.mjs";
import {
  customerEmailWithheld, recordRefund, sendForOrder,
} from "./payments.mjs";
import * as paypalApi from "./paypal.mjs";
import {
  OPEN, allCustomers, allOrders, amendOrder, answerQuestion, byEmailKey,
  cartKey, deleteCustomer, deleteOrder, dueOn, getCustomer, getOrder, keptFee,
  listCheckouts, ordersFor, paidByHand, paidTotal, paymentRef, paymentsOf,
  questionOpen, refundedTotal, saveCustomer, setStatus, settledRefunds,
} from "./records.mjs";
import { paymentPending } from "./farm-orders.mjs";
import { mailLinks, orderUrlFor } from "./site.mjs";
import * as squareApi from "./square.mjs";
import {
  addressDecision, age, devMailTest as devMailTestMessage, missedDelivery,
  movedDelivery, orderCancelled, orderChanged, sessionsEnded,
} from "./templates.mjs";
import { lastInteraction, quietDue } from "./retention.mjs";
import siteTerms from "./terms.mjs";
import {
  isScheduled, orderOccurrence,
} from "../../../assets/scripts/order/lib/dates.mjs";

import { forgetCustomer } from "./forget.mjs";

export { forgetCustomer };

// Quiet accounts due their notice (#189, lib/retention.mjs), for
// `bin/nff customers quiet`. Read only: the daily jobs act on them.
export const quietCustomers = async (stores, now = new Date()) =>
  (await allCustomers(stores)).filter((c) => quietDue(c, now))
    .map((c) => ({
      email: c.email,
      lastInteraction: lastInteraction(c),
      onFarmNews: c.marketing === true,
    }));

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
  // A buying group (#471): `member=vff` joins, `member=none` leaves.
  if (patch.member !== undefined) {
    const key = patch.member === "none" || !patch.member ? null : patch.member;

    if (key && !groupOf(key)) {
      throw new Error(`Unknown group "${key}". Known: ${
        GROUPS.map((g) => g.key).join(", ")}.`);
    }
    next.memberGroup = key
      ? (memberKeyOf(next) === key ? next.memberGroup
        : { id: key, joinedAt: new Date().toISOString(), via: "farm" })
      : null;
  }

  const saved = await saveCustomer(stores, next);

  // A membership the farm moved is in each group's audit log, and a
  // join in the new group's join log (#495).
  const was = memberKeyOf(customer);
  const is = memberKeyOf(next);

  if (was !== is) {
    const at = new Date();
    const by = { role: "farm" };

    if (was) {
      await audit(stores, { group: was, by, action: "member.remove",
        target: customer.email, before: { group: was },
        after: { group: is }, now: at });
    }
    if (is) {
      await audit(stores, { group: is, by, action: "member.add",
        target: customer.email, before: { group: was },
        after: { group: is }, now: at });
      await noteJoin(stores, { group: is, email: customer.email,
        via: "farm", now: new Date(next.memberGroup.joinedAt) });
    }
  }

  return saved;
};

const NAME_MAX = 60;

// A customer's first and last name (#496), on the record and on the
// Resend contact: the welcome and Resend use firstName and lastName,
// and `audience sync` never changes a contact's name. A name not given
// stays as it was, and `name` follows the two. The log line names the
// address masked and which fields changed, not the names. `contacts`
// is the audience, when the caller has listed it. With `dryRun`
// nothing is written and Resend is only read. -> the report.
export const setNames = async (stores, email, { first, last }, {
  by = null, dryRun = false, env = process.env, fetchImpl = globalThis.fetch,
  news = newsApi, contacts = null,
} = {}) => {
  const customer = need(await getCustomer(stores, email), "customer");
  const given = (value, had) => (value === undefined ? had || ""
    : String(value).trim().slice(0, NAME_MAX));
  const firstName = given(first, customer.firstName);
  const lastName = given(last, customer.lastName);
  const name = [firstName, lastName].filter(Boolean).join(" ");
  const changed = Object.entries({ firstName, lastName, name })
    .filter(([key, value]) => (customer[key] || "") !== value)
    .map(([key]) => key);
  const report = {
    dryRun, record: maskEmail(customer.email), firstName, lastName, name,
    changed,
  };

  if (!dryRun && changed.length) {
    await saveCustomer(stores, { ...customer, firstName, lastName, name });
  }
  try {
    report.resend = await news.renameContact(customer.email,
      { firstName, lastName }, { env, fetchImpl, apply: !dryRun, contacts });
  } catch (error) {
    report.resend = maskIn(`not reached: ${error.message}`, customer.email);
  }
  if (!dryRun) {
    log.info({
      event: "customer.renamed", outcome: changed.length ? "renamed"
        : "unchanged", by, record: report.record, changed,
      resend: report.resend,
    });
  }

  return report;
};

const APPLY_PACE = 1100;
// Why forgetCustomer waited, for the farm (its WAIT is the customer's).
const HELD_BY = {
  open: "an order is in progress",
  return: "a return is open",
  checkout: "a Venmo payment is under way",
  square: "Square could not be reached",
};
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

// `bin/nff audience apply <csv>` (#496): a cleanup of the imported
// list, one row each of action,email,first,last. A `keep` row sets the
// names as given (setNames): an empty cell sets that name blank, as a
// blank or initial last name and an empty first name are all valid on
// the list (James, comment 6453653919).
// A `remove` row goes the way of `customers forget --apply`: the record
// and everything else that names the address, its orders kept but
// re-pointed to the deleted household, and the Resend contact. A row
// that fails is reported and the rest go on. Rows are paced for
// Resend's rate limit. The report names every address masked. With
// `dryRun` nothing is written. -> { dryRun, rows, counts }.
export const applyAudience = async (stores, rows, {
  by = null, dryRun = false, env = process.env, fetchImpl = globalThis.fetch,
  news = newsApi, square = squareApi, now = new Date(), pace = APPLY_PACE,
} = {}) => {
  const outside = news.audienceConfigured(env);
  const contacts = outside && rows.some((r) => r.action === "keep")
    ? await news.listContacts(env, fetchImpl) : null;
  const done = [];

  for (const [i, row] of rows.entries()) {
    const email = normalizeEmail(row.email);
    const entry = {
      action: row.action || "", record: maskEmail(email), outcome: null,
    };

    if (outside && pace && i) await pause(pace);
    try {
      if (!validEmail(email)) {
        entry.outcome = "not an email address";
      } else if (entry.action === "keep") {
        if (!await getCustomer(stores, email)) {
          entry.outcome = "no record";
        } else {
          const r = await setNames(stores, email, {
            first: row.firstName, last: row.lastName,
          }, { by, dryRun, env, fetchImpl, news, contacts });

          entry.outcome = r.changed.length ? "names set" : "names as given";
          entry.resend = r.resend;
        }
      } else if (entry.action === "remove") {
        const r = await forgetCustomer(stores, email, {
          apply: !dryRun, env, fetchImpl, news, square, now, by,
        });

        entry.outcome = !r.ok ? `not removed: ${HELD_BY[r.wait] || r.wait}`
          : r.customer ? "removed" : "no record, the rest removed";
        if (r.ok) {
          entry.orders = r.orders.length;
          entry.resend = maskIn(r.resend, email);
        }
      } else {
        entry.outcome = "action is not keep or remove";
      }
    } catch (error) {
      entry.outcome = `failed: ${maskIn(error.message, email)}`;
    }
    done.push(entry);
  }

  const counts = {};

  for (const { outcome } of done) {
    const key = outcome.split(":")[0];

    counts[key] = (counts[key] || 0) + 1;
  }
  if (!dryRun) log.info({ event: "audience.applied", by, counts });

  return { dryRun, rows: done, counts };
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
      const forOld = value && (normalizeEmail(value.email) === old
        || (value.changeFrom && normalizeEmail(value.changeFrom) === old));

      if (forOld) auth.push({ key, value });
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
      await deleteAuth(stores, key, value);
    } else {
      await putAuth(stores, key, { ...value, email: next }, {
        before: value,
      });
    }
  }
  // The address's email-change limit follows it (#240).
  const spent = await stores.auth.get(`change-rate/${old}`);

  if (spent) {
    await stores.auth.set(`change-rate/${next}`, spent);
    await stores.auth.delete(`change-rate/${old}`);
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

// One log line per deletion, with `by`, who ran it, and the address
// masked (mask.mjs, #496).
export const removeCustomer = async (stores, email, { by = null } = {}) => {
  need(await getCustomer(stores, email), "customer");
  await deleteCustomer(stores, email);
  log.info({
    event: "customer.deleted", outcome: "deleted", by,
    record: maskEmail(normalizeEmail(email)),
  });

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
    if (customerEmailWithheld()) return saved;

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

// The occurrences that stored orders name (in their fulfilment, and in
// the history of a move), and the orders that name one no data file
// defines any more (a series is archived, never deleted). Read only;
// the build cannot read this store (a site-wide store answers 401 from
// a build, docs/monitoring.md), so this is the check of real
// references. -> { occurrences: { id: count }, missing: [{ id, occurrence }] }
export const occurrenceUse = async (stores) => {
  const occurrences = {};
  const missing = [];

  for (const o of await allOrders(stores)) {
    const f = o.fulfilment || {};

    if (!isScheduled(f)) continue;

    const here = orderOccurrence(siteTerms, f);
    const id = here ? here.id : f.occurrence || f.site || f.method;

    occurrences[id] = (occurrences[id] || 0) + 1;
    if (!here) missing.push({ id: o.id, occurrence: id });

    for (const e of (o.history || [])) {
      for (const named of [e.from, e.to]) {
        if (e.event === "fulfilment.moved" && named
          && !orderOccurrence(siteTerms, {
            method: "scheduled", occurrence: named,
          })) {
          missing.push({ id: o.id, occurrence: named });
        }
      }
    }
  }

  return { occurrences, missing };
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

    if (p.via === "credit") {
      // A member's credit (#471) goes back on the ledger it came
      // from, first (it is the newest payment), and the record says
      // so. Nothing is asked of Square or PayPal.
      const { restored } = await restoreCredit(stores,
        order.creditFrom || order.customer.email,
        { orderId: id, amount: take, now });

      refund = { status: "COMPLETED", via: "credit", restored };
    } else if (paidByHand(p)) {
      // Money the farm took by hand (#181): Square holds a note of it,
      // not the money, so the farm hands it back itself and the record
      // says so. Nothing is asked of Square or PayPal.
      refund = { status: "COMPLETED", byHand: true };
    } else if (p.via === "venmo" && p.paypalCaptureId) {
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
    }, source, now, { env });
    owed -= take;
  }

  return saved;
};

// A cancel, the farm's or the customer's: any status but fulfilled,
// which it refuses.
// Stock goes back, the fulfillment is cancelled in Square, the money
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
  // Handed over: what goes back now is a refund or a return, not a
  // cancel.
  if (order.status === "fulfilled") {
    throw new Error("This order is fulfilled. Refund it instead.");
  }
  // An unpaid order being paid this minute (#181): money must never
  // land on an order being cancelled.
  if (order.status === "unpaid" && await paymentPending(stores, id, now)) {
    throw new Error("A payment is under way; try again in a minute.");
  }

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

  // Lost to a close (the jobs' or the farm's): the order was handed
  // over, so nothing of a cancel follows, not Square, stock or email.
  if (!cancelled || cancelled.status !== "cancelled") {
    throw new Error(`This order became ${cancelled
      ? cancelled.status : "unknown"} while it was being cancelled${
      refundNow ? ", after its refund was made, so check it with " +
        "bin/nff orders show" : ""}.`);
  }

  if (!order.cancelRequested) await adjust(stores, order.lines, 1);

  if (order.square && order.square.squareOrderId) {
    try {
      await square.cancelFulfillment(order.square.squareOrderId, {
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
        by: ["customer", "hold"].includes(source) ? source : "farm",
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
// about where we couldn't get to (no-access). Marking the same
// delivery twice keeps the first. A day the customer rescheduled to,
// missed in its turn, is marked again: the fee kept before stays kept
// (`fee` adds up), and the customer is asked and told afresh.
//
// A customer's miss, waived or not, asks them what to do (F2): the
// order holds a `missed` question until they reschedule, switch or
// cancel, or until the hold runs out (C8, `until`), and the
// missed-delivery email says so. Marking again, once that email has
// failed, sends it again. The jobs close a delivery the day after, so
// a miss marked up to MARK_LATE_DAYS late reopens the order first.
// -> the order.
export const markAttempted = async (stores, id, {
  cause, waive = "", detail = "", now = new Date(), env = process.env,
  mail = sendMail, square = squareApi, fetchImpl,
} = {}) => {
  let order = need(await getOrder(stores, id), "order");

  // The same delivery marked again is a retry. A miss of its own is a
  // later day than the one marked, already come: a rescheduled day
  // missed in its turn. A record from before `attempted.date`, or a
  // weather miss moved to a day still ahead, is the same delivery.
  const prior = order.attempted;
  const again = prior && !(prior.date
    && order.fulfilment.date > prior.date
    && order.fulfilment.date <= today(now, terms.timeZone));

  if (again) {
    return missedUntold(order)
      ? tellMissed(stores, order, { now, env, mail })
      : order;
  }
  if (!ATTEMPT_CAUSES.includes(cause)) {
    throw new Error(`Why did the delivery fail? One of: ${
      ATTEMPT_CAUSES.join(", ")}.`);
  }
  if (order.fulfilment.method !== "delivery") {
    throw new Error("Only a delivery can be attempted.");
  }
  if (closedLately(order, now)) {
    order = await amendOrder(stores, id, {
      status: dueOn(order) > 0 ? "unpaid" : "paid", fulfilledAt: undefined,
    }, "reopened", now);
  }
  if (!OPEN.includes(order.status)) {
    throw new Error(`This order is ${order.status}.`);
  }

  const note = waive.trim();
  const theirs = CUSTOMER_CAUSES.includes(cause);
  const waived = !theirs || !!note;
  const marked = await amendOrder(stores, id, (fresh) => ({
    attempted: {
      at: now.toISOString(),
      date: order.fulfilment.date,
      cause,
      fee: keptFee(order) + (waived ? 0 : order.totals.deliveryFee || 0),
      waived,
      note,
      detail: detail.trim(),
    },
    ...theirs && {
      emails: { ...fresh.emails, missedDelivery: undefined },
      question: {
        kind: "missed", reason: "", openedAt: now.toISOString(),
        until: addDays(order.fulfilment.date, terms.delivery.holdDays),
        answeredAt: null, answer: null, by: null,
      },
    },
  }), "delivery.attempted", now);

  // Ours or the weather's: moved to the next delivery day, no fee, no
  // question (C7).
  if (!theirs) {
    return moveDelivery(stores, id, nextDeliveryDay(order.fulfilment.date),
      { now, env, mail, square, fetchImpl, email: "movedDelivery" });
  }

  return tellMissed(stores, marked, { now, env, mail });
};

// How many days after a delivery its miss can still be marked, though
// the jobs have closed it.
export const MARK_LATE_DAYS = 2;

const closedLately = (order, now) => order.status === "fulfilled"
  && [...order.history || []].reverse()
    .find((h) => h.event === "fulfilled")?.source === "jobs"
  && today(now, terms.timeZone)
    <= addDays(order.fulfilment.date, MARK_LATE_DAYS);

// A missed delivery whose email never went out: the customer doesn't
// know it is held.
export const missedUntold = (order) => OPEN.includes(order.status)
  && questionOpen(order) && order.question.kind === "missed"
  && !(order.emails && order.emails.missedDelivery);

// Tells the customer their delivery was missed and how long it is
// held. The hold runs at least `holdDays` from the day they are told,
// never from a day they didn't know about. A send that fails leaves
// the order untold, so the hold does not run, and the jobs try again
// each run.
export const tellMissed = async (stores, order, {
  now = new Date(), env = process.env, mail = sendMail,
} = {}) => {
  const from = addDays(today(now, terms.timeZone), terms.delivery.holdDays);
  const until = order.question.until > from ? order.question.until : from;

  // The record holds the day the email names before the email goes, so
  // a crash between the two can't leave a hold shorter than promised.
  const held = until === order.question.until ? order
    : await amendOrder(stores, order.id, {
      question: { ...order.question, until },
    }, "question.held", now);

  return sendForOrder(stores, held, "missedDelivery",
    missedDelivery(held, {
      pickUrl: orderUrlFor(env, order.id), links: mailLinks(env), now,
    }), {
      mail, env, now,
      idempotencyKey: `${order.id}-missedDelivery-${order.attempted.date}`,
    });
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
// cutoff: the record, Square's fulfillment, and the customer told.
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
  if (!OPEN.includes(order.status)) {
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
      await square.updateFulfillment(holder, moved, { env, fetchImpl });
    } catch (error) {
      console.error(`Square could not follow the move: ${error.message}`);
      saved = await amendOrder(stores, id, (f) => ({
        flags: { ...(f.flags || {}), squareOutOfSync: true },
      }), "square.out_of_sync", now);
    }
  }

  const links = mailLinks(env);
  const orderUrl = orderUrlFor(env, id);
  const message = email === "movedDelivery"
    ? movedDelivery(saved, { pickUrl: orderUrl, links, now })
    : orderChanged(saved, { orderUrl, links });

  return sendForOrder(stores, saved, `${email}-${date}`, message,
    { mail, env, now });
};

// The record first, then Square (#328): the order and its fulfillment
// are completed there. A Square that cannot follow flags the record and
// tells the farm; the status change stands either way.
export const fulfillOrder = async (stores, id, {
  now = new Date(), env = process.env, mail = sendMail, square = squareApi,
  fetchImpl,
} = {}) => {
  const order = need(
    await setStatus(stores, id, "fulfilled", now, { source: "farm" }),
    "order"
  );

  // Only a paid order is handed over: a cancelled one is refunded, not
  // completed in Square.
  if (order.status !== "fulfilled") {
    throw new Error(`This order is ${order.status}.`);
  }

  return completeInSquare(stores, order, {
    now, env, mail, square, fetchImpl,
  });
};

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

// Messages

// Every message to the farm, from the contact page (`messages/<id>`)
// and the account page's help form (`support/<email>/<id>`), in one
// shape, oldest first; only the open ones unless `all`. `order` is
// whether the order number is one the writer placed, null when none
// was given or when the help form sent it (it offers only the
// customer's own).
export const listMessages = async (stores, { all = false } = {}) => {
  const found = [];

  for (const { key } of await stores.customers.list("messages/")) {
    const m = await stores.customers.get(key);

    if (m) {
      found.push({
        id: m.id, from: "contact", at: m.at, status: m.status,
        name: m.name, email: m.email, orderId: m.orderId || "",
        order: m.order ?? null, subject: "", message: m.message,
        answeredAt: m.answeredAt || null, key,
      });
    }
  }
  for (const { key } of await stores.customers.list("support/")) {
    const m = await stores.customers.get(key);

    if (m) {
      const email = key.slice("support/".length, key.lastIndexOf("/"));
      const customer = await getCustomer(stores, email);

      found.push({
        id: m.id, from: "help", at: m.at, status: m.status,
        name: (customer && customer.name) || "", email,
        orderId: m.orderId || "", order: null, subject: m.subject || "",
        message: m.message, answeredAt: m.answeredAt || null, key,
      });
    }
  }

  return found.filter((m) => all || m.status === "open")
    .sort((a, b) => (a.at < b.at ? -1 : 1));
};

// Marks one message answered, so the morning report stops listing it.
// Marking twice keeps the first. -> the message.
// A writer's text, safe to print on the farm's terminal: no control
// characters (escape sequences, carriage returns) and no bidirectional
// overrides, either of which could make a line show something it is
// not (#167, security review).
// eslint-disable-next-line no-control-regex -- matching them is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export const plain = (value) => String(value ?? "").replace(UNSAFE, "");

// One message as `bin/nff messages` prints it: id, age, form, writer,
// order, and the first 70 characters, every field made plain.
export const messageLine = (m, now = new Date()) => {
  const order = m.orderId ? `  order ${plain(m.orderId)}${
    m.order === false ? " (not their order)" : ""}` : "";
  const gist = plain(String(m.subject || m.message || "")
    .replace(/\s+/g, " "));
  const who = m.name ? `${plain(m.name)} <${plain(m.email)}>`
    : plain(m.email);

  return `${plain(m.id)}  ${age(m.at, now).padEnd(15)}${
    plain(m.from).padEnd(9)}${who}${order}${
    m.status === "open" ? "" : `  answered ${m.answeredAt.slice(0, 10)}`
  }\n      ${gist.length > 70 ? `${gist.slice(0, 69)}…` : gist}`;
};

export const answeredLine = (m) => `Answered ${plain(m.id)} from ${
  plain(m.name || m.email)} (${m.answeredAt.slice(0, 16)}).`;

export const answerMessage = async (stores, id, { now = new Date() } = {}) => {
  const all = await listMessages(stores, { all: true });
  const m = need(all.find((x) => x.id === id), "message");

  if (m.status === "answered") return m;

  const record = await stores.customers.get(m.key);
  const answeredAt = now.toISOString();

  await stores.customers.set(m.key, {
    ...record, status: "answered", answeredAt,
  });

  return { ...m, status: "answered", answeredAt };
};

// Stock

// Sessions

// Deletes every session, then tells the developer. Customers sign in
// again by magic link. With `apply` false it only counts.
export const endAllSessions = async (stores, {
  apply = false, by = "bin/nff", env = process.env, mail = sendMail,
  now = new Date(),
} = {}) => {
  const keys = (await stores.auth.list("session/")).map((e) => e.key);

  if (!apply) return { count: keys.length, ended: false };

  for (const key of keys) await deleteAuth(stores, key);

  const to = devEmails(env);

  if (to.length) {
    await mail({
      to,
      idempotencyKey: `sessions-ended-${now.getTime()}`,
      ...sessionsEnded({
        count: keys.length, by, at: now,
        context: env.SITE_CONTEXT || env.CONTEXT || "",
      }),
    }, { env, stores });
  }

  return { count: keys.length, ended: true, notified: to.length > 0 };
};

// `bin/nff mail test-dev`: one real message to DEV_NOTIFICATIONS_EMAIL
// alone (no fallback to the farm's address, which would hide a dev@
// that does not work), sent the way the deploy-failed, alert and
// rotation notices are. Names and counts only, never an address.
// -> { variable, count, driver, delivered, error }
export const devMailTest = async (stores, {
  env = process.env, mail = sendMail, now = new Date(),
} = {}) => {
  const to = devEmails(env);
  const driver = env.MAIL_DRIVER || "log";

  if (!to.length) {
    return {
      variable: "DEV_NOTIFICATIONS_EMAIL", count: 0, driver,
      delivered: false, error: "not set",
    };
  }

  try {
    await mail({
      to,
      idempotencyKey: `dev-mail-test-${now.getTime()}`,
      ...devMailTestMessage({
        at: now, context: env.SITE_CONTEXT || env.CONTEXT || "",
      }),
    }, { env, stores });
  } catch (error) {
    return {
      variable: "DEV_NOTIFICATIONS_EMAIL", count: to.length, driver,
      delivered: false, error: error.status
        ? `the mail service answered ${error.status}`
        : "the send was refused",
    };
  }

  return {
    variable: "DEV_NOTIFICATIONS_EMAIL", count: to.length, driver,
    delivered: DELIVERING.includes(driver), error: null,
  };
};

export const stockList = (stores) => getCounts(stores);

export const stockSet = (stores, sku, value) =>
  setCount(stores, sku, value === "none" ? null : Number(value));

// `stock hidden` (#499): every tier the order page keeps off whatever
// its count, archived or `inStock: false`, with Square's count, read
// only. -> { list, inStock }, inStock those above 0, the ones the jobs
// alert on. Throws when Square can't be read, so the command never
// passes on counts it didn't see. `inventory` and `catalogIndex` are
// for tests.
export const stockHidden = async (opts = {}) => {
  const list = await hiddenCounts(opts);

  if (!list) {
    throw new Error("Square's counts could not be read: it didn't answer, " +
      "or this environment has no production catalog to ask (try " +
      "--production).");
  }

  return { list, inStock: hiddenInStock(list) };
};

// One line of `stock hidden`: "IN STOCK  SKU  archived  3  name".
export const hiddenLine = (i) => `${i.count > 0 ? "IN STOCK" : "ok      "}  ${
  i.sku}  ${i.why}  ${i.count === null ? "not counted" : i.count}  ${
  i.name}`;
