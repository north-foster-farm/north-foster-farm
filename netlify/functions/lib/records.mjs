// Order and customer records, and the small indexes that make them
// findable: a customer's orders by email, and the open orders the
// scheduled jobs walk. Every write goes through here so the indexes
// cannot drift from the documents.
//
// Order statuses:
//   paid        born paid: the record exists once the money is taken
//   unpaid      made by the farm (`bin/nff orders create`, #181) for a
//               customer who pays later, on the account page or in
//               person; the money is on `payments`, never the status,
//               so `dueOn` says what is still owed
//   fulfilled   delivered or picked up (set by the jobs or the CLI)
//   cancelled   by the customer or the farm; `refund` says what went
//               back
//
// Records from before the checkout moved onto the page may still say
// `submitted` (invoice out, unpaid) or `abandoned`; nothing makes
// those any more and the jobs flag any `submitted` one they find.
//
// "Open" means the job runner still has something to do: a paid or
// unpaid order waits for its delivery reminder and fulfillment.
//
// Beside the orders sit the checkouts: a Venmo payment is approved
// in the Venmo app and captured afterwards, so the validated order
// waits under `checkout/<key>` between the two, and a PayPal webhook
// can finish it if the browser never came back.

import { createHash } from "node:crypto";

import { now as clock } from "./clock.mjs";

export const OPEN = ["paid", "unpaid"];

// A question the farm put to the customer: `missed`, a delivery we
// couldn't leave, held until `until` for them to choose (#193); or,
// on older records, `window`, a booked pickup time the farm gave up.
// While one is open the clocks on the order pause; the customer
// rescheduling, switching or cancelling answers it.
export const questionOpen = (order) =>
  !!(order.question && !order.question.answeredAt);

export const answerQuestion = (order, answer, by, now) => (questionOpen(order)
  ? { ...order.question, answeredAt: now.toISOString(), answer, by }
  : order.question || null);

const emailKey = (email) => String(email || "").trim().toLowerCase();

export const orderKey = (id) => `order/${id}`;
export const openKey = (id) => `open/${id}`;
export const byEmailKey = (email, id) => `by-email/${emailKey(email)}/${id}`;
export const byPaymentKey = (paymentId) => `by-payment/${paymentId}`;

const stamp = (order, event, now, extra = {}) => ({
  ...order,
  history: [
    ...(order.history || []), { at: now.toISOString(), event, ...extra },
  ],
});

// Writes the order and its indexes. Idempotent: writing the same order
// twice leaves one record.
export const saveOrder = async (stores, order, now = clock()) => {
  const record = order.history ? order : stamp(order, order.status, now);

  await stores.orders.set(orderKey(record.id), record);
  // An order whose customer's details were deleted (lib/forget.mjs)
  // has no email, and no index.
  if (record.customer.email) {
    await stores.orders.set(byEmailKey(record.customer.email, record.id), {
      id: record.id, at: record.submittedAt,
    });
  }
  // A Square payment and a PayPal capture each name the order, for
  // the webhooks that speak of a refund.
  for (const paymentId of paymentIds(record)) {
    await stores.orders.set(byPaymentKey(paymentId), { id: record.id });
  }
  if (OPEN.includes(record.status)) {
    await stores.orders.set(openKey(record.id), { id: record.id });
  } else {
    await stores.orders.delete(openKey(record.id));
  }

  return record;
};

export const getOrder = (stores, id) => stores.orders.get(orderKey(id));

// Whether a record was made by this submission. Every record from the
// page carries its submission key; one without a key belongs to no
// submission.
export const belongsTo = (order, key) =>
  !!(order && key && order.meta && order.meta.idempotencyKey === key);

// --- Order ids -------------------------------------------------------
//
// An id is reserved before any processor is called (#253). `id/<id>`
// holds the submission key that drew it, written create-only, and
// `submission/<key>` points back at it, so a retry, even one in the
// next month, finds the same id. A draw another submission holds is
// passed over for the next. Reservations are never deleted, so an id
// is never given out twice, even after its order is.

export const idKey = (id) => `id/${id}`;
export const submissionKey = (key) => `submission/${key}`;
export const MAX_DRAWS = 8;

