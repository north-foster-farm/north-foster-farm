// The Square seam. One order in, one paid Square order out: the
// customer, the order with its fulfillment, and the payment against
// it, whether a card token from the Web Payments SDK or the record
// of money that came through Venmo. Square stays the system of record
// for money; the dashboard shows every order with its fulfillment.
//
// Every mutation carries an idempotency key derived from the
// submission's key and attempt, so a retry of any step, or of the
// whole function, returns the object already created instead of a
// duplicate.

import terms from "./terms.mjs";
import { company } from "./company.mjs";
import pkg from "../../../package.json" with { type: "json" };
import {
  FAKE, FAKE_SDK_URLS, fakeAllowed, refusal,
} from "./fake.mjs";
import { real } from "./clock.mjs";
import * as fake from "./fake-square.mjs";
import { placeOf } from "./describe.mjs";
import { MONEY_FLOOR_MS, timedFetch, timedOut } from "./http.mjs";
import {
  pickupTimes, windowLabel,
} from "../../../assets/scripts/order/lib/schedule.mjs";
import {
  isScheduled, orderOccurrence,
} from "../../../assets/scripts/order/lib/dates.mjs";
import { instant } from "../../../assets/scripts/order/lib/zoned.mjs";
import {
  validField,
} from "../../../assets/scripts/utils/field-errors.mjs";

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

export const squareEnv = (env = process.env) => {
  if (env.SQUARE_ENV === "production") return "production";

  return env.SQUARE_ENV === FAKE ? FAKE : "sandbox";
};

// The Square deletion kill switch (#241, #236) is in
// square-pause.mjs. ANY CODE THAT DELETES OR CANCELS RECORDS IN SQUARE
// ON ITS OWN, NOW OR LATER, MUST CHECK ITS deletionsPaused() FIRST.

// SQUARE_ENV=fake: fake-square.mjs answers instead of Square, in local
// development only (lib/fake.mjs). Anywhere else it throws, so no
// order is taken without money.
// -> true to use the fake; throws SquareError when it is refused.
export const isFake = (env = process.env) => {
  if (env.SQUARE_ENV !== FAKE) return false;
  if (!fakeAllowed(env)) {
    throw new SquareError(refusal("SQUARE_ENV"), { code: "FAKE_REFUSED" });
  }

  return true;
};

// Where the farm opens an order in Square, for the links in its own
// notices. Nothing when the record has no Square order (a Venmo
// payment whose Square copy could not be made).
export const dashboardUrl = (square, env = process.env) => {
  const base = DASHBOARDS[squareEnv(env)];

  if (!base || !square || !square.squareOrderId) return "";

  return `${base}/orders/overview/${
    encodeURIComponent(square.squareOrderId)}`;
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
  if (isFake(env)) {
    throw new SquareError("SQUARE_ENV=fake has no Square to call");
  }

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
// Null until the application id is set. A fake gets the stub SDK, and
// null where it is refused, so the page offers no card at all.
export const clientConfig = (env = process.env) => {
  if (env.SQUARE_ENV === FAKE) {
    return fakeAllowed(env)
      ? {
        applicationId: env.SQUARE_APPLICATION_ID || "fake-application",
        locationId: env.SQUARE_LOCATION_ID || "FAKE-LOCATION",
        env: FAKE,
        sdkUrl: FAKE_SDK_URLS.square,
      }
      : null;
  }

  return liveConfig(env);
};

const liveConfig = (env) => (env.SQUARE_APPLICATION_ID
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
  INVALID_CARD: validField("card"),
  INVALID_CARD_DATA: validField("card"),
  PAN_FAILURE: validField("card"),
  CARD_EXPIRED: "That card has expired.",
  INVALID_EXPIRATION: validField("expiration"),
  EXPIRATION_FAILURE: validField("expiration"),
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
  CUSTOMER_CANCELED: "The payment was canceled before it completed.",
  BAD_EXPIRATION: validField("expiration"),
  INVALID_ACCOUNT: "Your bank declined the payment.",
  GIFT_CARD_AVAILABLE_AMOUNT: "That card doesn't have enough on it.",
  AMOUNT_TOO_HIGH: "That's over the limit for one payment.",
};

// The longest one call may take: a card can need a few seconds at the
// bank, everything else answers fast. `cfg.deadline`, when set, is the
// request's own end (lib/http.mjs) and cuts either short.
export const CALL_MS = 3500;
export const PAYMENT_MS = 6000;

// An order's path. The id comes from our own record, but is encoded
// all the same so it can never reach past its segment.
const orderPath = (squareOrderId) => `/v2/orders/${
  encodeURIComponent(squareOrderId)}`;

const call = async (cfg, path, body, fetchImpl, method = "POST") => {
  const res = await timedFetch(fetchImpl, `${cfg.host}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${cfg.token}`,
      "Square-Version": cfg.version,
      "Content-Type": "application/json",
    },
    body: method === "GET" || method === "DELETE"
      ? undefined : JSON.stringify(body),
  }, {
    cap: path === "/v2/payments" ? PAYMENT_MS : CALL_MS,
    deadline: cfg.deadline,
    floor: path === "/v2/payments" ? MONEY_FLOOR_MS : undefined,
    name: path,
    fail: (message, options) => new SquareError(message, options),
  });

  // A body that stalls is a call that timed out, not an empty answer:
  // an empty one would read as a payment Square did not make.
  const data = await res.json().catch((error) => {
    if (!timedOut(error)) return {};

    throw new SquareError(`${path} did not finish answering`, {
      retryable: true, code: "timeout", detail: String(error),
    });
  });

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

