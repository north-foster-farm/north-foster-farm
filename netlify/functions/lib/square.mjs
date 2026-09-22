// The Square seam: one order in, one published invoice out. Square
// issues the receipt; it emails the invoice too unless the farm's own
// mail is configured, in which case our "complete your order" email
// carries the pay link and Square stays quiet.
//
// Every mutation carries an idempotency key derived from the order's
// key, so a retry of any step, or of the whole function, returns the
// object already created instead of a duplicate.

import terms from "../../../data/delivery.json" with { type: "json" };
import {
  addDays, instant, today, weekday,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { describe } from "./describe.mjs";

// A bank transfer takes Square two or three business days to clear,
// longer by some sellers' accounts, and a cleared payment is what
// reserves the order. So the invoice offers it only when the date is
// far enough out for a prompt payer to clear in time.
export const BANK_TRANSFER_LEAD_DAYS = 5;

export const bankTransferOffered = (date, now) => {
  let d = today(now, terms.timeZone);
  let businessDays = 0;

  while (d < date) {
    d = addDays(d, 1);
    if (weekday(d) >= 1 && weekday(d) <= 5) businessDays += 1;
  }

  return businessDays >= BANK_TRANSFER_LEAD_DAYS;
};

const HOSTS = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
};

const DASHBOARDS = {
  production: "https://app.squareup.com/dashboard",
  sandbox: "https://app.squareupsandbox.com/dashboard",
};

// Where the farm opens an order in Square, for the links in its own
// notices. Falls back to the invoice when a record predates the
// squareOrderId, and to nothing at all when it has neither.
export const dashboardUrl = (square, env = process.env) => {
  const base = DASHBOARDS[
    env.SQUARE_ENV === "production" ? "production" : "sandbox"
  ];

  if (!square) return "";
  if (square.squareOrderId) {
    return `${base}/orders/overview/${square.squareOrderId}`;
  }
  if (square.invoiceId) return `${base}/invoices/${square.invoiceId}`;

  return "";
};

export class SquareError extends Error {
  constructor(message, { retryable = false, status = 0, detail = null } = {}) {
    super(message);
    this.name = "SquareError";
    this.retryable = retryable;
    this.status = status;
    this.detail = detail;
  }
}

export const settings = (env = process.env) => {
  const missing = ["SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID"]
    .filter((key) => !env[key]);

  if (missing.length) {
    throw new SquareError(`Missing ${missing.join(", ")}`, {
      retryable: false,
    });
  }

  const production = env.SQUARE_ENV === "production";

  return {
    token: env.SQUARE_ACCESS_TOKEN,
    locationId: env.SQUARE_LOCATION_ID,
    host: HOSTS[production ? "production" : "sandbox"],
    version: env.SQUARE_VERSION || "2026-09-16",
    // The variation ids in the catalog belong to the production item
    // library; the sandbox has its own, so there lines go ad hoc.
    catalog: production,
  };
};

const call = async (cfg, path, body, fetchImpl, method = "POST") => {
  let res;

  try {
    res = await fetchImpl(`${cfg.host}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${cfg.token}`,
        "Square-Version": cfg.version,
        "Content-Type": "application/json",
      },
      body: method === "GET" ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new SquareError(`Network error calling ${path}`, {
      retryable: true, detail: String(error),
    });
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new SquareError(`Square ${res.status} on ${path}`, {
      retryable: res.status === 429 || res.status >= 500,
      status: res.status,
      detail: data.errors || data,
    });
  }

  return data;
};

const money = (amount) => ({ amount, currency: "USD" });

export const e164 = (phone) => {
  const d = String(phone || "").replace(/\D/g, "");

  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;

  return undefined;
};

const stateFor = (zip) => {
  for (const state of terms.area.states) {
    if (state.towns.some((t) => t.zips.includes(zip))) return state.code;
  }

  return zip.startsWith("0") ? "RI" : undefined;
};

const staffNote = (order) => {
  const bits = [];
  const f = order.fulfilment;

  if (order.customer.contact) bits.push(`prefers ${order.customer.contact}`);
  if (f.method === "onfarm") bits.push(`${f.onfarm.window} pickup`);
  if (f.method === "delivery") {
    bits.push(`cooler: ${f.delivery.cooler}`);
    if (f.delivery.gate) bits.push(`gate: ${f.delivery.gate}`);
    if (f.delivery.notes) bits.push(f.delivery.notes);
    if (order.flags.zipUnlisted) bits.push("ZIP not on the approved list");
  }
  if (order.notes) bits.push(`notes: ${order.notes}`);
  if (order.source) bits.push(`heard via ${order.source}`);
  if (order.flags.totalMismatch) bits.push("client total differed; recomputed");

  return bits.join(" · ").slice(0, 500);
};