// The record this submission made, if it made one. -> it, or null.
export const orderForSubmission = async (stores, key) => {
  const pointer = await stores.orders.get(submissionKey(key));

  return pointer && pointer.id ? getOrder(stores, pointer.id) : null;
};

// `draw(n)` is the nth candidate id for this submission, the same on
// every retry. -> the id, held by this submission alone.
//
// The read after each create is the verdict, not the create's own
// answer: Blobs reports a failed conditional write that was not a 412
// as written. A key that reads back empty means the store failed, and
// that throws (the page retries) rather than pass the id over, which
// would leave one submission holding two.
export const reserveOrderId = async (stores, key, draw, now = clock()) => {
  const known = await stores.orders.get(submissionKey(key));

  if (known && known.id) return known.id;

  for (let n = 0; n < MAX_DRAWS; n++) {
    const id = draw(n);

    await stores.orders.create(idKey(id), { key, at: now.toISOString() });

    const holder = await stores.orders.get(idKey(id));

    if (!holder) throw new Error(`The reservation of ${id} did not stick.`);
    if (holder.key !== key) continue;

    // A record older than reservations is never written over either.
    const record = await getOrder(stores, id);

    if (record && !belongsTo(record, key)) continue;

    await stores.orders.create(submissionKey(key), { id });

    const pointer = await stores.orders.get(submissionKey(key));

    if (!pointer || !pointer.id) {
      throw new Error(`The pointer to ${id} did not stick.`);
    }

    // A twin request of this submission got there first with another
    // of its own ids (only across a month's turn): the pointer wins,
    // and the id drawn here stays reserved, unused.
    return pointer.id;
  }

  throw new Error(`No free order id in ${MAX_DRAWS} draws.`);
};

// The money on an order: every payment and every refund, oldest first.
// A record from before an order could be changed after paying
// (2026-09-25) holds one `payment` and at most one `refund` instead;
// these read both shapes. A payment carries its `amount` (cents); the
// old single one paid the whole total.
export const paymentsOf = (order) => {
  if (!order) return [];
  if (Array.isArray(order.payments)) return order.payments;

  return order.payment
    ? [{ amount: order.totals.total, ...order.payment }]
    : [];
};

export const refundsOf = (order) => {
  if (!order) return [];
  if (Array.isArray(order.refunds)) return order.refunds;

  return order.refund ? [order.refund] : [];
};

const sum = (items) => items.reduce((s, x) => s + (x.amount || 0), 0);

// A refund Square reports FAILED or REJECTED, or PayPal FAILED or
// CANCELLED, stays on the record, for the history, but returned
// nothing (#215).
export const FAILED_REFUND = ["FAILED", "REJECTED", "CANCELLED"];
export const settledRefunds = (order) => refundsOf(order)
  .filter((r) => !FAILED_REFUND.includes(r.status));

export const paidTotal = (order) => sum(paymentsOf(order));
export const refundedTotal = (order) => sum(settledRefunds(order));

// What the customer still owes on the order: the total less what has
// been paid (#181). A refund never makes an order owe (lib/packing.mjs
// says why), and a record from the invoice era owes its whole total.
export const dueOn = (order) => (order.status === "submitted"
  ? order.totals.total
  : Math.max(0, order.totals.total - paidTotal(order)));

// The delivery fee an attempted delivery keeps: "the delivery fee is
// not refundable once we attempt the delivery" (James, F1). The farm
// marks the attempt (`bin/nff orders attempted`), which records the
// fee as it stood, or 0 when waived (C1, C2), so a later switch to
// pickup cannot take it off.
export const keptFee = (order) =>
  (order && order.attempted && order.attempted.fee) || 0;

// What a payment is known by at its processor: the Square payment, or
// for Venmo the PayPal capture.
export const paymentRef = (payment) =>
  (payment && (payment.paypalCaptureId || payment.squarePaymentId)) || null;

// The fields that hold money, in the list shape, for an amendOrder
// patch: an old record is rewritten the new way the first time its
// money changes, so no record holds both shapes.
export const moneyPatch = (order, { payments, refunds } = {}) => ({
  payments: payments || paymentsOf(order),
  refunds: refunds || refundsOf(order),
  payment: undefined,
  refund: undefined,
});