// Every order the site makes, and every change order, says which
// release made it (#331). The version is package.json's, the one place
// it is spelled: metadata carries it whole and the Source column its
// major.minor. The order id stays the reference, unprefixed. Nothing
// reads the Source column back: the metadata is what a sweep trusts.
export const SITE_VERSION = pkg.version;
export const SOURCE_NAME = `${company.email.split("@")[1]} v${
  SITE_VERSION.split(".").slice(0, 2).join(".")}`;
export const ORDER_METADATA = Object.freeze({
  site_version: SITE_VERSION,
  order_flow: "order-page",
});
export const ORDER_ID = /^NFF-\d{4}-[A-Z0-9]{4}$/;

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
  if (f.method === "onfarm") {
    const times = pickupTimes(f.onfarm);

    bits.push(`pickup ${times ? windowLabel(times) : f.onfarm.window}`);
  }
  if (f.method === "delivery") {
    bits.push(`cooler: ${f.delivery.cooler}`);
    if (f.delivery.gate) bits.push(`gate: ${f.delivery.gate}`);
    if (f.delivery.notes) bits.push(f.delivery.notes);
    if (order.flags.zipUnlisted) bits.push("ZIP not on the approved list");
  }
  // A changed order's items are spread over several Square orders, so
  // the fulfillment the farm packs from lists them whole.
  if ((order.edits || []).length) {
    bits.unshift(`changed; pack ${order.lines
      .map((l) => `${l.qty} × ${l.label || l.name}`).join(", ")}`);
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

  // A pickup's time is its window's start, with minutes (W11d-D). A
  // scheduled pickup's is its occurrence's. An occurrence gone from
  // the data is not the farm, and has no hour: say which it was, and
  // the update keeps the time Square already holds.
  const here = placeOf(order);
  const site = orderOccurrence(terms, f);
  const gone = isScheduled(f) && !site;
  const start = f.method === "onfarm"
    && (pickupTimes(f.onfarm) || { from: "09:00" }).from;
  const [hour, minute] = start
    ? start.split(":").map(Number)
    : [site ? site.opensHour : 9, site ? site.opensMinute || 0 : 0];
  const where = gone ? here.address || f.occurrence || f.site
    : isScheduled(f) ? `Pickup at ${here.name}, ${here.address}`
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
      pickup_at: gone ? undefined
        : instant(f.date, hour, minute, tz).toISOString(),
      note: `${where} · ${note}`.slice(0, 500),
    },
  };
};

