// What a signed-in customer can do: read their orders, cancel or
// change one in progress, keep their details and a delivery address,
// ask for a return, and write to the farm. Every function takes the
// stores and the session's customer and returns either { ok, ... }
// or { ok: false, status, errors }. The HTTP layer only routes.

import { randomBytes } from "node:crypto";

import avatars from "../../../data/avatars.json" with { type: "json" };
import catalog from "../../../data/catalog.json" with { type: "json" };
import terms from "./terms.mjs";
import { indexCatalog } from "../../../assets/scripts/order/lib/catalog.mjs";
import {
  datesFor, isScheduled, orderOccurrence,
} from "../../../assets/scripts/order/lib/dates.mjs";
import {
  legacyOccurrence, occurrenceId,
} from "../../../assets/scripts/order/lib/events.mjs";
import {
  phoneOk, zipInfo,
} from "../../../assets/scripts/order/lib/validate.mjs";
import { cancelOrder as cancelAndRefund } from "./admin.mjs";
import { placeOf } from "./describe.mjs";
import { cutoffAt } from "./jobs.mjs";
import { now as clock } from "./clock.mjs";
import { farmEmails, mailbox, sendMail } from "./mail.mjs";
import { alert, noteMail } from "./health.mjs";
import { log } from "./log.mjs";
import { joined, welcome } from "./news.mjs";
import { notifyFarm, sendForOrder } from "./payments.mjs";
import * as paypalApi from "./paypal.mjs";
import { pickupSchedule } from "./pickups.mjs";
import {
  REMINDERS, amendOrder, answerQuestion, getOrder, keptFee, ordersFor,
  paidTotal, paymentRef, paymentsOf, questionOpen, refundedTotal,
  reminderPrefs, saveCustomer, settledRefunds,
} from "./records.mjs";
import { mailLinks, orderUrlFor } from "./site.mjs";
import * as squareApi from "./square.mjs";
import { adjust } from "./stock.mjs";
import {
  addressReview, farmOrderCancelled, farmPickupChanged, farmRefundNeeded,
  farmReturnRequest, farmSquareOutOfSync, farmSupport, orderCancelled,
  orderChanged,
} from "./templates.mjs";

export const AVATARS = avatars.map((a) => a.key);

const text = (value, max = 200) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

// One line, for a field that lands in a header, such as the support
// note's subject: a CR or LF there could start a header of its own.
const line = (value, max = 200) =>
  text(typeof value === "string" ? value.replace(/[\r\n]+/g, " ") : value,
    max);

const fail = (status, errors) => ({ ok: false, status, errors });

const shortId = () => randomBytes(6).toString("base64url");

// A farm notice about no order (an address to review, a support
// note). It never fails the customer's action, but a failed send
// alerts, as notifyFarm's does for a notice about an order (#268).
const tellFarm = async (stores, template, message, {
  mail = sendMail, env = process.env, now = clock(),
}) => {
  const to = farmEmails(env);

  if (!to.length) return null;

  try {
    const sent = await mail({ to, ...message }, { env });

    await noteMail(stores, true, now);

    return sent;
  } catch (error) {
    const reason = String(error && error.message);

    log.error({ event: "mail.failed", template, error: reason });
    await noteMail(stores, false, now, { error: reason });
    await alert(stores, "mail.failed", { template, error: reason }, {
      env, mail, now,
    });

    return null;
  }
};

// The order as the account page shows it: nothing internal.
const pickupOf = (order) => {
  const f = order.fulfilment;

  if (!isScheduled(f)) return null;

  const {
    name, place, window, occurrence,
  } = placeOf(order);

  return {
    name, place, window, occurrence: occurrence || null,
    gone: !orderOccurrence(terms, f),
  };
};