const paymentIds = (order) => paymentsOf(order)
  .flatMap((p) => [p.squarePaymentId, p.paypalCaptureId])
  .filter(Boolean);

export const orderByPayment = async (stores, paymentId) => {
  const ref = await stores.orders.get(byPaymentKey(paymentId));

  return ref ? getOrder(stores, ref.id) : null;
};

// Moves an order to a new status with a history line, keeping the
// open index in step. Returns the updated record, or null if unknown.
export const setStatus = async (
  stores, id, status, now = clock(), extra
) => {
  const order = await getOrder(stores, id);

  if (!order) return null;
  if (order.status === status) return order;

  const at = now.toISOString();
  const patch = { status };

  if (status === "paid") patch.paidAt = at;
  if (status === "cancelled") patch.cancelledAt = at;
  if (status === "abandoned") patch.abandonedAt = at;
  if (status === "fulfilled") patch.fulfilledAt = at;

  return saveOrder(
    stores, stamp({ ...order, ...patch }, status, now, extra), now
  );
};

// Any patch that is not a status change, with a history line.
export const amendOrder = async (
  stores, id, patch, event, now = clock()
) => {
  const order = await getOrder(stores, id);

  if (!order) return null;

  return saveOrder(stores, stamp({ ...order, ...patch }, event, now), now);
};

// A customer's orders, newest first.
export const ordersFor = async (stores, email) => {
  const keys = await stores.orders.list(`by-email/${emailKey(email)}/`);
  const orders = await Promise.all(
    keys.map(({ key }) => stores.orders.get(`order/${key.split("/").pop()}`))
  );

  return orders
    .filter(Boolean)
    .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
};

export const openOrders = async (stores) => {
  const keys = await stores.orders.list("open/");
  const orders = await Promise.all(
    keys.map(({ key }) => stores.orders.get(`order/${key.split("/").pop()}`))
  );

  return orders.filter(Boolean);
};

// Every order, newest first. For the CLI; not for a request path.
export const allOrders = async (stores) => {
  const keys = await stores.orders.list("order/");
  const orders = await Promise.all(
    keys.map(({ key }) => stores.orders.get(key))
  );

  return orders
    .filter(Boolean)
    .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
};

export const deleteOrder = async (stores, id) => {
  const order = await getOrder(stores, id);

  if (!order) return false;

  await stores.orders.delete(orderKey(id));
  await stores.orders.delete(openKey(id));
  if (order.customer.email) {
    await stores.orders.delete(byEmailKey(order.customer.email, id));
  }
  for (const paymentId of paymentIds(order)) {
    await stores.orders.delete(byPaymentKey(paymentId));
  }

  return true;
};

// --- Checkouts -------------------------------------------------------
//
// A validated order waiting for its Venmo payment to be captured,
// keyed by the submission key. `paypalOrderId` is indexed so a
// PAYMENT.CAPTURE.COMPLETED webhook can find it. Deleted once the
// order is recorded; swept by the jobs after CHECKOUT_TTL.
//
// `checkout/<key>` is the latest attempt. A new attempt does not
// overwrite the one before: that one is moved to `checkout/<key>~<n>`
// (n its attempt), still indexed by its PayPal order, so a payment
// captured for it is found by the jobs, the webhook and the
// reconciliation before a new attempt is paid (#268). An archived
// checkout is an ordinary checkout under another key to the sweep.

export const CHECKOUT_TTL = 24 * 60 * 60_000;

export const checkoutKey = (key) => `checkout/${key}`;
export const byPayPalKey = (paypalOrderId) => `by-paypal/${paypalOrderId}`;
export const archivedKey = (key, attempt) => `${key}~${attempt || 1}`;

// The key a stored checkout lives under: its own, or its archive's.
const holderOf = (checkout) => (checkout.archived
  ? archivedKey(checkout.key, checkout.attempt) : checkout.key);

const indexCheckout = async (stores, checkout) => {
  if (!checkout.paypalOrderId) return;

  await stores.orders.set(byPayPalKey(checkout.paypalOrderId), {
    key: checkout.key, holder: holderOf(checkout),
  });
};