export const buildOrder = (order, customerId, cfg) => {
  const t = order.totals;
  const out = {
    location_id: cfg.locationId,
    reference_id: order.id,
    source: { name: SOURCE_NAME },
    metadata: { ...ORDER_METADATA },
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
  // the receipt explains the extra $3 on its own. A fee a pass waived
  // (#182) still goes as the delivery, at $0, with no discount line.
  const charges = [
    ["Delivery fee", t.deliveryFee - (t.areaFee || 0)],
    ["Outside-area fee", t.areaFee || 0],
  ].filter(([name, cents]) => cents > 0
    || (t.feeWaived && name === "Delivery fee"));

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

// A profile the site makes carries the order id it was made for as its
// reference, so "made for this order" survives a retry that finds it
// instead (#236). -> { id, made }
const findOrCreateCustomer = async (cfg, customer, key, fetchImpl, ref) => {
  const found = await call(cfg, "/v2/customers/search", {
    query: { filter: { email_address: { exact: customer.email } } },
    limit: 1,
  }, fetchImpl);

  if (found.customers && found.customers.length) {
    const c = found.customers[0];

    return { id: c.id, made: !!ref && c.reference_id === ref };
  }

  const [given, ...rest] = customer.firstName
    ? [customer.firstName, customer.lastName || ""]
    : customer.name.split(/\s+/);
  const created = await call(cfg, "/v2/customers", {
    idempotency_key: `${key}-customer`,
    given_name: given,
    family_name: rest.join(" ") || undefined,
    email_address: customer.email,
    phone_number: e164(customer.phone),
    reference_id: ref,
  }, fetchImpl);

  return { id: created.customer.id, made: !!ref };
};

// The customer and the order with its fulfillment, before any money.
// `customerMade` says the profile was made for this order, not found.
// -> { squareOrderId, customerId, customerMade }
// throws SquareError { retryable, detail }
export const createOrder = async (order, key, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  deadline,
} = {}) => {
  if (isFake(env)) return fake.createOrder(order, key, { env });

  const cfg = { ...settings(env), deadline };
  const customer = await findOrCreateCustomer(
    cfg, order.customer, key, fetchImpl, order.id
  );
  const created = await call(cfg, "/v2/orders", {
    idempotency_key: `${key}-order`,
    order: buildOrder(order, customer.id, cfg),
  }, fetchImpl);

  return {
    squareOrderId: created.order.id, customerId: customer.id,
    customerMade: customer.made,
  };
};

// A change to a paid order (lib/edit.mjs) as a Square order of its
// own, under the same reference_id: what was added, at today's price,
// and one discount for whatever the change took off, so its total is
// the difference to pay (never below zero). A charge the added items
// do not cover (a discount lost) is a line of its own. With `carries`
// it takes the order's fulfillment too, for a switch between delivery
// and pickup, which Square cannot make on the first order's.
export const buildChangeOrder = (order, change, customerId, cfg) => {
  const lines = change.added.map((line) => (
    cfg.catalog && line.squareVariationId
      ? {
        catalog_object_id: line.squareVariationId,
        quantity: String(line.qty),
      }
      : {
        name: line.name,
        quantity: String(line.qty),
        base_price_money: money(line.unitPrice * 100),
      }));
  const added = change.added
    .reduce((s, line) => s + line.unitPrice * 100 * line.qty, 0);
  const charge = Math.max(0, change.difference) - added;

  if (charge > 0 || !lines.length) {
    lines.push({
      name: `Changes to order ${order.id}`,
      quantity: "1",
      base_price_money: money(Math.max(0, charge)),
    });
  }

  const out = {
    location_id: cfg.locationId,
    reference_id: order.id,
    source: { name: SOURCE_NAME },
    metadata: { ...ORDER_METADATA },
    customer_id: customerId,
    line_items: lines,
  };
  const off = added + Math.max(0, charge) - Math.max(0, change.difference);

  if (off > 0) {
    out.discounts = [{
      name: `Taken off order ${order.id}`,
      amount_money: money(off),
      scope: "ORDER",
    }];
  }
  if (change.carries) out.fulfillments = [fulfillment(order)];

  return out;
};

// -> { squareOrderId, customerId }
export const createChangeOrder = async (order, change, key, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  if (isFake(env)) return fake.createChangeOrder(order, change, key, { env });

  const cfg = settings(env);
  const { id: customerId } = await findOrCreateCustomer(
    cfg, order.customer, key, fetchImpl
  );
  const created = await call(cfg, "/v2/orders", {
    idempotency_key: `${key}-order`,
    order: buildChangeOrder(order, change, customerId, cfg),
  }, fetchImpl);

  return { squareOrderId: created.order.id, customerId };
};

// A change order with nothing to pay is completed with no payment, so
// it does not sit in the dashboard as unpaid.
export const payZeroOrder = async (squareOrderId, key, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  if (isFake(env)) return fake.payZeroOrder(squareOrderId, key, { env });

  const cfg = settings(env);

  await call(cfg, `${orderPath(squareOrderId)}/pay`, {
    idempotency_key: `${key}-pay`,
    payment_ids: [],
  }, fetchImpl);

  return { squareOrderId };
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
  order, squareOrderId, customerId, key, source, amount = order.totals.total,
}, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  deadline,
} = {}) => {
  if (isFake(env)) {
    return fake.createPayment({
      order, squareOrderId, customerId, key, source,
    }, { env });
  }

  const cfg = { ...settings(env), deadline };
  const body = {
    idempotency_key: `${key}-payment`,
    amount_money: money(amount),
    order_id: squareOrderId,
    location_id: cfg.locationId,
    customer_id: customerId,
    buyer_email_address: order.customer.email,
    reference_id: order.id,
    note: `${company.name} order ${order.id}`,
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
  const payment = data.payment;

  // No payment in a 200 is an answer that did not arrive whole, not a
  // decline: the customer is not told to try another card.
  if (!payment) {
    throw new SquareError("Square answered without a payment", {
      retryable: true, detail: data,
    });
  }
  if (payment.status !== "COMPLETED" && payment.status !== "APPROVED") {
    throw new SquareError(`Payment ${payment.status || "missing"}`, {
      declined: true, code: payment.status || "UNKNOWN", detail: payment,
    });
  }

  return paymentRecord(payment);
};

// Whether Square already holds money for an order id. A submission's
// first charge may have gone through with its answer lost (the
// function died before the record was written); the next attempt
// carries fresh idempotency keys and would charge again, so it asks
// here first. Square cannot search orders by reference_id, so the
// recent orders at the location are read and matched on it.
//
// -> null when nothing was paid, else { squareOrderId, customerId,
// amount, external, ...paymentRecord }. throws SquareError when Square
// could not say: the caller must not charge on a guess.
export const FIND_WINDOW = 48 * 60 * 60_000;
export const FIND_PAGES = 4;

export const findPaid = async (order, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  deadline,
  now = new Date(),
} = {}) => {
  if (isFake(env)) return fake.findPaid(order, { env });

  const cfg = { ...settings(env), deadline };
  const since = new Date(real(now).getTime() - FIND_WINDOW).toISOString();
  let cursor;

  for (let page = 0; page < FIND_PAGES; page++) {
    const data = await call(cfg, "/v2/orders/search", {
      location_ids: [cfg.locationId],
      query: {
        filter: {
          state_filter: { states: ["OPEN", "COMPLETED"] },
          date_time_filter: { created_at: { start_at: since } },
        },
        sort: { sort_field: "CREATED_AT", sort_order: "DESC" },
      },
      limit: 500,
      cursor,
    }, fetchImpl);

    for (const found of data.orders || []) {
      const tender = found.reference_id === order.id
        && (found.tenders || []).find((t) => t.payment_id || t.id);

      if (!tender) continue;

      const id = tender.payment_id || tender.id;
      const paid = await call(
        cfg, `/v2/payments/${id}`, null, fetchImpl, "GET"
      );
      const payment = paid.payment || {};

      if (!["COMPLETED", "APPROVED"].includes(payment.status)) continue;

      return {
        ...paymentRecord(payment),
        squareOrderId: found.id,
        customerId: found.customer_id || null,
        amount: payment.amount_money ? payment.amount_money.amount : null,
        // Money that came through Venmo, noted on Square as a tender.
        external: payment.source_type === "EXTERNAL",
      };
    }

    cursor = data.cursor;
    if (!cursor) return null;
  }

  // A busier location than the window and the pages cover: not knowing
  // is not "unpaid".
  throw new SquareError("Too many orders to search for a payment", {
    retryable: false, code: "search.too_many",
  });
};

