// Order and customer records, and the small indexes that make them
// findable: a customer's orders by email, and the open orders the
// scheduled jobs walk. Every write goes through here so the indexes
// cannot drift from the documents.
//
// Order statuses:
//   submitted   invoice published, unpaid
//   paid        Square reported payment
//   fulfilled   delivered or picked up (set by the CLI)
//   cancelled   by the customer, before payment, or by the farm
//   abandoned   never paid by the final reminder
//
// "Open" means the job runner still has something to do: submitted
// orders wait for payment or abandonment; paid orders wait for their
// delivery reminder and fulfilment.

export const OPEN = ["submitted", "paid"];

const emailKey = (email) => String(email || "").trim().toLowerCase();

export const orderKey = (id) => `order/${id}`;
export const openKey = (id) => `open/${id}`;
export const byEmailKey = (email, id) => `by-email/${emailKey(email)}/${id}`;
export const byInvoiceKey = (invoiceId) => `by-invoice/${invoiceId}`;

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
  if (record.square && record.square.invoiceId) {
    await stores.orders.set(byInvoiceKey(record.square.invoiceId), {
      id: record.id,
    });
  }
  if (OPEN.includes(record.status)) {
    await stores.orders.set(openKey(record.id), { id: record.id });
  } else {
    await stores.orders.delete(openKey(record.id));
  }

  return record;
};

export const getOrder = (stores, id) => stores.orders.get(orderKey(id));

export const orderByInvoice = async (stores, invoiceId) => {
  const ref = await stores.orders.get(byInvoiceKey(invoiceId));

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
  if (order.square && order.square.invoiceId) {
    await stores.orders.delete(byInvoiceKey(order.square.invoiceId));
  }

  return true;
};

// Customers are keyed by lowercased email. Creating from an order
// keeps what the order knows and never overwrites a chosen name,
// phone, avatar or address.
export const customerKey = (email) => `customer/${emailKey(email)}`;

export const getCustomer = (stores, email) =>
  stores.customers.get(customerKey(email));

export const saveCustomer = async (stores, customer) => {
  const record = { ...customer, email: emailKey(customer.email) };

  await stores.customers.set(customerKey(record.email), record);

  return record;
};

export const touchCustomer = async (stores, { name, email, phone }, now) => {
  const existing = await getCustomer(stores, email);
  const at = now.toISOString();

  if (existing) {
    return saveCustomer(stores, {
      ...existing,
      name: existing.name || name,
      phone: existing.phone || phone || "",
      lastOrderAt: at,
    });
  }

  return saveCustomer(stores, {
    email,
    name,
    phone: phone || "",
    avatar: null,
    discountGroup: null,
    address: null,
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
