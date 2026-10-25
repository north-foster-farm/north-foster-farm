// Retention and deletion (#189; James, 2026-10-16). Order records are
// kept for good, for reporting; the person on them is not:
//
// - A customer deletes their details from the account page, or the
//   farm does it for them (`bin/nff customers forget`). Their orders
//   stay, re-pointed to the deleted household; everything else that
//   names them goes. Final: the same email signing in again starts a
//   new, empty account, and nothing re-links the old orders.
// - Seven years after an order is placed, the jobs give it the same
//   scrub, whether or not the account is still open.
// - Deleting details also deletes the Square customer profile(s) the
//   customer's own orders name (D-189, 2026-10-17): never one found by
//   name or email, and Square keeps the payments. It happens first, so
//   if Square cannot be reached nothing else is deleted and the
//   customer can try again.
// - A help or contact message is deleted seven years after it was
//   sent, or at once when its sender deletes their details.
//
// A scrubbed order keeps its date, lines, prices, totals, payments,
// how it was fulfilled, the pickup window or the scheduled pickup's
// occurrence (and the moves between occurrences in its history), and
// the town, state and ZIP. None of that is personal, and the farm's
// records need it. It loses the name, email, phone, street address, the
// notes and anything else the customer wrote.

import { normalizeEmail } from "./auth.mjs";
import { log } from "./log.mjs";
import * as newsApi from "./news.mjs";
import {
  OPEN, allOrders, byEmailKey, deleteCustomer, getCustomer, getOrder,
  listCheckouts, ordersFor, paymentsOf, saveOrder,
} from "./records.mjs";
import * as squareApi from "./square.mjs";

export const SCRUB_AFTER_YEARS = 7;

// The Null Object every forgotten order points to: the fields a
// customer has, empty, so whatever reads an order needs no special
// case.
export const DELETED_HOUSEHOLD = Object.freeze({
  household: "deleted",
  deleted: true,
  firstName: "",
  lastName: "",
  name: "Deleted customer",
  email: "",
  phone: "",
  contact: "",
});

export const isScrubbed = (order) =>
  !!(order && order.customer && order.customer.deleted);

const KEPT_DELIVERY = ["town", "state", "zip", "zipStatus"];

const pick = (obj, keys) => Object.fromEntries(
  keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]])
);

// A payment keeps its amount, method and processor ids; the Venmo
// payer and the receipt link (a page that names the buyer) go.
const scrubPayment = (payment) => {
  const rest = { ...payment };

  delete rest.payer;
  delete rest.receiptUrl;

  return rest;
};

// The order without its person. Pure; idempotent.
export const scrubOrder = (order, now = new Date()) => {
  const f = order.fulfilment || {};
  const next = {
    ...order,
    customer: { ...DELETED_HOUSEHOLD },
    fulfilment: {
      ...f,
      delivery: f.delivery ? pick(f.delivery, KEPT_DELIVERY) : null,
      // An older pickup record kept a phone for the day.
      onfarm: f.onfarm ? { ...f.onfarm, phone: undefined } : f.onfarm,
    },
    notes: "",
    returns: (order.returns || []).map((r) => ({ ...r, reason: "" })),
    scrubbedAt: order.scrubbedAt || now.toISOString(),
  };

  if (Array.isArray(order.payments)) {
    next.payments = paymentsOf(order).map(scrubPayment);
  } else if (order.payment) {
    next.payment = scrubPayment(order.payment);
  }
  if (!order.returns) delete next.returns;

  return next;
};

// Writes the scrubbed order and drops its by-email index, so nothing
// leads from an address back to it.
const scrub = async (stores, order, event, now) => {
  const email = order.customer && order.customer.email;
  const next = scrubOrder(order, now);

  await saveOrder(stores, {
    ...next,
    history: [...(order.history || []), { at: now.toISOString(), event }],
  }, now);
  if (email) await stores.orders.delete(byEmailKey(email, order.id));

  return next;
};

const yearsBefore = (now, years) => {
  const d = new Date(now);

  d.setUTCFullYear(d.getUTCFullYear() - years);

  return d;
};

// Every order placed more than SCRUB_AFTER_YEARS ago and not yet
// scrubbed. -> the ids scrubbed.
export const scrubOldOrders = async (stores, now = new Date()) => {
  const cutoff = yearsBefore(now, SCRUB_AFTER_YEARS).toISOString();
  const done = [];

  for (const order of await allOrders(stores)) {
    if (isScrubbed(order) || !order.submittedAt) continue;
    if (order.submittedAt >= cutoff) continue;

    await scrub(stores, order, "details.expired", now);
    done.push(order.id);
  }

  return done;
};