// Square's copy of the fulfillment is what the farm packs from, so a
// customer's change to the date or the details goes there too. Square
// wants the order's current version and the fulfillment's uid.
// The updates below send the order's own location, so one placed
// before SQUARE_LOCATION_ID moved is changed where it lives (#267).
const currentOrder = async (cfg, squareOrderId, fetchImpl) => {
  const data = await call(
    cfg, orderPath(squareOrderId), null, fetchImpl, "GET"
  );

  return data.order || {};
};

// Square's copy of an order as it is now, for the check that it still
// matches the site's record (lib/drift.mjs). Read only.
// -> the Square order, or null when there is no Square to ask.
export const getOrder = async (squareOrderId, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  if (isFake(env)) return fake.getOrder(squareOrderId);

  return currentOrder(settings(env), squareOrderId, fetchImpl);
};

export const updateFulfillment = async (squareOrderId, order, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  if (isFake(env)) return fake.updateFulfillment(squareOrderId, order, { env });

  const cfg = settings(env);
  const current = await currentOrder(cfg, squareOrderId, fetchImpl);
  const existing = (current.fulfillments || [])[0];

  if (!existing) throw new SquareError("Square order has no fulfillment");

  const next = fulfillment(order);

  delete next.state;
  // A pickup at a site the data no longer has keeps its time.
  if (next.pickup_details && !next.pickup_details.pickup_at) {
    next.pickup_details.pickup_at = (existing.pickup_details || {}).pickup_at;
  }

  const data = await call(cfg, orderPath(squareOrderId), {
    order: {
      location_id: current.location_id || cfg.locationId,
      version: current.version,
      fulfillments: [{ uid: existing.uid, ...next }],
    },
  }, fetchImpl, "PUT");

  return { id: squareOrderId, version: data.order && data.order.version };
};

