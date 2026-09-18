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
  addDays, instant, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { describe } from "./describe.mjs";

const HOSTS = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
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

  return {
    token: env.SQUARE_ACCESS_TOKEN,
    locationId: env.SQUARE_LOCATION_ID,
    host: HOSTS[env.SQUARE_ENV === "production" ? "production" : "sandbox"],
    version: env.SQUARE_VERSION || "2026-09-16",
  };
};

const call = async (cfg, path, body, fetchImpl) => {
  let res;

  try {
    res = await fetchImpl(`${cfg.host}${path}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.token}`,
        "Square-Version": cfg.version,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
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

  if (f.method === "onfarm") {
    bits.push(`${f.onfarm.window} pickup`);
    bits.push(`phone ${f.onfarm.phone}${f.onfarm.textOk ? " (text ok)" : ""}`);
  }
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
        phone_number: e164(f.method === "onfarm" ? f.onfarm.phone : phone),
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
    line_items: order.lines.map((line) => (line.squareVariationId
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
      name: `Bulk discount ($${t.discountTier}+)`,
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
    accepted_payment_methods: {
      card: true,
      square_gift_card: false,
      bank_account: false,
      buy_now_pay_later: false,
      cash_app_pay: false,
    },
    title: `North Foster Farm order ${order.id}`,
    description: `${describe(order)} Chicken arrives frozen. Once this ` +
      "invoice is paid, your order is reserved.",
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

  const [given, ...rest] = customer.name.split(/\s+/);
  const created = await call(cfg, "/v2/customers", {
    idempotency_key: `${key}-customer`,
    given_name: given,
    family_name: rest.join(" ") || undefined,
    email_address: customer.email,
    phone_number: e164(customer.phone),
  }, fetchImpl);

  return created.customer.id;
};

// -> { squareOrderId, invoiceId, invoiceNumber, invoiceUrl }
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
  const drafted = await call(cfg, "/v2/invoices", {
    idempotency_key: `${key}-invoice`,
    invoice: buildInvoice(
      order, squareOrderId, customerId, cfg, now, { emailInvoice }
    ),
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
  };
};
