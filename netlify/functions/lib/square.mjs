// The Square seam. One order in, one paid Square order out: the
// customer, the order with its fulfilment, and the payment against
// it, whether a card token from the Web Payments SDK or the record
// of money that came through Venmo. Square stays the system of record
// for money; the dashboard shows every order with its fulfilment.
//
// Every mutation carries an idempotency key derived from the
// submission's key and attempt, so a retry of any step, or of the
// whole function, returns the object already created instead of a
// duplicate.

import terms from "../../../data/delivery.json" with { type: "json" };
import { instant } from "../../../assets/scripts/order/lib/zoned.mjs";

const HOSTS = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
};

const DASHBOARDS = {
  production: "https://app.squareup.com/dashboard",
  sandbox: "https://app.squareupsandbox.com/dashboard",
};

// Where the Web Payments SDK is loaded from, for the page.
export const SDK_URLS = {
  production: "https://web.squarecdn.com/v1/square.js",
  sandbox: "https://sandbox.web.squarecdn.com/v1/square.js",
};

export const squareEnv = (env = process.env) =>
  (env.SQUARE_ENV === "production" ? "production" : "sandbox");

// Where the farm opens an order in Square, for the links in its own
// notices. Nothing when the record has no Square order (a Venmo
// payment whose Square copy could not be made).
export const dashboardUrl = (square, env = process.env) => {
  const base = DASHBOARDS[squareEnv(env)];

  if (!square || !square.squareOrderId) return "";

  return `${base}/orders/overview/${square.squareOrderId}`;
};