export const cancelFulfillment = async (squareOrderId, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  if (isFake(env)) return fake.cancelFulfillment(squareOrderId, { env });

  const cfg = settings(env);
  const current = await currentOrder(cfg, squareOrderId, fetchImpl);
  const existing = (current.fulfillments || [])[0];

  if (!existing || existing.state === "CANCELED") {
    return { id: squareOrderId, cancelled: false };
  }

  await call(cfg, orderPath(squareOrderId), {
    order: {
      location_id: current.location_id || cfg.locationId,
      version: current.version,
      fulfillments: [{ uid: existing.uid, state: "CANCELED" }],
    },
  }, fetchImpl, "PUT");

  return { id: squareOrderId, cancelled: true };
};

// Closes a fulfilled order in Square (#328): the fulfillment and the
// order go to COMPLETED in one call. Square takes PROPOSED straight to
// COMPLETED and stamps the pickup time itself, but leaves the order
// OPEN, so both are set. A fulfillment that is already COMPLETED or
// CANCELED and an order that is already closed are left as they are, so
// a repeat, or a hand-made completion, is no error.
// -> { id, completed: true } or { id, completed: false }.
export const completeOrder = async (squareOrderId, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  if (isFake(env)) return fake.completeOrder(squareOrderId, { env });

  const cfg = settings(env);
  const current = await currentOrder(cfg, squareOrderId, fetchImpl);
  const open = (current.fulfillments || []).filter(
    (f) => !["COMPLETED", "CANCELED", "FAILED"].includes(f.state)
  );
  const closed = current.state && current.state !== "OPEN";

  if (closed || (!open.length && current.state === "COMPLETED")) {
    return { id: squareOrderId, completed: false };
  }

  await call(cfg, orderPath(squareOrderId), {
    order: {
      location_id: current.location_id || cfg.locationId,
      version: current.version,
      state: "COMPLETED",
      ...open.length && {
        fulfillments: open.map((f) => ({ uid: f.uid, state: "COMPLETED" })),
      },
    },
  }, fetchImpl, "PUT");

  return { id: squareOrderId, completed: true };
};