export const publicOrder = (order, now = clock()) => ({
  id: order.id,
  status: order.status,
  submittedAt: order.submittedAt,
  paidAt: order.paidAt || null,
  cancelRequested: !!order.cancelRequested,
  lines: order.lines.map((l) => ({
    sku: l.sku, label: l.label, qty: l.qty, unitPrice: l.unitPrice,
    lineTotal: l.lineTotal,
  })),
  totals: order.totals,
  // What the order page needs to open the order for a change (#160).
  code: order.code || null,
  pass: order.pass || null,
  passWaivesFee: !!order.passWaivesFee,
  customer: {
    firstName: order.customer.firstName || "",
    lastName: order.customer.lastName || "",
    phone: order.customer.phone || "",
    contact: order.customer.contact || "",
  },
  fulfilment: order.fulfilment,
  // Where and when a pickup is handed over, read from the data files
  // (nothing of it is stored), so the page prints the place without a
  // copy. `gone` is a site no data file has any more.
  pickup: pickupOf(order),
  notes: order.notes || "",
  payments: paymentsOf(order).map((p) => ({
    at: p.at || order.paidAt || null,
    amount: p.amount,
    via: p.via || null,
    method: p.method || null,
    brand: p.brand || null,
    last4: p.last4 || null,
    receiptUrl: p.receiptUrl || null,
    // PayPal gives a Venmo payment no receipt link, so the account
    // page writes its own from these (#238).
    paypalCaptureId: p.via === "venmo" ? p.paypalCaptureId || null : null,
    payer: p.via === "venmo" && p.payer ? p.payer.name || null : null,
  })),
  // Which payment each refund came out of, by its place in `payments`
  // (a refund that names none came out of the first).
  refunds: settledRefunds(order).map((r) => ({
    at: r.at,
    amount: r.amount,
    payment: Math.max(0, paymentsOf(order)
      .findIndex((p) => paymentRef(p) === r.payment)),
  })),
  returns: order.returns || [],
  // Paid and not refundable: a missed delivery's fee (#193). A change
  // on the order page counts what is paid less this.
  keptFee: keptFee(order),
  question: order.question ? {
    kind: order.question.kind,
    reason: order.question.reason || "",
    openedAt: order.question.openedAt,
    until: order.question.until || null,
    answeredAt: order.question.answeredAt || null,
    answer: order.question.answer || null,
  } : null,
  canCancel: canCancel(order, now),
  canChange: canChange(order, now),
});

// An order can be cancelled or changed by the customer until the
// cutoff. A cancellation is a refund the farm makes from the CLI. An
// open question from the farm (a denied pickup window) keeps both
// doors open past the cutoff: the customer was asked to choose.
const actionable = (order, now) =>
  order.status === "paid"
  && !order.cancelRequested
  && (now.getTime() < cutoffAt(order).getTime() || questionOpen(order));

export const canCancel = actionable;

const index = indexCatalog(catalog);

// A pickup at an occurrence that no data file defines any more (a
// series is archived, never deleted, so this should not happen): there
// is no day to move it to, so the page shows the order without the
// change control and says to call, text or email.
const siteGone = (order) => {
  const f = order.fulfilment;

  return isScheduled(f) && !orderOccurrence(terms, f);
};

// A change replays the order's lines through the catalog, so an order
// holding a SKU the catalog doesn't know (one placed before the SKUs
// were renamed, #267) can't be changed: saving would drop that line
// and refund it. Cancelling, and calling the farm, still can.
export const canChange = (order, now) => actionable(order, now)
  && (order.lines || []).every((l) => index.has(l.sku))
  && !siteGone(order);

export const listOrders = async (stores, customer, { now = clock() } = {}) =>
  ({
    ok: true,
    orders: (await ordersFor(stores, customer.email))
      .map((o) => publicOrder(o, now)),
  });

const owned = async (stores, customer, id) => {
  const order = await getOrder(stores, id);

  return order && order.customer.email === customer.email ? order : null;
};

