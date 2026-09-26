// POST /api/orders: validate, recompute every figure, revalidate the
// date, then take the payment and record the order (lib/checkout.mjs).
// Nothing is recorded until the money is in.
//
// The body is the order plus `payment`:
//   { method: "card" | "applepay" | "googlepay" | "cashapp",
//     sourceId, verificationToken? }           one request, paid
//   { method: "venmo", stage: "create" }       -> { paypalOrderId }
//   { method: "venmo", stage: "capture", paypalOrderId }   paid
// and `attempt`, counted up by the page after a decline so the next
// try gets fresh idempotency keys.
//
// Responses the client acts on:
//   200 paid (or, for Venmo's first stage, the PayPal order)
//   402 declined: { declined, code, message }, try another way
//   409 stale date, with a fresh list
//   422 validation errors, or a total that no longer matches
//   503 transient failure, safe to retry     502 permanent
//   429 too many tries from one address      204 dropped (honeypot)

import { createHash } from "node:crypto";

import catalog from "../../data/catalog.json" with { type: "json" };
import terms from "../../data/delivery.json" with { type: "json" };
import discountCodes from "../../data/discount-codes.json" with {
  type: "json",
};
import { indexCatalog } from "../../assets/scripts/order/lib/catalog.mjs";
import { validateOrder } from "../../assets/scripts/order/lib/validate.mjs";
import { parts } from "../../assets/scripts/order/lib/zoned.mjs";
import { sessionFrom } from "./lib/auth.mjs";
import {
  METHODS, finishVenmo, payWithSquare, startVenmo,
} from "./lib/checkout.mjs";
import { json, readJson } from "./lib/http.mjs";
import { alert, count } from "./lib/health.mjs";
import { log, withLog } from "./lib/log.mjs";
import { sendMail } from "./lib/mail.mjs";
import { DECLINE_MESSAGES as PAYPAL_DECLINES } from "./lib/paypal.mjs";
import { paymentsOf } from "./lib/records.mjs";
import { DECLINE_MESSAGES as SQUARE_DECLINES } from "./lib/square.mjs";
import { checkLines } from "./lib/stock.mjs";
import { deployContext, stores as defaultStores } from "./lib/store.mjs";

const index = indexCatalog(catalog);

const KEY = /^[A-Za-z0-9-]{16,64}$/;
const MAX_ATTEMPT = 50;

// Per-instance, best effort. Enough to blunt a runaway script.
const RATE = { windowMs: 10 * 60_000, max: 12 };
const hits = new Map();

const rateLimited = (ip, now) => {
  if (!ip) return false;

  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);

  recent.push(now);
  hits.set(ip, recent);

  return recent.length > RATE.max;
};

// Off production, a request carrying the staging token as X-Staging-Token
// skips the limit, so the QA suite and a person testing by hand can share
// one address. Without the header staging keeps the limit, so it can
// still be tested; in production the header means nothing.
const exempt = (req, env) => {
  const context = deployContext(env);

  return !!env.STAGING_TOKEN && !!context && context !== "production" &&
    req.headers.get("x-staging-token") === env.STAGING_TOKEN;
};

// Human-readable, and the same for every retry of one submission.
export const orderId = (key, now) => {
  const p = parts(now, terms.timeZone);
  const yymm = `${String(p.year).slice(2)}${String(p.month).padStart(2, "0")}`;
  const hash = createHash("sha256").update(key).digest("hex");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let tail = "";

  for (let i = 0; i < 4; i++) {
    tail += alphabet[parseInt(hash.slice(i * 2, i * 2 + 2), 16) % 32];
  }

  return `NFF-${yymm}-${tail}`;
};

// What the page shows once the order is paid: the payment just taken.
const paidResponse = (order) => {
  const p = paymentsOf(order).at(-1) || {};

  return json(200, {
    orderId: order.id,
    status: order.status,
    totals: order.totals,
    fulfilment: order.fulfilment,
    lines: order.lines,
    customer: {
      firstName: order.customer.firstName || "",
      name: order.customer.name,
      email: order.customer.email,
    },
    payment: {
      via: p.via,
      method: p.method,
      brand: p.brand || null,
      last4: p.last4 || null,
      wallet: p.wallet || null,
      receiptUrl: p.receiptUrl || null,
    },
  });
};