const fulfillment = (order) => {
  const f = order.fulfilment;
  const { name, email, phone } = order.customer;
  const note = staffNote(order);
  const tz = terms.timeZone;

  if (f.method === "delivery") {
    const d = f.delivery;

    return {
      type: "DELIVERY",
      state: "PROPOSED",
      delivery_details: {
        recipient: {
          display_name: name,
          email_address: email,
          phone_number: e164(phone),
          address: {
            address_line_1: d.address1,
            address_line_2: d.address2 || undefined,
            locality: d.town,
            administrative_district_level_1: d.state || stateFor(d.zip),
            postal_code: d.zip,
            country: "US",
          },
        },
        schedule_type: "SCHEDULED",
        deliver_at: instant(f.date, 10, 0, tz).toISOString(),
        note,
      },
    };
  }

  const hour = f.method === "scituate"
    ? terms.scituate.opensHour
    : (f.onfarm.window === "afternoon" ? 13 : 9);
  const where = f.method === "scituate"
    ? `Scituate drop site, ${terms.scituate.location}`
    : "On-farm pickup";

  return {
    type: "PICKUP",
    state: "PROPOSED",
    pickup_details: {
      recipient: {
        display_name: name,
        email_address: email,
        phone_number: e164(phone),
      },
      schedule_type: "SCHEDULED",
      pickup_at: instant(f.date, hour, 0, tz).toISOString(),
      note: `${where} · ${note}`.slice(0, 500),
    },
  };
};

export const buildOrder = (order, customerId, cfg) => {
  const t = order.totals;
  const out = {
    location_id: cfg.locationId,
    reference_id: order.id,
    customer_id: customerId,
    line_items: order.lines.map((line) => (
      cfg.catalog && line.squareVariationId
        ? {
          catalog_object_id: line.squareVariationId,
          quantity: String(line.qty),
        }
        : {
          name: line.name,
          quantity: String(line.qty),
          base_price_money: money(line.unitPrice * 100),
        })),
    fulfillments: [fulfillment(order)],
  };

  if (t.discountAmount > 0) {
    out.discounts = [{
      name: t.discountLabel || "Discount",
      amount_money: money(t.discountAmount),
      scope: "ORDER",
    }];
  }
  if (t.deliveryFee > 0) {
    out.service_charges = [{
      name: "Delivery fee",
      amount_money: money(t.deliveryFee),
      calculation_phase: "SUBTOTAL_PHASE",
      taxable: false,
    }];
  }

  return out;
};

const acceptedMethods = (bankTransfer) => ({
  card: true,
  square_gift_card: false,
  bank_account: bankTransfer,
  buy_now_pay_later: false,
  cash_app_pay: false,
});

export const buildInvoice = (
  order, squareOrderId, customerId, cfg, now, { emailInvoice = true } = {}
) => {
  const date = order.fulfilment.date;
  const current = today(now, terms.timeZone);
  const dayBefore = addDays(date, -1);

  return {
    location_id: cfg.locationId,
    order_id: squareOrderId,
    primary_recipient: { customer_id: customerId },
    delivery_method: emailInvoice ? "EMAIL" : "SHARE_MANUALLY",
    payment_requests: [{
      request_type: "BALANCE",
      due_date: dayBefore > current ? dayBefore : current,
      automatic_payment_source: "NONE",
    }],
    accepted_payment_methods: acceptedMethods(bankTransferOffered(date, now)),
    title: `North Foster Farm order ${order.id}`,
    // The same words as the emails (James, 2026-09-22).
    description: `${describe(order)} Your order isn't final until it's ` +
      "paid.",
    sale_or_service_date: date,
    store_payment_method_enabled: false,
  };
};

const findOrCreateCustomer = async (cfg, customer, key, fetchImpl) => {
  const found = await call(cfg, "/v2/customers/search", {
    query: { filter: { email_address: { exact: customer.email } } },
    limit: 1,
  }, fetchImpl);

  if (found.customers && found.customers.length) return found.customers[0].id;

  const [given, ...rest] = customer.firstName
    ? [customer.firstName, customer.lastName || ""]
    : customer.name.split(/\s+/);
  const created = await call(cfg, "/v2/customers", {
    idempotency_key: `${key}-customer`,
    given_name: given,
    family_name: rest.join(" ") || undefined,
    email_address: customer.email,
    phone_number: e164(customer.phone),
  }, fetchImpl);

  return created.customer.id;
};

