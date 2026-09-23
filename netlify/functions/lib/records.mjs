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

// The farm's side of a pickup, beside `status`. Only an on-farm window
// needs the farm's agreement: `fulfilment.state` is `requested` until
// `bin/nff orders confirm` makes it `agreed`. Delivery and the
// Scituate drop are born agreed, and so is any record from before the
// state existed.
export const needsAgreement = (order) =>
  order.fulfilment.method === "onfarm"
  && order.fulfilment.state === "requested";

// A question the farm put to the customer (today only `window`: the
// pickup time was denied, pick another). While one is open the clocks
// on the order pause; answering it, by the customer rescheduling or
// cancelling or by the farm confirming after all, closes it.
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
  await stores.orders.set(byEmailKey(record.customer.email, record.id), {
    id: record.id, at: record.submittedAt,
  });
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

const paymentIds = (order) => {
  const p = order.payment || {};

  return [p.squarePaymentId, p.paypalCaptureId].filter(Boolean);
};

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
  await stores.orders.delete(byEmailKey(order.customer.email, id));
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
        ? { marketing: true, marketingAt: at }
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