// Deletes a customer profile (#189, D-189). Only ever one an order's
// own record names, never one found by name or email; Square keeps the
// payments. A profile already gone counts as deleted, so a retry after
// a half-finished deletion is safe.
// -> { deleted: true } or { deleted: false, gone: true }.
export const deleteCustomer = async (customerId, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  if (isFake(env)) return fake.deleteCustomer(customerId);

  const cfg = settings(env);

  try {
    await call(cfg, `/v2/customers/${encodeURIComponent(customerId)}`,
      undefined, fetchImpl, "DELETE");
  } catch (error) {
    if (error.status === 404) return { deleted: false, gone: true };

    throw error;
  }

  return { deleted: true };
};

// An order whose payment was declined is cancelled so it does not sit
// in the dashboard as an open, unpaid order. Best effort: the next
// attempt makes a fresh order under its own key.
// With `unpaid`, an order that has taken a tender since it was found is
// left alone.
export const cancelOrder = async (squareOrderId, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  deadline,
  unpaid = false,
} = {}) => {
  if (isFake(env)) return fake.cancelOrder(squareOrderId, { env });

  const cfg = { ...settings(env), deadline };
  const current = await currentOrder(cfg, squareOrderId, fetchImpl);

  const paid = !!(current.tenders || []).length;

  if ((current.state && current.state !== "OPEN") || (unpaid && paid)) {
    return { id: squareOrderId, cancelled: false, paid };
  }

  await call(cfg, orderPath(squareOrderId), {
    order: {
      location_id: current.location_id || cfg.locationId,
      version: current.version,
      state: "CANCELED",
    },
  }, fetchImpl, "PUT");

  return { id: squareOrderId, cancelled: true };
};

// The location's OPEN orders created before `before`, newest first,
// at most `max` of them, for the sweep in jobs.mjs (#241). Paid orders
// stay OPEN until their fulfillment completes, so the newest come first
// and the old paid ones fall past the cap.
// -> [{ id, referenceId, siteVersion, createdAt, tenders, total }]
export const searchOpenOrders = async ({ before, max = 500 }, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  if (isFake(env)) return fake.searchOpenOrders();

  const cfg = settings(env);
  const found = [];
  let cursor;

  do {
    const data = await call(cfg, "/v2/orders/search", {
      location_ids: [cfg.locationId],
      limit: 100,
      cursor,
      query: {
        filter: {
          state_filter: { states: ["OPEN"] },
          date_time_filter: {
            created_at: { end_at: before.toISOString() },
          },
        },
        sort: { sort_field: "CREATED_AT", sort_order: "DESC" },
      },
    }, fetchImpl);

    for (const o of data.orders || []) {
      found.push({
        id: o.id,
        referenceId: o.reference_id || null,
        siteVersion: (o.metadata && o.metadata.site_version)
          || null,
        createdAt: o.created_at,
        tenders: (o.tenders || []).length,
        total: o.total_money ? o.total_money.amount : 0,
      });
    }
    cursor = data.cursor;
  } while (cursor && found.length < max);

  return found.slice(0, max);
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
  if (isFake(env)) {
    return fake.refundPayment({
      squarePaymentId, amount, key, reason,
    }, { env });
  }

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

// One refund, by id, for the check that every refund settled (#215).
// -> { squareRefundId, status, amount }
export const getRefund = async (squareRefundId, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  if (isFake(env)) return fake.getRefund(squareRefundId, { env });

  const cfg = settings(env);
  const data = await call(
    cfg, `/v2/refunds/${squareRefundId}`, null, fetchImpl, "GET"
  );
  const refund = data.refund || {};

  return {
    squareRefundId: refund.id,
    status: refund.status,
    amount: refund.amount_money ? refund.amount_money.amount : 0,
  };
};

// One payment, by id, for reconciling a webhook, with what has been
// refunded of it so far (cents).
export const getPayment = async (squarePaymentId, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  if (isFake(env)) return fake.getPayment(squarePaymentId, { env });

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

// Square's stock at the site's location (#267: every sale and all
// stock live at North Foster Farm), for the catalog's variations.
// -> { [variationId]: quantity } for those Square counts, which may
// be below 0 after a sale at the market; a variation Square doesn't
// count is left out. Null where there is no production catalog to ask:
// a fake, no Square keys, or the sandbox, whose item library has
// other ids. A read takes at most STOCK_MS, so a slow Square costs the
// page its counts, never its load.
export const STOCK_MS = 1500;
export const STOCK_PAGES = 4;

export const inventoryCounts = async (variationIds, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  deadline,
} = {}) => {
  if (isFake(env)) return fake.inventoryCounts();
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) return null;

  const base = settings(env);

  if (!base.catalog || !variationIds.length) return null;

  const end = Date.now() + STOCK_MS;
  const cfg = { ...base, deadline: deadline ? Math.min(deadline, end) : end };
  const counts = {};
  let cursor;

  for (let page = 0; page < STOCK_PAGES; page++) {
    const data = await call(cfg, "/v2/inventory/counts/batch-retrieve", {
      catalog_object_ids: variationIds,
      location_ids: [cfg.locationId],
      states: ["IN_STOCK"],
      limit: 1000,
      cursor,
    }, fetchImpl);

    for (const c of data.counts || []) {
      const n = Number(c.quantity);

      if (c.location_id !== cfg.locationId || !Number.isFinite(n)) continue;
      counts[c.catalog_object_id] = Math.trunc(n);
    }
    cursor = data.cursor;
    if (!cursor) break;
  }

  return counts;
};