// -> { squareOrderId, invoiceId, invoiceNumber, invoiceUrl,
//      bankTransfer } — the last says whether the invoice offered it,
//      so the jobs know which ones to close later.
// throws SquareError { retryable, detail }
export const createOrderAndInvoice = async (order, key, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  emailInvoice = true,
} = {}) => {
  const cfg = settings(env);
  const customerId = await findOrCreateCustomer(
    cfg, order.customer, key, fetchImpl
  );
  const created = await call(cfg, "/v2/orders", {
    idempotency_key: `${key}-order`,
    order: buildOrder(order, customerId, cfg),
  }, fetchImpl);
  const squareOrderId = created.order.id;
  const invoice = buildInvoice(
    order, squareOrderId, customerId, cfg, now, { emailInvoice }
  );
  const drafted = await call(cfg, "/v2/invoices", {
    idempotency_key: `${key}-invoice`,
    invoice,
  }, fetchImpl);
  const { id, version } = drafted.invoice;
  const published = await call(cfg, `/v2/invoices/${id}/publish`, {
    idempotency_key: `${key}-publish`,
    version,
  }, fetchImpl);

  return {
    squareOrderId,
    invoiceId: id,
    invoiceNumber: published.invoice.invoice_number || null,
    invoiceUrl: published.invoice.public_url || null,
    bankTransfer: invoice.accepted_payment_methods.bank_account,
  };
};

// -> { id, status, paidAt } for one invoice; status is Square's
// (DRAFT, UNPAID, SCHEDULED, PARTIALLY_PAID, PAID, CANCELED, FAILED,
// PAYMENT_PENDING, REFUNDED, PARTIALLY_REFUNDED).
export const getInvoice = async (invoiceId, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const cfg = settings(env);
  const data = await call(
    cfg, `/v2/invoices/${invoiceId}`, null, fetchImpl, "GET"
  );
  const invoice = data.invoice || {};
  const request = (invoice.payment_requests || [])[0] || {};

  return {
    id: invoice.id,
    status: invoice.status,
    version: invoice.version,
    paidAt: request.total_completed_amount_money
      && request.total_completed_amount_money.amount > 0
      ? invoice.updated_at || null
      : null,
  };
};

// Cancels an unpaid invoice so the pay link stops working. Square
// needs the current version; a fresh read supplies it. An invoice
// that is already paid or cancelled is left alone.
export const cancelInvoice = async (invoiceId, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const cfg = settings(env);
  const current = await getInvoice(invoiceId, { env, fetchImpl });

  if (!["UNPAID", "SCHEDULED", "DRAFT"].includes(current.status)) {
    return { id: invoiceId, status: current.status, cancelled: false };
  }

  const data = await call(cfg, `/v2/invoices/${invoiceId}/cancel`, {
    version: current.version,
  }, fetchImpl);

  return {
    id: invoiceId,
    status: (data.invoice && data.invoice.status) || "CANCELED",
    cancelled: true,
  };
};

// Takes the bank option off an unpaid invoice once its date is too
// close for a transfer to clear, so a slow payer cannot pick it on
// the due date and turn up with money in flight. Square wants the
// current version. An invoice no longer unpaid is left alone.
export const closeBankTransfer = async (invoiceId, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const cfg = settings(env);
  const current = await getInvoice(invoiceId, { env, fetchImpl });

  if (!["UNPAID", "SCHEDULED", "DRAFT"].includes(current.status)) {
    return { id: invoiceId, status: current.status, closed: false };
  }

  await call(cfg, `/v2/invoices/${invoiceId}`, {
    invoice: {
      version: current.version,
      accepted_payment_methods: acceptedMethods(false),
    },
  }, fetchImpl, "PUT");

  return { id: invoiceId, status: current.status, closed: true };
};

// Square's copy of the fulfilment is what the farm packs from, so a
// customer's change to the date or the details goes there too. Square
// wants the order's current version and the fulfilment's uid.
const currentOrder = async (cfg, squareOrderId, fetchImpl) => {
  const data = await call(
    cfg, `/v2/orders/${squareOrderId}`, null, fetchImpl, "GET"
  );

  return data.order || {};
};

export const updateFulfilment = async (squareOrderId, order, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const cfg = settings(env);
  const current = await currentOrder(cfg, squareOrderId, fetchImpl);
  const existing = (current.fulfillments || [])[0];

  if (!existing) throw new SquareError("Square order has no fulfilment");

  const next = fulfillment(order);

  delete next.state;

  const data = await call(cfg, `/v2/orders/${squareOrderId}`, {
    order: {
      location_id: cfg.locationId,
      version: current.version,
      fulfillments: [{ uid: existing.uid, ...next }],
    },
  }, fetchImpl, "PUT");

  return { id: squareOrderId, version: data.order && data.order.version };
};

export const cancelFulfilment = async (squareOrderId, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const cfg = settings(env);
  const current = await currentOrder(cfg, squareOrderId, fetchImpl);
  const existing = (current.fulfillments || [])[0];

  if (!existing || existing.state === "CANCELED") {
    return { id: squareOrderId, cancelled: false };
  }

  await call(cfg, `/v2/orders/${squareOrderId}`, {
    order: {
      location_id: cfg.locationId,
      version: current.version,
      fulfillments: [{ uid: existing.uid, state: "CANCELED" }],
    },
  }, fetchImpl, "PUT");

  return { id: squareOrderId, cancelled: true };
};