export const saveCheckout = async (stores, checkout) => {
  const current = await stores.orders.get(checkoutKey(checkout.key));

  // Another attempt, or another payment: the one before is kept.
  if (current && current.paypalOrderId !== checkout.paypalOrderId) {
    const kept = { ...current, archived: true };

    await stores.orders.set(checkoutKey(holderOf(kept)), kept);
    await indexCheckout(stores, kept);
  }

  await stores.orders.set(checkoutKey(checkout.key), checkout);
  await indexCheckout(stores, checkout);

  return checkout;
};

// The latest checkout of a submission, or the one that made this
// PayPal order when `paypalOrderId` names an earlier attempt's.
export const getCheckout = async (stores, key, paypalOrderId = null) => {
  const latest = await stores.orders.get(checkoutKey(key));

  if (!paypalOrderId || !latest || latest.paypalOrderId === paypalOrderId) {
    return latest;
  }

  return (await checkoutByPayPal(stores, paypalOrderId, key)) || latest;
};

// Every attempt of a submission that is still kept, latest first.
export const checkoutsFor = async (stores, key) => {
  const found = [];
  const latest = await stores.orders.get(checkoutKey(key));

  if (latest) found.push(latest);

  for (const { key: k } of await stores.orders.list(
    checkoutKey(`${key}~`)
  )) {
    const checkout = await stores.orders.get(k);

    if (checkout) found.push(checkout);
  }

  return found.sort((x, y) => (y.attempt || 1) - (x.attempt || 1));
};

// `key` limits the answer to one submission's checkouts.
export const checkoutByPayPal = async (stores, paypalOrderId, key = null) => {
  const ref = await stores.orders.get(byPayPalKey(paypalOrderId));

  if (!ref || (key && ref.key !== key)) return null;

  return stores.orders.get(checkoutKey(ref.holder || ref.key));
};

// The latest checkout of the submission, or with `paypalOrderId` the
// one that made that payment. -> whether one was there.
export const deleteCheckout = async (stores, key, paypalOrderId = null) => {
  const checkout = await getCheckout(stores, key, paypalOrderId);

  if (!checkout) return false;

  await stores.orders.delete(checkoutKey(holderOf(checkout)));
  if (checkout.paypalOrderId) {
    await stores.orders.delete(byPayPalKey(checkout.paypalOrderId));
  }

  return true;
};

export const listCheckouts = async (stores) => {
  const found = [];

  for (const { key } of await stores.orders.list("checkout/")) {
    const checkout = await stores.orders.get(key);

    if (checkout) found.push(checkout);
  }

  return found;
};

// Every checkout older than the TTL is dropped, except one in `keep`
// (order ids): its rescue failed this run, and it may hold a payment
// PayPal approved, so it waits for the next run. -> how many.
export const sweepCheckouts = async (stores, now = clock(), {
  keep = new Set(),
} = {}) => {
  const cutoff = now.getTime() - CHECKOUT_TTL;
  let swept = 0;

  for (const { key } of await stores.orders.list("checkout/")) {
    const checkout = await stores.orders.get(key);

    const held = checkout && checkout.order && keep.has(checkout.order.id);

    if (!held && (!checkout || Date.parse(checkout.at) < cutoff)) {
      await deleteCheckout(stores, key.slice("checkout/".length));
      swept += 1;
    }
  }

  return swept;
};

// Sign-in links, sessions (lib/auth.mjs) and unconfirmed farm-news
// sign-ups (lib/news.mjs) past their own `expires` are dead: a link is
// refused and a session ends when next read. Only a session read after
// it expires was ever deleted, so they piled up, and a sign-up never
// confirmed kept its name and email. Nothing else in the auth store is
// touched, and nothing still live (#189). -> how many.
//
// Sessions are stored under a hash of the id (lib/auth.mjs). One under
// any other key was written before that, under its raw id, and is a
// live id to anyone who can read Blobs: it is deleted whatever its
// expiry, and its customer signs in again by link.
export const AUTH_SWEPT = ["token/", "session/", "news/"];

const HASHED_SESSION = /^session\/[0-9a-f]{64}$/;

export const sweepAuth = async (stores, now = clock()) => {
  let swept = 0;

  for (const prefix of AUTH_SWEPT) {
    for (const { key } of await stores.auth.list(prefix)) {
      if (prefix === "session/" && !HASHED_SESSION.test(key)) {
        await stores.auth.delete(key);
        swept += 1;
        continue;
      }

      const found = await stores.auth.get(key);

      if (found && Number.isFinite(found.expires)
        && found.expires < now.getTime()) {
        await stores.auth.delete(key);
        swept += 1;
      }
    }
  }

  return swept;
};

