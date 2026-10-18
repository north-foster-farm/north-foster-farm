// Order and customer records, and the small indexes that make them
// findable: a customer's orders by email, and the open orders the
// scheduled jobs walk. Every write goes through here so the indexes
// cannot drift from the documents.
//
// Order statuses:
//   paid        born paid: the record exists once the money is taken
//   fulfilled   delivered or picked up (set by the jobs or the CLI)
//   cancelled   by the customer or the farm; `refund` says what went
//               back
//
// Records from before the checkout moved onto the page may still say
// `submitted` (invoice out, unpaid) or `abandoned`; nothing makes
// those any more and the jobs flag any `submitted` one they find.
//
// "Open" means the job runner still has something to do: a paid
// order waits for its delivery reminder and fulfilment.
//
// Beside the orders sit the checkouts: a Venmo payment is approved
// in the Venmo app and captured afterwards, so the validated order
// waits under `checkout/<key>` between the two, and a PayPal webhook
// can finish it if the browser never came back.

export const OPEN = ["paid"];

// A question the farm put to the customer (today only `window`: the
// farm gave up a booked pickup time, pick another). While one is open
// the clocks on the order pause; the customer rescheduling or
// cancelling answers it.
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
export const saveOrder = async (stores, order, now = new Date()) => {
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
export const reserveOrderId = async (stores, key, draw, now = new Date()) => {
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

// A refund Square reports FAILED or REJECTED stays on the record, for
// the history, but returned nothing (#215).
export const FAILED_REFUND = ["FAILED", "REJECTED"];
export const settledRefunds = (order) => refundsOf(order)
  .filter((r) => !FAILED_REFUND.includes(r.status));

export const paidTotal = (order) => sum(paymentsOf(order));
export const refundedTotal = (order) => sum(settledRefunds(order));

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
  stores, id, status, now = new Date(), extra
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
  stores, id, patch, event, now = new Date()
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

export const CHECKOUT_TTL = 24 * 60 * 60_000;

export const checkoutKey = (key) => `checkout/${key}`;
export const byPayPalKey = (paypalOrderId) => `by-paypal/${paypalOrderId}`;

export const saveCheckout = async (stores, checkout) => {
  await stores.orders.set(checkoutKey(checkout.key), checkout);
  if (checkout.paypalOrderId) {
    await stores.orders.set(byPayPalKey(checkout.paypalOrderId), {
      key: checkout.key,
    });
  }

  return checkout;
};

export const getCheckout = (stores, key) =>
  stores.orders.get(checkoutKey(key));

export const checkoutByPayPal = async (stores, paypalOrderId) => {
  const ref = await stores.orders.get(byPayPalKey(paypalOrderId));

  return ref ? getCheckout(stores, ref.key) : null;
};

export const deleteCheckout = async (stores, key) => {
  const checkout = await getCheckout(stores, key);

  if (!checkout) return false;

  await stores.orders.delete(checkoutKey(key));
  if (checkout.paypalOrderId) {
    await stores.orders.delete(byPayPalKey(checkout.paypalOrderId));
  }

  return true;
};

// Every checkout older than the TTL is dropped. -> how many.
export const listCheckouts = async (stores) => {
  const found = [];

  for (const { key } of await stores.orders.list("checkout/")) {
    const checkout = await stores.orders.get(key);

    if (checkout) found.push(checkout);
  }

  return found;
};

export const sweepCheckouts = async (stores, now = new Date()) => {
  const cutoff = now.getTime() - CHECKOUT_TTL;
  let swept = 0;

  for (const { key } of await stores.orders.list("checkout/")) {
    const checkout = await stores.orders.get(key);

    if (!checkout || Date.parse(checkout.at) < cutoff) {
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

export const sweepAuth = async (stores, now = new Date()) => {
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

// Customers are keyed by lowercased email. Creating from an order
// keeps what the order knows and never overwrites a chosen name,
// phone, avatar or address.
export const customerKey = (email) => `customer/${emailKey(email)}`;

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

export const saveCustomer = async (stores, customer) => {
  const record = { ...customer, email: emailKey(customer.email) };

  await stores.customers.set(customerKey(record.email), record);

  return record;
};

// `marketing` true on an order opts the customer in to farm news and
// dates it; false or absent never opts anyone out.
export const touchCustomer = async (
  stores, { firstName, lastName, name, email, phone, marketing }, now
) => {
  const existing = await getCustomer(stores, email);
  const at = now.toISOString();
  const optIn = marketing === true;

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
    });
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
  });
};

export const allCustomers = async (stores) => {
  const keys = await stores.customers.list("customer/");
  const customers = await Promise.all(
    keys.map(({ key }) => stores.customers.get(key))
  );

  return customers.filter(Boolean);
};

export const deleteCustomer = (stores, email) =>
  stores.customers.delete(customerKey(email));