export const cancelOrder = async (stores, customer, id, {
  now = clock(), env = process.env, mail = sendMail,
  square = squareApi, paypal = paypalApi, fetchImpl,
} = {}) => {
  const order = await owned(stores, customer, id);

  if (!order) return fail(404, { order: "We can't find that order." });
  if (!canCancel(order, now)) {
    return fail(409, { order: "This order can't be cancelled any more." });
  }

  // Cancelling answers whatever the farm asked.
  if (questionOpen(order)) {
    await amendOrder(stores, id, {
      question: answerQuestion(order, "cancel", "customer", now),
    }, "question.answered", now);
  }

  // The money goes back now, as the farm's cancel sends it (T1d), so
  // the email's "on its way" is true.
  try {
    await cancelAndRefund(stores, id, {
      now, env, mail, square, paypal, fetchImpl, source: "customer",
      key: `refund-cancel-${id}`, reason: `Order ${id}, cancelled by you`,
    });
    const cancelled = await getOrder(stores, id);

    await notifyFarm(stores, cancelled, "farmOrderCancelled",
      farmOrderCancelled(cancelled, customer, { links: mailLinks(env) }),
      { mail, env, now });

    return { ok: true, order: publicOrder(await getOrder(stores, id), now) };
  } catch (error) {
    log.error({ event: "cancel.refund_failed", id, message: error.message });
  }

  // The refund failed, so the farm refunds and closes it from the CLI.
  const current = await getOrder(stores, id);

  if (current.status === "cancelled") {
    return { ok: true, order: publicOrder(current, now) };
  }

  const flagged = await amendOrder(stores, id, {
    cancelRequested: true, cancelRequestedAt: now.toISOString(),
  }, "cancel.requested", now);

  // The packs will not ship; put them back for the next customer.
  await adjust(stores, order.lines, 1);

  // What the farm will send back (T1a): everything not yet back, less
  // a fee a missed delivery kept.
  await sendForOrder(stores, flagged, "orderCancelled",
    orderCancelled(flagged, {
      by: "customer",
      refunded: paidTotal(order) - refundedTotal(order) - keptFee(order),
      links: mailLinks(env),
    }), { mail, env, now });
  await notifyFarm(stores, await getOrder(stores, id), "farmRefundNeeded",
    farmRefundNeeded(order, customer, { links: mailLinks(env) }),
    { mail, env, now });

  return { ok: true, order: publicOrder(await getOrder(stores, id), now) };
};