// --- Square profiles a checkout made ---------------------------------
//
// Pressing Pay makes a Square customer profile when the email is new
// to the farm's directory, before the charge. Each one made is noted
// here, by its Square id, until the jobs decide whether the payment
// behind it ever succeeded (#236).

export const madeCustomerKey = (id) => `made-customer/${id}`;

export const noteMadeCustomer = (stores, { customerId, email, orderId }, now) =>
  stores.orders.set(madeCustomerKey(customerId), {
    customerId, email, orderId, at: now.toISOString(),
  });

export const listMadeCustomers = async (stores) => {
  const found = [];

  for (const { key } of await stores.orders.list("made-customer/")) {
    const made = await stores.orders.get(key);

    if (made) found.push(made);
  }

  return found;
};

export const dropMadeCustomer = (stores, id) =>
  stores.orders.delete(madeCustomerKey(id));

// Customers are keyed by lowercased email. Creating from an order
// keeps what the order knows and never overwrites a chosen name,
// phone, avatar or address.
export const customerKey = (email) => `customer/${emailKey(email)}`;

// The cart a signed-in customer carries across devices (#149).
export const cartKey = (email) => `cart/${emailKey(email)}`;

// Which account a browser's draft belongs to, without the email: the
// browser tags its draft with this and scrubs a draft tagged for
// another account (#149, session/cart-sync.js). /api/me and the cart
// endpoints send it.
export const cartOwner = (email) => createHash("sha256")
  .update(emailKey(email)).digest("hex").slice(0, 16);

// Which reminder emails a customer takes. On unless the record says
// otherwise, so a customer who never visited the settings tab, or a
// record from before the setting existed, keeps getting them; the
// "Turn off ... reminders" link in the email leads here. (`payment`
// was a second kind while orders could be unpaid; a record may still
// carry it, and nothing reads it.)
export const REMINDERS = ["delivery"];

export const reminderPrefs = (customer) => {
  const set = (customer && customer.reminders) || {};

  return Object.fromEntries(REMINDERS.map((k) => [k, set[k] !== false]));
};

export const getCustomer = (stores, email) =>
  stores.customers.get(customerKey(email));

// --- Consent to farm news, as a log (#273) -------------------------
//
// `marketing`, `marketingAt` and `marketingSource` are the current
// state, which the sync and the checkout read. `consent` is the
// history behind it: one event per opt-in or opt-out, appended, never
// rewritten, so a second opt-in keeps the first. Each event:
//
//   action      "in" or "out"
//   type        one of CONSENT_TYPES
//   detail      the form or page, the market, the order: plain words
//   at          when the person gave or withdrew consent (a market
//               sheet's date, which may be weeks before it is entered)
//   recordedAt  when it was written here; equals `marketingAt`
//   capturedBy  who took an in-person consent (James or Jim), or null
//   evidence    a pointer to private proof (a scan's file name), never
//               the proof itself; or null
export const CONSENT_TYPES = [
  "website-form", // The footer or /news/ sign-up field
  "checkout", // The box on the order page
  "account-settings", // The box in account settings
  "reinvite-confirmation", // The old list's confirmation link
  "market-sheet", // A paper sign-up sheet at a market
  "in-person", // Asked us to add them, by word of mouth
  "resend", // Added by hand in Resend, or left there
  "unsubscribe-link", // The one-click link in a list email
  "inactivity", // Taken off after a year without interaction (#189)
  "membership", // Reserved: joining the membership program
];

// How `marketingSource` names the same things.
const SOURCE_TYPES = {
  signup: "website-form",
  site: "website-form",
  order: "checkout",
  account: "account-settings",
  confirm: "reinvite-confirmation",
  import: "market-sheet",
  resend: "resend",
  unsubscribe: "unsubscribe-link",
  inactive: "inactivity",
};

export const consentType = (source) => SOURCE_TYPES[source] || source
  || "unknown";