// Every Square customer under one email, moved to another, for
// `bin/nff customers rename` (#238). -> the ids found; with `apply`
// false nothing is written.
export const renameCustomerEmail = async (from, to, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  apply = false,
} = {}) => {
  if (isFake(env)) return fake.renameCustomerEmail(from, to, { env, apply });

  const cfg = settings(env);
  const found = await call(cfg, "/v2/customers/search", {
    query: { filter: { email_address: { exact: from } } },
    limit: 10,
  }, fetchImpl);
  const ids = (found.customers || []).map((c) => c.id);

  if (apply) {
    for (const id of ids) {
      await call(cfg, `/v2/customers/${id}`, { email_address: to },
        fetchImpl, "PUT");
    }
  }

  return ids;
};

// Every location on the account, closed ones too: a sale at the market
// is at another location than the site's. -> ids, the site's first.
const allLocations = async (cfg, fetchImpl) => {
  const data = await call(cfg, "/v2/locations", null, fetchImpl, "GET");
  const ids = (data.locations || []).map((l) => l.id)
    .filter((id) => id && id !== cfg.locationId);

  return [cfg.locationId, ...ids];
};

// SearchOrders takes up to this many locations at a time.
const SEARCH_LOCATIONS = 10;

// A customer's orders at any of the account's locations, by any
// channel: whether one took money (`paid`), and whether one was made
// after `since` and may be paying right now (`recent`). The check
// before a profile is deleted (#236), so a sale at the market counts.
// -> { paid, recent }
export const customerOrders = async (customerId, { since }, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) => {
  if (isFake(env)) return fake.customerOrders();

  const cfg = settings(env);
  const locations = await allLocations(cfg, fetchImpl);
  let recent = false;

  for (let i = 0; i < locations.length; i += SEARCH_LOCATIONS) {
    let cursor;

    do {
      const data = await call(cfg, "/v2/orders/search", {
        location_ids: locations.slice(i, i + SEARCH_LOCATIONS),
        limit: 100,
        cursor,
        query: {
          filter: { customer_filter: { customer_ids: [customerId] } },
        },
      }, fetchImpl);

      for (const o of data.orders || []) {
        if ((o.tenders || []).length || o.state === "COMPLETED") {
          return { paid: true, recent };
        }
        if (Date.parse(o.created_at) > since.getTime()) recent = true;
      }
      cursor = data.cursor;
    } while (cursor);
  }

  return { paid: false, recent };
};