// What a change without money does to the record: the date, the
// pickup window, the drop-off details, the notes. Nothing is saved.
// `by` is who answers a question the farm asked ("customer", "farm").
// -> { errors } or { patch, moved }
export const planChange = (order, changes, { now, env, by = "customer" }) => {
  const c = changes && typeof changes === "object" ? changes : {};
  const errors = {};
  const f = JSON.parse(JSON.stringify(order.fulfilment));
  const was = order.fulfilment;
  const wasScheduled = isScheduled(was);
  const here = orderOccurrence(terms, was);
  const wasId = here ? here.id : was.occurrence || null;
  const method = wasScheduled ? "scheduled" : f.method;
  // The occurrence the change asks for, if it asks for one.
  let target = null;

  // Within scheduled pickup the customer may choose any open
  // occurrence, not only another date of the same series. On-farm
  // pickup and delivery cannot switch this way.
  if (c.method !== undefined || c.occurrence !== undefined
    || c.site !== undefined) {
    const to = c.method !== undefined ? text(c.method, 20) : method;

    if (!wasScheduled || !isScheduled({ method: to })) {
      errors.method = "Only a scheduled pickup can move to another " +
        "pickup.";
    } else if (c.occurrence !== undefined) {
      target = text(c.occurrence, 20);
    } else {
      target = legacyOccurrence(terms.model, to, text(c.site, 40),
        text(c.date, 10)) || "";
    }
  } else if (wasScheduled && c.date !== undefined
    && text(c.date, 10) !== was.date) {
    // A new date alone means the same series on that date.
    target = here ? occurrenceId(here.series, text(c.date, 10)) : "";
  }

  const sameSite = target === null || target === wasId;

  // The held occurrence stays valid for the order that already holds
  // it (the farm booked it beyond the usual list).
  const allowed = errors.method ? []
    : datesFor(method, now, terms, pickupSchedule(env), by === "farm");

  if (!sameSite && !errors.method) {
    const day = allowed.find((d) => d.occurrence === target);

    if (!day) {
      errors[c.occurrence === undefined && c.date !== undefined
        ? "date" : "occurrence"] = "That pickup isn't available.";
    } else {
      f.method = "scheduled";
      f.occurrence = target;
      f.date = day.date;
      delete f.site;
    }
  }

  // After the customer's miss, another delivery day charges the fee
  // again (C1), which only the order page can take. Draft wording.
  const refee = questionOpen(order) && order.question.kind === "missed"
    && keptFee(order) > 0;

  if (!wasScheduled && c.date !== undefined
    && text(c.date, 10) !== order.fulfilment.date) {
    const date = text(c.date, 10);

    if (refee) {
      errors.date = "Another delivery day has a new delivery fee. Choose " +
        "it with Change items, where you can pay it.";
    } else if (!allowed.some((d) => d.date === date)) {
      errors.date = "That date isn't available.";
    } else {
      f.date = date;
    }
  }

  if (method === "onfarm" && c.onfarm && typeof c.onfarm === "object"
    && c.onfarm.window !== undefined) {
    f.onfarm.window = text(c.onfarm.window, 20);
  }

  // A pickup moved to another day or time takes one the schedule
  // offers now, and is booked as it stands (W11d).
  const moved = method === "onfarm" && (f.date !== order.fulfilment.date
    || f.onfarm.window !== order.fulfilment.onfarm.window);

  if (moved && !errors.date) {
    const day = allowed.find((d) => d.date === f.date);
    const w = day && day.windows.find((x) => x.id === f.onfarm.window);

    if (w) {
      f.onfarm = { window: w.id, from: w.from, to: w.to };
    } else {
      errors["onfarm.window"] = "That pickup time isn't available.";
    }
  }

  if (method === "delivery" && c.delivery && typeof c.delivery === "object") {
    for (const key of ["cooler", "gate", "notes"]) {
      if (c.delivery[key] !== undefined) {
        f.delivery[key] = text(c.delivery[key], key === "notes" ? 1000 : 300);
      }
    }
    if (!f.delivery.cooler) {
      errors["delivery.cooler"] = "Tell us where the cooler will be.";
    }
  }

  const notes = c.notes !== undefined ? text(c.notes, 2000) : order.notes;

  if (Object.keys(errors).length) return { errors };

  // A moved pickup answers a time the farm gave up; a delivery on
  // another day answers a missed one.
  const patch = { fulfilment: f, notes };

  if (moved) f.state = "agreed";
  if (moved || f.date !== order.fulfilment.date || !sameSite) {
    patch.question = answerQuestion(order, "reschedule", by, now);
  }
  // A move to another occurrence is told in the history, before the
  // change itself: where from, where to, by whom.
  if (!sameSite) {
    patch.history = [...(order.history || []), {
      at: now.toISOString(), event: "fulfilment.moved", from: wasId,
      to: target, by,
    }];
  }

  return { patch, moved, from: !sameSite ? was : null };
};

// Saves a planned change, keeps Square's fulfilment in step and tells
// the customer, and the farm too when the customer made it. `by` names
// the history event: customer.changed or farm.changed. -> the order.
export const applyChange = async (stores, order, plan, {
  now, env, mail, square, by = "customer",
}) => {
  const { id } = order;
  const { patch, moved, from } = plan;
  const f = patch.fulfilment;
  const changed = await amendOrder(stores, id, patch, `${by}.changed`, now);

  // Square carries the fulfilment the farm packs from; keep it in step.
  if (order.square && order.square.squareOrderId) {
    try {
      await square.updateFulfilment(order.square.squareOrderId, changed, {
        env,
      });
    } catch (error) {
      log.error({
        event: "square.update_failed", id, error: String(error.message),
      });
      await amendOrder(stores, id, {
        flags: { ...(changed.flags || {}), squareOutOfSync: true },
      }, "square.out_of_sync", now);
      await notifyFarm(stores, await getOrder(stores, id),
        `farmSquareOutOfSync-${now.getTime()}`,
        farmSquareOutOfSync({ id, fulfilment: f }, order.customer, {
          links: mailLinks(env),
        }), { mail, env, now });
    }
  }

  await sendForOrder(stores, changed, `orderChanged-${now.getTime()}`,
    orderChanged(changed, {
      orderUrl: orderUrlFor(env, changed.id), links: mailLinks(env),
      // A move to another site names both places.
      before: from ? { lines: changed.lines, totals: changed.totals,
        method: from.method, site: from.site,
        occurrence: from.occurrence, date: from.date } : null,
    }),
    { mail, env, now });

  if ((moved || from) && by === "customer") {
    await notifyFarm(stores, await getOrder(stores, id),
      `farmPickupChanged-${now.getTime()}`,
      farmPickupChanged(changed, { links: mailLinks(env), before: from }),
      { mail, env, now });
  }

  return getOrder(stores, id);
};