const consentEvent = (customer, {
  type, detail = "", at, capturedBy = null, evidence = null,
} = {}) => ({
  action: customer.marketing === true ? "in" : "out",
  type: type || consentType(customer.marketingSource),
  detail,
  at: at || customer.marketingAt,
  recordedAt: customer.marketingAt,
  capturedBy,
  evidence,
});

// The log, with a record from before it began given one event from
// its dated state. That event can only say what the record kept: an
// address that opted out before the log lost its opt-in.
export const consentLog = (customer) => {
  if (Array.isArray(customer.consent)) return customer.consent;
  if (!customer.marketingAt) return [];

  return [consentEvent(customer, { detail: "recorded before the log" })];
};

// The opt-in now in force, or null. The welcome names its source.
export const currentOptIn = (customer) => {
  if (!customer || customer.marketing !== true) return null;

  const log = consentLog(customer);

  return log.length && log[log.length - 1].action === "in"
    ? log[log.length - 1] : null;
};

// Schema only, for the membership program and Spanish mail after
// launch (#267). Nothing reads these yet.
//
//   language        a BCP-47 tag; "en", and later "es"
//   memberId        an opaque random code, unique, or null
//   memberIdStatus  "active" or "retired", so a code can be retired
//                   and a new one issued; null while there is none
//   memberSince     when they joined, or null; joining is also a
//                   `membership` event in the consent log
//   memberGroup     { id, joinedAt }, a link to a group record that
//                   does not exist yet (docs/email-list.md), or null
export const SCHEMA_DEFAULTS = {
  language: "en",
  memberId: null,
  memberIdStatus: null,
  memberSince: null,
  memberGroup: null,
};

// Every write fills the schema-only fields and keeps the log. A
// change to the consent state that came without an event gets one
// from `marketingSource`; `consent` gives the event its detail.
export const saveCustomer = async (stores, customer, { consent } = {}) => {
  // A record without a log is new, or from before the log: its log is
  // seeded from what is stored, not from the state being written.
  const stored = Array.isArray(customer.consent) ? null
    : await stores.customers.get(customerKey(customer.email));
  const log = Array.isArray(customer.consent) ? customer.consent
    : (stored ? consentLog(stored) : []);
  const last = log[log.length - 1];
  const changed = !!customer.marketingAt && !(last
    && last.recordedAt === customer.marketingAt
    && last.action === (customer.marketing === true ? "in" : "out"));
  const record = {
    ...SCHEMA_DEFAULTS,
    ...customer,
    email: emailKey(customer.email),
    consent: changed ? [...log, consentEvent(customer, consent)] : log,
  };

  await stores.customers.set(customerKey(record.email), record);

  return record;
};

// `marketing` true on an order opts the customer in to farm news and
// dates it; false or absent never opts anyone out. `orderId` goes in
// the consent log's detail.
export const touchCustomer = async (
  stores, { firstName, lastName, name, email, phone, marketing }, now,
  { orderId } = {}
) => {
  const existing = await getCustomer(stores, email);
  const at = now.toISOString();
  const optIn = marketing === true;
  const consent = { detail: orderId ? `order ${orderId}` : "an order" };

  if (existing) {
    return saveCustomer(stores, {
      ...existing,
      name: existing.name || name,
      firstName: existing.firstName || firstName || "",
      lastName: existing.lastName || lastName || "",
      phone: existing.phone || phone || "",
      lastOrderAt: at,
      ...(optIn && existing.marketing !== true
        ? { marketing: true, marketingAt: at, marketingSource: "order" }
        : {}),
    }, { consent });
  }

  return saveCustomer(stores, {
    email,
    name,
    firstName: firstName || "",
    lastName: lastName || "",
    phone: phone || "",
    avatar: null,
    discountGroup: null,
    address: null,
    marketing: optIn,
    marketingAt: optIn ? at : null,
    ...(optIn ? { marketingSource: "order" } : {}),
    createdAt: at,
    lastOrderAt: at,
  }, { consent });
};

export const allCustomers = async (stores) => {
  const keys = await stores.customers.list("customer/");
  const customers = await Promise.all(
    keys.map(({ key }) => stores.customers.get(key))
  );

  return customers.filter(Boolean);
};

export const deleteCustomer = async (stores, email) => {
  await stores.customers.delete(customerKey(email));
  await stores.customers.delete(cartKey(email));
};