// A payment that Square would not take: the customer can try another
// card. `code` is Square's; `message` is for the customer.
export class SquareError extends Error {
  constructor(message, {
    retryable = false, status = 0, detail = null, declined = false,
    code = null,
  } = {}) {
    super(message);
    this.name = "SquareError";
    this.retryable = retryable;
    this.status = status;
    this.detail = detail;
    this.declined = declined;
    this.code = code;
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

  const production = squareEnv(env) === "production";

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

// What the page needs to load the SDK: public, per deploy context.
// Null until the application id is set.
export const clientConfig = (env = process.env) => (env.SQUARE_APPLICATION_ID
  && env.SQUARE_LOCATION_ID
  ? {
    applicationId: env.SQUARE_APPLICATION_ID,
    locationId: env.SQUARE_LOCATION_ID,
    env: squareEnv(env),
    sdkUrl: SDK_URLS[squareEnv(env)],
  }
  : null);

// Square's reasons a card payment fails, and what the customer reads.
// Anything else from CreatePayment is our problem, not theirs.
export const DECLINE_MESSAGES = {
  CARD_DECLINED: "Your card was declined. Try another card.",
  GENERIC_DECLINE: "Your card was declined. Try another card.",
  INSUFFICIENT_FUNDS: "Your card was declined for insufficient funds.",
  CVV_FAILURE: "The security code doesn't match the card.",
  VERIFY_CVV_FAILURE: "The security code doesn't match the card.",
  ADDRESS_VERIFICATION_FAILURE: "The ZIP code doesn't match the card.",
  VERIFY_AVS_FAILURE: "The ZIP code doesn't match the card.",
  INVALID_POSTAL_CODE: "The ZIP code doesn't match the card.",
  INVALID_CARD: "That card number doesn't look right.",
  INVALID_CARD_DATA: "That card number doesn't look right.",
  PAN_FAILURE: "That card number doesn't look right.",
  CARD_EXPIRED: "That card has expired.",
  INVALID_EXPIRATION: "That expiration date doesn't look right.",
  EXPIRATION_FAILURE: "That expiration date doesn't look right.",
  UNSUPPORTED_CARD_BRAND: "We can't take that kind of card.",
  CARD_NOT_SUPPORTED: "We can't take that kind of card.",
  TRANSACTION_LIMIT: "That's over your card's limit for one payment.",
  PAYMENT_LIMIT_EXCEEDED: "That's over the limit for one payment.",
  CARD_TOKEN_EXPIRED: "That card entry timed out. Enter it again.",
  CARD_TOKEN_USED: "That card entry was already used. Enter it again.",
  CARD_PROCESSING_NOT_ENABLED: "Card payments are switched off right now.",
  VOICE_FAILURE: "Your bank declined the payment.",
  CHIP_INSERTION_REQUIRED: "Your bank declined the payment.",
  ALLOWABLE_PIN_TRIES_EXCEEDED: "Your bank declined the payment.",
  RESERVATION_DECLINED: "Your bank declined the payment.",
  CUSTOMER_CANCELED: "The payment was cancelled before it completed.",
  BAD_EXPIRATION: "That expiration date doesn't look right.",
  INVALID_ACCOUNT: "Your bank declined the payment.",
  GIFT_CARD_AVAILABLE_AMOUNT: "That card doesn't have enough on it.",
  AMOUNT_TOO_HIGH: "That's over the limit for one payment.",
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
    const errors = Array.isArray(data.errors) ? data.errors : [];
    const first = errors[0] || {};
    const code = first.code || null;
    const declined = !!(code && DECLINE_MESSAGES[code]);

    throw new SquareError(`Square ${res.status} on ${path}`, {
      retryable: res.status === 429 || res.status >= 500
        || code === "TEMPORARY_ERROR",
      status: res.status,
      detail: errors.length ? errors : data,
      declined,
      code,
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
    ? `Drop site, ${terms.scituate.location}`
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
  // Two lines when the address is outside the published towns, so
  // the receipt explains the extra $3 on its own.
  const charges = [
    ["Delivery fee", t.deliveryFee - (t.areaFee || 0)],
    ["Outside-area fee", t.areaFee || 0],
  ].filter(([, cents]) => cents > 0);

  if (charges.length) {
    out.service_charges = charges.map(([name, cents]) => ({
      name,
      amount_money: money(cents),
      calculation_phase: "SUBTOTAL_PHASE",
      taxable: false,
    }));
  }

  return out;
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

// The customer and the order with its fulfilment, before any money.
// -> { squareOrderId, customerId }
// throws SquareError { retryable, detail }
export const createOrder = async (order, key, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const cfg = settings(env);
  const customerId = await findOrCreateCustomer(
    cfg, order.customer, key, fetchImpl
  );
  const created = await call(cfg, "/v2/orders", {
    idempotency_key: `${key}-order`,
    order: buildOrder(order, customerId, cfg),
  }, fetchImpl);

  return { squareOrderId: created.order.id, customerId };
};

// What the record keeps of a Square payment.
const paymentRecord = (payment) => {
  const card = payment.card_details && payment.card_details.card;
  const wallet = payment.wallet_details || null;

  return {
    squarePaymentId: payment.id,
    status: payment.status,
    receiptUrl: payment.receipt_url || null,
    brand: card ? card.card_brand || null : null,
    last4: card ? card.last_4 || null : null,
    wallet: wallet ? wallet.brand || null : null,
  };
};

// Takes the money for an order. `source` is the SDK's token for a
// card or wallet, or { external: { source, sourceId } } for money
// that came another way (Venmo through PayPal), which Square records
// on the order as an external tender so the dashboard, the reports
// and the refunds keep one shape.
//
// -> { squarePaymentId, status, receiptUrl, brand, last4, wallet }
// throws SquareError { declined, code } when Square would not take
// the card, { retryable } when Square could not be reached.
export const createPayment = async ({
  order, squareOrderId, customerId, key, source,
}, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const cfg = settings(env);
  const body = {
    idempotency_key: `${key}-payment`,
    amount_money: money(order.totals.total),
    order_id: squareOrderId,
    location_id: cfg.locationId,
    customer_id: customerId,
    buyer_email_address: order.customer.email,
    reference_id: order.id,
    note: `North Foster Farm order ${order.id}`,
  };

  if (source.external) {
    body.source_id = "EXTERNAL";
    body.external_details = {
      type: "SOCIAL",
      source: source.external.source,
      source_id: source.external.sourceId || undefined,
    };
  } else {
    body.source_id = source.sourceId;
    if (source.verificationToken) {
      body.verification_token = source.verificationToken;
    }
  }

  const data = await call(cfg, "/v2/payments", body, fetchImpl);
  const payment = data.payment || {};

  if (payment.status !== "COMPLETED" && payment.status !== "APPROVED") {
    throw new SquareError(`Payment ${payment.status || "missing"}`, {
      declined: true, code: payment.status || "UNKNOWN", detail: payment,
    });
  }

  return paymentRecord(payment);
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

// An order whose payment was declined is cancelled so it does not sit
// in the dashboard as an open, unpaid order. Best effort: the next
// attempt makes a fresh order under its own key.
export const cancelOrder = async (squareOrderId, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const cfg = settings(env);
  const current = await currentOrder(cfg, squareOrderId, fetchImpl);

  if (current.state && current.state !== "OPEN") {
    return { id: squareOrderId, cancelled: false };
  }

  await call(cfg, `/v2/orders/${squareOrderId}`, {
    order: {
      location_id: cfg.locationId,
      version: current.version,
      state: "CANCELED",
    },
  }, fetchImpl, "PUT");

  return { id: squareOrderId, cancelled: true };
};

// Money back on a Square payment, whole or part. Square sends the
// customer its own refund receipt. A Venmo payment recorded as an
// external tender is refunded in PayPal instead (paypal.mjs); Square
// is only told so its books agree.
// -> { squareRefundId, status, amount }
export const refundPayment = async ({
  squarePaymentId, amount, key, reason,
}, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const cfg = settings(env);
  const data = await call(cfg, "/v2/refunds", {
    idempotency_key: `${key}-refund`,
    payment_id: squarePaymentId,
    amount_money: money(amount),
    reason: reason ? String(reason).slice(0, 192) : undefined,
  }, fetchImpl);
  const refund = data.refund || {};

  return {
    squareRefundId: refund.id,
    status: refund.status,
    amount: refund.amount_money ? refund.amount_money.amount : amount,
  };
};

// One payment, by id, for reconciling a webhook, with what has been
// refunded of it so far (cents).
export const getPayment = async (squarePaymentId, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const cfg = settings(env);
  const data = await call(
    cfg, `/v2/payments/${squarePaymentId}`, null, fetchImpl, "GET"
  );
  const payment = data.payment || {};

  return {
    ...paymentRecord(payment),
    refunded: payment.refunded_money ? payment.refunded_money.amount : 0,
  };
};