// What can change without touching money, for the signed-in owner.
export const changeOrder = async (stores, customer, id, changes, {
  now = clock(), env = process.env, mail = sendMail,
  square = { updateFulfilment: squareApi.updateFulfilment },
} = {}) => {
  const order = await owned(stores, customer, id);

  if (!order) return fail(404, { order: "We can't find that order." });
  if (siteGone(order)) {
    // Draft wording, for communications and James.
    return fail(409, { order: "We can't change this pickup here. Please " +
      "call, text or email us and we'll sort it out." });
  }
  if (!canChange(order, now)) {
    return fail(409, { order: "This order can't be changed any more." });
  }

  const plan = planChange(order, changes, { now, env });

  if (plan.errors) return fail(422, plan.errors);

  await applyChange(stores, order, plan, { now, env, mail, square });

  return { ok: true, order: publicOrder(await getOrder(stores, id), now) };
};

export const updateProfile = async (stores, customer, changes, {
  now = clock(), env = process.env, mail = sendMail,
} = {}) => {
  const c = changes && typeof changes === "object" ? changes : {};
  const errors = {};
  const patch = {};

  // The name is kept in parts, as the order form takes it; the full
  // name is rebuilt from them for the places that show it whole.
  if (c.firstName !== undefined || c.lastName !== undefined) {
    patch.firstName = text(c.firstName, 60);
    patch.lastName = text(c.lastName, 60);
    if (!patch.firstName) errors.firstName = "Please enter your first name.";
    if (!patch.lastName) errors.lastName = "Please enter your last name.";
    patch.name = `${patch.firstName} ${patch.lastName}`.trim();
  }
  if (c.phone !== undefined) {
    patch.phone = text(c.phone, 40);
    if (patch.phone && !phoneOk(patch.phone)) {
      errors.phone = "That phone number doesn't look right.";
    }
  }
  if (c.avatar !== undefined) {
    if (c.avatar !== null && !AVATARS.includes(c.avatar)) {
      errors.avatar = "Pick one of the chickens.";
    } else {
      patch.avatar = c.avatar;
    }
  }
  // Farm news by email is opt-in only: off unless the customer ticks
  // the box, here or at checkout, and the change is dated.
  if (c.marketing !== undefined) {
    patch.marketing = c.marketing === true;
    if (patch.marketing !== (customer.marketing === true)) {
      patch.marketingAt = now.toISOString();
      patch.marketingSource = "account";
    }
  }
  // The reminder emails, each on or off; a key left out is unchanged.
  if (c.reminders !== undefined) {
    if (!c.reminders || typeof c.reminders !== "object") {
      errors.reminders = "Which reminders?";
    } else {
      patch.reminders = reminderPrefs(customer);
      for (const key of REMINDERS) {
        if (c.reminders[key] !== undefined) {
          patch.reminders[key] = !!c.reminders[key];
        }
      }
    }
  }

  // Leave us a review (#303): Dismiss hides it for good, on every
  // device, so only a first dismissal is dated and nothing undoes it.
  if (c.reviewDismissed === true && !customer.reviewDismissedAt) {
    patch.reviewDismissedAt = now.toISOString();
  }

  if (Object.keys(errors).length) return fail(422, errors);

  const saved = await saveCustomer(stores, { ...customer, ...patch });

  if (joined(customer, saved)) await welcome(stores, saved, { env, mail, now });

  return { ok: true, customer: saved };
};

