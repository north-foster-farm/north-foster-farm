// What a signed-in customer can do: read their orders, cancel or
// change one in progress, keep their details and a delivery address,
// ask for a return, and write to the farm. Every function takes the
// stores and the session's customer and returns either { ok, ... }
// or { ok: false, status, errors }. The HTTP layer only routes.

import { randomBytes } from "node:crypto";

import avatars from "../../../data/avatars.json" with { type: "json" };
import terms from "../../../data/delivery.json" with { type: "json" };
import { datesFor } from "../../../assets/scripts/order/lib/dates.mjs";
import {
  phoneOk, zipInfo,
} from "../../../assets/scripts/order/lib/validate.mjs";
import { abandonAt } from "./jobs.mjs";
import { adminEmails, sendMail } from "./mail.mjs";
import { log } from "./log.mjs";
import {
  hold, notifyFarm, resendInvoice as resendPayLink, sendForOrder,
} from "./payments.mjs";
import {
  REMINDERS, amendOrder, answerQuestion, getOrder, ordersFor, questionOpen,
  reminderPrefs, saveCustomer, setStatus,
} from "./records.mjs";
import { mailLinks, orderUrlFor, siteUrl } from "./site.mjs";
import {
  cancelInvoice, cancelFulfilment, updateFulfilment,
} from "./square.mjs";
import { adjust } from "./stock.mjs";
import {
  addressReview, farmPickupChanged, farmVenmoClaimed, orderCancelled,
  orderChanged,
} from "./templates.mjs";

export const AVATARS = avatars.map((a) => a.key);

const text = (value, max = 200) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const fail = (status, errors) => ({ ok: false, status, errors });

const shortId = () => randomBytes(6).toString("base64url");

// Farm-side notice; never fails the customer's action.
const tellFarm = async (message, { mail = sendMail, env = process.env }) => {
  const to = adminEmails(env);

  if (!to.length) return null;

  try {
    return await mail({ to, ...message }, { env });
  } catch (error) {
    log.error({
      event: "mail.failed", template: "farm", error: String(error.message),
    });

    return null;
  }
};

// The order as the account page shows it: nothing internal.
export const publicOrder = (order, now = new Date()) => ({
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
  fulfilment: order.fulfilment,
  notes: order.notes || "",
  invoice: order.square ? {
    number: order.square.invoiceNumber || null,
    url: order.square.invoiceUrl || null,
  } : null,
  returns: order.returns || [],
  paymentPending: order.paymentPending
    ? { source: order.paymentPending.source || null } : null,
  question: order.question ? {
    kind: order.question.kind,
    reason: order.question.reason || "",
    openedAt: order.question.openedAt,
    answeredAt: order.question.answeredAt || null,
    answer: order.question.answer || null,
  } : null,
  canCancel: canCancel(order, now),
  canChange: canChange(order, now),
});

// An order can be cancelled by the customer until the cutoff, while
// it is unpaid or paid. Paid cancellations need a refund by hand. An
// open question from the farm (a denied pickup window) keeps both
// doors open past the cutoff: the customer was asked to choose.
const actionable = (order, now) =>
  ["submitted", "paid"].includes(order.status)
  && !order.cancelRequested
  && (now.getTime() < abandonAt(order).getTime() || questionOpen(order));

export const canCancel = actionable;

export const canChange = actionable;

export const listOrders = async (stores, customer, { now = new Date() } = {}) =>
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
  now = new Date(), env = process.env, mail = sendMail,
  square = { cancelInvoice, cancelFulfilment },
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

  if (order.status === "submitted") {
    const cancelled = await setStatus(stores, id, "cancelled", now, {
      source: "customer",
    });

    await adjust(stores, order.lines, 1);

    if (order.square && order.square.invoiceId) {
      try {
        await square.cancelInvoice(order.square.invoiceId, { env });
        if (order.square.squareOrderId) {
          await square.cancelFulfilment(order.square.squareOrderId, { env });
        }
      } catch (error) {
        log.error({
          event: "square.cancel_failed", id, error: String(error.message),
        });
      }
    }
    await sendForOrder(stores, cancelled, "orderCancelled",
      orderCancelled(cancelled, { refund: false, links: mailLinks(env) }),
      { mail, env, now });

    return { ok: true, order: publicOrder(await getOrder(stores, id), now) };
  }

  // Paid: the farm refunds through Square, then closes it in the CLI.
  const flagged = await amendOrder(stores, id, {
    cancelRequested: true, cancelRequestedAt: now.toISOString(),
  }, "cancel.requested", now);

  // The packs will not ship; put them back for the next customer.
  await adjust(stores, order.lines, 1);

  await sendForOrder(stores, flagged, "orderCancelled",
    orderCancelled(flagged, { refund: true, links: mailLinks(env) }),
    { mail, env, now });
  await tellFarm({
    subject: `Refund needed: ${id} cancelled by ${customer.email}`,
    text: `${customer.name || customer.email} cancelled paid order ${id} ` +
      `(${order.fulfilment.method} ${order.fulfilment.date}). Refund it ` +
      `in Square, then: bin/nff order cancel ${id}`,
    html: `<p>${customer.name || customer.email} cancelled paid order ` +
      `${id} (${order.fulfilment.method} ${order.fulfilment.date}). Refund ` +
      `it in Square, then run <code>bin/nff order cancel ${id}</code>.</p>`,
  }, { mail, env });

  return { ok: true, order: publicOrder(await getOrder(stores, id), now) };
};