// Every help and contact message sent more than SCRUB_AFTER_YEARS ago:
// the account page's support notes and the contact form's messages. A
// record with no date is kept. -> the keys deleted, sorted.
export const deleteOldMessages = async (stores, now = new Date()) => {
  const cutoff = yearsBefore(now, SCRUB_AFTER_YEARS).toISOString();
  const keys = [];

  for (const prefix of ["messages/", "support/"]) {
    for (const { key } of await stores.customers.list(prefix)) {
      const message = await stores.customers.get(key);

      if (message && message.at && message.at < cutoff) keys.push(key);
    }
  }
  for (const key of keys) await stores.customers.delete(key);

  return keys.sort();
};

// Why a deletion must wait, or null. The farm still needs to reach
// the customer about an order being delivered or picked up, a return,
// or a Venmo payment under way.
const blocker = async (stores, email, orders) => {
  if (orders.some((o) => OPEN.includes(o.status))) return "open";
  if (orders.some((o) => (o.returns || [])
    .some((r) => r.status === "requested"))) return "return";
  if ((await listCheckouts(stores)).some((c) => normalizeEmail(
    c.order && c.order.customer && c.order.customer.email) === email)) {
    return "checkout";
  }

  return null;
};

export const WAIT = {
  // James, D-189 part 1 (2026-10-17).
  open: "You have an order in progress. You can delete your details " +
    "once it's delivered or picked up, or after you cancel it.",
  return: "We're still working on a return for you. You can delete " +
    "your details once it's settled.",
  checkout: "A Venmo payment is under way. Try again in a day.",
};

export const SQUARE_DOWN = "We couldn't reach our payment system to " +
  "delete your payment profile, so nothing was deleted. Please try " +
  "again in a few minutes.";

// The Square customer profiles this customer's own orders recorded.
const squareProfiles = (orders) => [...new Set(orders
  .map((o) => o.square && o.square.customerId)
  .filter(Boolean))];

// Everything under the site's stores that names the address, and the
// Resend contact. With `apply` false nothing is written and the report
// says what would go. -> { ok, ... } or { ok: false, wait }.
export const forgetCustomer = async (stores, rawEmail, {
  apply = false, env = process.env, fetchImpl = globalThis.fetch,
  news = newsApi, now = new Date(), square = squareApi,
} = {}) => {
  const email = normalizeEmail(rawEmail);
  const customer = await getCustomer(stores, email);
  const orders = await ordersFor(stores, email);
  const wait = await blocker(stores, email, orders);

  if (wait) return { ok: false, wait, message: WAIT[wait] };

  const profiles = squareProfiles(orders);
  const auth = [];

  for (const prefix of ["session/", "token/", "unsub/", "news/"]) {
    for (const { key } of await stores.auth.list(prefix)) {
      const value = await stores.auth.get(key);

      if (value && normalizeEmail(value.email) === email) auth.push(key);
    }
  }
  for (const key of [
    `rate/${email}`, `rate/news/${email}`, `change-rate/${email}`,
  ]) {
    if (await stores.auth.get(key)) auth.push(key);
  }

  const support = (await stores.customers.list(`support/${email}/`))
    .map(({ key }) => key);
  const messages = [];

  for (const { key } of await stores.customers.list("messages/")) {
    const m = await stores.customers.get(key);

    if (m && normalizeEmail(m.email) === email) messages.push(key);
  }

  const report = {
    ok: true, apply,
    customer: !!customer,
    orders: orders.map((o) => o.id),
    supportMessages: support.length,
    contactMessages: messages.length,
    authRecords: auth.length,
    squareProfiles: profiles.length,
  };
  const resend = async () => {
    try {
      report.resend = await news.removeContact(email, {
        env, fetchImpl, apply,
      });
    } catch (error) {
      report.resend = `not reached: ${error.message}`;
      if (apply) {
        await stores.customers.set(newsApi.forgottenKey(email), {
          at: now.toISOString(),
        });
      }
    }
  };

  if (!apply) {
    await resend();

    return report;
  }

  // First: if Square cannot be reached, nothing else is deleted.
  try {
    for (const id of profiles) {
      await square.deleteCustomer(id, { env, fetchImpl });
    }
  } catch (error) {
    log.error({
      event: "customer.forget_square_failed", error: error.message,
    });

    return { ok: false, wait: "square", message: SQUARE_DOWN };
  }

  for (const order of orders) {
    const fresh = await getOrder(stores, order.id);

    if (fresh && !isScrubbed(fresh)) {
      await scrub(stores, fresh, "details.deleted", now);
    }
  }
  for (const key of support) await stores.customers.delete(key);
  for (const key of messages) await stores.customers.delete(key);
  for (const key of auth) await stores.auth.delete(key);
  await resend();
  if (customer) await deleteCustomer(stores, email);

  log.info({
    event: "customer.forgotten", orders: report.orders.length,
    resend: report.resend,
  });

  return report;
};