// An address inside the approved list is approved at once. Anything
// else is pending until the farm decides, and the farm is told.
export const saveAddress = async (stores, customer, address, {
  now = clock(), env = process.env, mail = sendMail,
} = {}) => {
  const a = address && typeof address === "object" ? address : {};
  const errors = {};
  const next = {
    address1: text(a.address1, 200),
    address2: text(a.address2, 200),
    town: text(a.town, 100),
    zip: text(a.zip, 10).replace(/\D/g, "").slice(0, 5),
    cooler: text(a.cooler, 300),
    gate: text(a.gate, 100),
    notes: text(a.notes, 1000),
  };

  if (!next.address1) errors.address1 = "Please enter your street address.";
  if (!next.town) errors.town = "Please enter your town.";
  if (next.zip.length !== 5) errors.zip = "Please enter a five-digit ZIP.";
  if (Object.keys(errors).length) return fail(422, errors);

  const info = zipInfo(next.zip, terms.area);
  const previous = customer.address || {};
  const same = ["address1", "address2", "town", "zip"].every(
    (k) => (previous[k] || "") === next[k]
  );

  next.state = info.state ? info.state.code : (previous.state || null);
  next.zipStatus = info.status;
  next.updatedAt = now.toISOString();

  if (info.status === "approved") {
    next.status = "approved";
    next.reviewedAt = now.toISOString();
    next.reviewedBy = "area";
  } else if (same && previous.status) {
    // Only the drop-off details changed: keep the farm's decision.
    next.status = previous.status;
    next.reviewedAt = previous.reviewedAt || null;
    next.reviewedBy = previous.reviewedBy || null;
  } else {
    next.status = "pending";
    next.reviewedAt = null;
    next.reviewedBy = null;
  }

  const saved = await saveCustomer(stores, { ...customer, address: next });

  if (next.status === "pending") {
    await tellFarm(stores, "addressReview",
      addressReview(saved, { links: mailLinks(env) }), { mail, env, now });
  }

  return { ok: true, customer: saved };
};

// A return or problem report on an order. The farm answers by email
// and settles it in the CLI.
export const requestReturn = async (stores, customer, id, request, {
  now = clock(), env = process.env, mail = sendMail,
} = {}) => {
  const order = await owned(stores, customer, id);

  if (!order) return fail(404, { order: "We can't find that order." });
  if (!["paid", "fulfilled"].includes(order.status)) {
    return fail(409, { order: "Returns are for paid orders." });
  }

  const r = request && typeof request === "object" ? request : {};
  const reason = text(r.reason, 2000);
  const skus = Array.isArray(r.skus)
    ? r.skus.filter((s) => order.lines.some((l) => l.sku === s))
    : [];

  if (!reason) return fail(422, { reason: "Tell us what went wrong." });

  const entry = {
    id: shortId(),
    at: now.toISOString(),
    reason,
    skus,
    status: "requested",
  };
  const changed = await amendOrder(stores, id, {
    returns: [...(order.returns || []), entry],
  }, "return.requested", now);

  const noted = await notifyFarm(stores, changed,
    `farmReturnRequest-${entry.id}`,
    farmReturnRequest(order, customer, entry, { links: mailLinks(env) }),
    { mail, env, now });

  return { ok: true, order: publicOrder(noted, now), request: entry };
};

// A message to the farm, with the customer's details attached.
export const sendSupport = async (stores, customer, request, {
  now = clock(), env = process.env, mail = sendMail,
} = {}) => {
  const r = request && typeof request === "object" ? request : {};
  const subject = line(r.subject, 150);
  const message = text(r.message, 4000);
  const orderId = line(r.orderId, 40);

  if (!message) return fail(422, { message: "Write us a note first." });

  const id = shortId();

  await stores.customers.set(`support/${customer.email}/${id}`, {
    id, at: now.toISOString(), subject, message, orderId, status: "open",
  });
  await tellFarm(stores, "farmSupport", {
    replyTo: mailbox(customer.name, customer.email),
    ...farmSupport(customer, { subject, message, orderId }, {
      links: mailLinks(env),
    }),
  }, { mail, env, now });

  return { ok: true, id };
};