// What can change without touching money: the date, the pickup
// window and phone, the drop-off details, the notes.
export const changeOrder = async (stores, customer, id, changes, {
  now = new Date(), env = process.env, mail = sendMail,
  square = { updateFulfilment },
} = {}) => {
  const order = await owned(stores, customer, id);

  if (!order) return fail(404, { order: "We can't find that order." });
  if (!canChange(order, now)) {
    return fail(409, { order: "This order can't be changed any more." });
  }

  const c = changes && typeof changes === "object" ? changes : {};
  const errors = {};
  const f = JSON.parse(JSON.stringify(order.fulfilment));
  const method = f.method;

  if (c.date !== undefined) {
    const date = text(c.date, 10);
    const allowed = datesFor(method, now, terms);

    if (!allowed.some((d) => d.date === date)) {
      errors.date = "That date isn't available.";
    } else {
      f.date = date;
    }
  }

  if (method === "onfarm" && c.onfarm && typeof c.onfarm === "object") {
    const window = text(c.onfarm.window, 20);
    const phone = text(c.onfarm.phone, 40);

    if (c.onfarm.window !== undefined) {
      if (!["morning", "afternoon"].includes(window)) {
        errors["onfarm.window"] = "Morning or afternoon?";
      } else {
        f.onfarm.window = window;
      }
    }
    if (c.onfarm.phone !== undefined) {
      if (!phoneOk(phone)) {
        errors["onfarm.phone"] = "That phone number doesn't look right.";
      } else {
        f.onfarm.phone = phone;
      }
    }
    if (c.onfarm.textOk !== undefined) f.onfarm.textOk = !!c.onfarm.textOk;
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

  if (Object.keys(errors).length) return fail(422, errors);

  // A pickup moved to another day or window is a new request: the
  // farm has to agree again, and a denied window is answered.
  const moved = method === "onfarm" && (f.date !== order.fulfilment.date
    || f.onfarm.window !== order.fulfilment.onfarm.window);
  const patch = { fulfilment: f, notes };

  if (moved) {
    f.state = "requested";
    f.agreedAt = null;
    patch.question = answerQuestion(order, "reschedule", "customer", now);
  }

  const changed = await amendOrder(stores, id, patch, "customer.changed", now);

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
      await tellFarm({
        subject: `Square out of sync: ${id}`,
        text: `${customer.email} changed order ${id} but Square could not ` +
          `be updated. Check the fulfilment in Square: ${f.method} ${f.date}.`,
        html: `<p>${customer.email} changed order ${id} but Square could ` +
          `not be updated. Check the fulfilment in Square: ${f.method} ` +
          `${f.date}.</p>`,
      }, { mail, env });
    }
  }

  await sendForOrder(stores, changed, `orderChanged-${now.getTime()}`,
    orderChanged(changed, {
      orderUrl: orderUrlFor(env, changed.id), links: mailLinks(env),
    }),
    { mail, env, now });

  if (moved) {
    await notifyFarm(stores, await getOrder(stores, id),
      `farmPickupChanged-${now.getTime()}`,
      farmPickupChanged(changed, { links: mailLinks(env) }),
      { mail, env, now });
  }

  return { ok: true, order: publicOrder(await getOrder(stores, id), now) };
};

// The pay-link email again, from the order page.
export const resendInvoice = async (stores, customer, id, {
  now = new Date(), env = process.env, mail = sendMail,
} = {}) => {
  const order = await owned(stores, customer, id);

  if (!order) return fail(404, { order: "We can't find that order." });
  if (order.status !== "submitted") {
    return fail(409, { order: "This order isn't waiting for payment." });
  }

  const r = await resendPayLink(stores, order, {
    orderUrl: orderUrlFor(env, id), mail, env, now,
  });

  if (!r.ok) {
    return fail(429, { order: "We've sent that a few times already. " +
      "Check your spam folder, or write to us." });
  }

  return { ok: true, order: publicOrder(r.order, now) };
};