export const handle = async (req, {
  stores = defaultStores(),
  mail = sendMail,
  env = process.env,
  now = new Date(),
  ip = "",
  square,
  paypal,
  fetchImpl,
  sleep,
} = {}) => {
  const payload = await readJson(req);

  if (!payload || typeof payload !== "object") {
    return json(400, { errors: { body: "Expected a JSON body." } });
  }
  if (payload.website) return new Response(null, { status: 204 });
  // A customer can reach the limit through a run of declines, so it is
  // said plainly: a silent answer here read as a placed order.
  if (!exempt(req, env) && rateLimited(ip, now.getTime())) {
    return new Response(JSON.stringify({
      message: "There have been too many tries from here. Wait a few " +
        "minutes and try again; your order is saved on this page.",
    }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(RATE.windowMs / 1000),
      },
    });
  }

  const key = String(payload.idempotencyKey || "");

  if (!KEY.test(key)) {
    return json(422, { errors: { idempotencyKey: "Missing submission key." } });
  }

  const attempt = Number.isInteger(payload.attempt)
    && payload.attempt >= 1 && payload.attempt <= MAX_ATTEMPT
    ? payload.attempt
    : 1;
  const payment = payload.payment && typeof payload.payment === "object"
    ? payload.payment
    : {};
  const method = String(payment.method || "");

  if (!METHODS[method]) {
    return json(422, { errors: { payment: "Choose how to pay." } });
  }

  // A signed-in customer's discount group comes from their record,
  // never from the payload.
  const session = await sessionFrom(stores, req, { now });
  const group = session && session.customer
    ? session.customer.discountGroup || null
    : null;
  const result = validateOrder(payload, {
    index, terms, now, group, codes: discountCodes.codes,
  });

  if (!result.ok) {
    return json(result.status, {
      errors: result.errors,
      dates: result.dates || undefined,
    });
  }

  // The catalog said it was in stock at build time; the count says
  // whether it still is. Field errors, like the validator's, plus the
  // fresh availability so the page can bring the cart into line.
  const stock = await checkLines(stores, result.order.lines);

  if (!stock.ok) {
    return json(422, { errors: stock.errors, stock: stock.items });
  }

  // The customer authorised the figure on their screen. If ours
  // differs (a price changed under them, a group they did not know
  // of) they see the new total and decide again; nothing is charged.
  if (result.order.flags.totalMismatch) {
    log.warn({
      event: "order.total_mismatch",
      id: orderId(key, now),
      claimed: payload.claimedTotal,
      computed: result.order.totals.total,
    });

    return json(422, {
      errors: {
        total: "The total changed while you were on this page. Check " +
          "it and pay again.",
      },
      totals: result.order.totals,
    });
  }

  // Only an on-farm window waits for the farm's agreement; the other
  // methods are born agreed (see records.mjs).
  const fulfilmentMethod = result.order.fulfilment.method;
  const order = {
    id: orderId(key, now),
    submittedAt: now.toISOString(),
    ...result.order,
    fulfilment: {
      ...result.order.fulfilment,
      state: fulfilmentMethod === "onfarm" ? "requested" : "agreed",
    },
    meta: {
      formVersion: catalog.version,
      userAgent: String(req.headers.get("user-agent") || "").slice(0, 200),
      referrer: String(req.headers.get("referer") || "").slice(0, 200),
      idempotencyKey: key,
      attempt,
    },
  };
  const options = { env, mail, now, fetchImpl, sleep, square, paypal };

  try {
    if (method === "venmo") {
      const stage = String(payment.stage || "");

      if (stage === "create") {
        const { paypalOrderId } = await startVenmo(stores, order, {
          key, attempt,
        }, options);

        return json(200, { orderId: order.id, paypalOrderId });
      }
      if (stage === "capture") {
        const paypalOrderId = String(payment.paypalOrderId || "");

        if (!paypalOrderId) {
          return json(422, {
            errors: { payment: "Missing the PayPal order." },
          });
        }

        return paidResponse(await finishVenmo(stores, order, {
          key, attempt, paypalOrderId,
        }, options));
      }

      return json(422, { errors: { payment: "Which Venmo step?" } });
    }

    const sourceId = String(payment.sourceId || "");

    if (!sourceId) {
      return json(422, { errors: { payment: "Enter your card details." } });
    }

    return paidResponse(await payWithSquare(stores, order, {
      key, attempt, method, sourceId,
      verificationToken: payment.verificationToken
        ? String(payment.verificationToken)
        : undefined,
    }, options));
  } catch (error) {
    const retryable = !!(error && error.retryable);
    const declined = !!(error && error.declined);
    const code = (error && error.code) || null;

    if (declined) {
      log.info({
        event: "payment.declined", id: order.id, method, code, attempt,
      });
      await count(stores, "declined", now);

      return json(402, {
        declined: true,
        code,
        message: SQUARE_DECLINES[code] || PAYPAL_DECLINES[code]
          || "The payment didn't go through. Try another way to pay.",
      });
    }
    if (error && error.name === "CheckoutError") {
      return json(409, { errors: { payment: error.message }, code });
    }

    log.error({
      event: "order.failed",
      retryable,
      error: String(error && error.message),
      detail: error && error.detail,
      order,
    });
    // The customer's page retries a retryable failure and shows the
    // failure card otherwise; either way the farm hears now.
    await alert(stores, "order.create_failed", {
      id: order.id,
      retryable,
      method: order.fulfilment.method,
      payment: method,
      total: order.totals.total,
      error: String(error && error.message),
      detail: error && error.detail ? JSON.stringify(error.detail).slice(0, 500)
        : null,
    }, { env, mail, now });

    // Outside production the answer carries the processor's own
    // error, so a sandbox failure can be read from the response.
    const sandbox = env.SQUARE_ENV !== "production";

    return json(retryable ? 503 : 502, {
      retryable,
      orderId: order.id,
      message: retryable
        ? "We couldn't reach our payment provider. Your order is saved on " +
          "this device and will be retried."
        : "Something went wrong taking your payment.",
      detail: sandbox
        ? { error: String(error.message), processor: error.detail }
        : undefined,
    });
  }
};

export default withLog(async (req, context) =>
  handle(req, { ip: context && context.ip }));

export const config = {
  path: "/api/orders",
  method: "POST",
};