// "I paid by Venmo": the order waits (no reminders, not abandoned)
// while the farm checks the Venmo app, and the farm is told. Venmo's
// own notification usually marks the order paid first; this is for
// when it has not, or the note had no order number.
export const claimVenmo = async (stores, customer, id, {
  now = new Date(), env = process.env, mail = sendMail,
} = {}) => {
  const order = await owned(stores, customer, id);

  if (!order) return fail(404, { order: "We can't find that order." });
  if (order.status !== "submitted") {
    return fail(409, { order: "This order isn't waiting for payment." });
  }
  if (order.paymentPending) {
    return fail(409, { order: "We're already looking for that payment." });
  }

  const held = await hold(stores, order, now, "venmo");

  await notifyFarm(stores, held, `farmVenmoClaimed-${now.getTime()}`,
    farmVenmoClaimed(held, { links: mailLinks(env) }), { mail, env, now });

  return { ok: true, order: publicOrder(await getOrder(stores, id), now) };
};

export const updateProfile = async (stores, customer, changes) => {
  const c = changes && typeof changes === "object" ? changes : {};
  const errors = {};
  const patch = {};

  if (c.name !== undefined) {
    patch.name = text(c.name, 120);
    if (!patch.name) errors.name = "Please enter your name.";
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

  if (Object.keys(errors).length) return fail(422, errors);

  const saved = await saveCustomer(stores, { ...customer, ...patch });

  return { ok: true, customer: saved };
};

// An address inside the approved list is approved at once. Anything
// else is pending until the farm decides, and the farm is told.
export const saveAddress = async (stores, customer, address, {
  now = new Date(), env = process.env, mail = sendMail,
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
    await tellFarm(addressReview(saved, {
      cliHint: `bin/nff address approve ${saved.email}  (or deny)`,
      links: mailLinks(env),
    }), { mail, env });
  }

  return { ok: true, customer: saved };
};

// A return or problem report on an order. The farm answers by email
// and settles it in the CLI.
export const requestReturn = async (stores, customer, id, request, {
  now = new Date(), env = process.env, mail = sendMail,
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

  await tellFarm({
    subject: `Return request: ${id} from ${customer.email}`,
    text: `${customer.name || customer.email} asked about a return on ` +
      `${id}.\n\n${reason}\n\nItems: ${skus.join(", ") || "not specified"}` +
      `\n\nSettle it with: bin/nff return resolve ${id} ${entry.id}`,
    html: `<p>${customer.name || customer.email} asked about a return on ` +
      `${id}.</p><blockquote>${reason}</blockquote><p>Items: ` +
      `${skus.join(", ") || "not specified"}</p><p>Settle it with ` +
      `<code>bin/nff return resolve ${id} ${entry.id}</code>.</p>`,
  }, { mail, env });

  return { ok: true, order: publicOrder(changed, now), request: entry };
};

// A message to the farm, with the customer's details attached.
export const sendSupport = async (stores, customer, request, {
  now = new Date(), env = process.env, mail = sendMail,
} = {}) => {
  const r = request && typeof request === "object" ? request : {};
  const subject = text(r.subject, 150);
  const message = text(r.message, 4000);
  const orderId = text(r.orderId, 40);

  if (!message) return fail(422, { message: "Write us a note first." });

  const id = shortId();

  await stores.customers.set(`support/${customer.email}/${id}`, {
    id, at: now.toISOString(), subject, message, orderId, status: "open",
  });
  await tellFarm({
    subject: `Support: ${subject || "(no subject)"} from ${customer.email}`,
    text: `${customer.name || customer.email} <${customer.email}>` +
      `${customer.phone ? ` · ${customer.phone}` : ""}` +
      `${orderId ? `\nOrder ${orderId}` : ""}\n\n${message}\n\n` +
      `Reply to this email to answer. Account: ${siteUrl(env)}/account/`,
    html: `<p><strong>${customer.name || customer.email}</strong> ` +
      `&lt;${customer.email}&gt;${customer.phone
        ? ` · ${customer.phone}` : ""}</p>` +
      `${orderId ? `<p>Order ${orderId}</p>` : ""}` +
      `<blockquote>${message.replace(/\n/g, "<br>")}</blockquote>` +
      "<p>Reply to this email to answer.</p>",
  }, { mail, env });

  return { ok: true, id };
};
