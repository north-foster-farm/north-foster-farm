// POST /api/orders: validate, recompute every figure, revalidate the
// date, then create the Square order and publish its invoice.
//
// Responses the client acts on:
//   200 success            409 stale date, with a fresh list
//   422 validation errors  503 transient failure, safe to retry
//   204 dropped silently (honeypot, rate limit)

import { createHash } from "node:crypto";

import catalog from "../../data/catalog.json" with { type: "json" };
import terms from "../../data/delivery.json" with { type: "json" };
import { indexCatalog } from "../../assets/scripts/order/lib/catalog.mjs";
import { validateOrder } from "../../assets/scripts/order/lib/validate.mjs";
import { parts } from "../../assets/scripts/order/lib/zoned.mjs";
import { sessionFrom } from "./lib/auth.mjs";
import { json, readJson, retry } from "./lib/http.mjs";
import { alert, mark, noteMail } from "./lib/health.mjs";
import { log, withLog } from "./lib/log.mjs";
import { mailConfigured, sendMail } from "./lib/mail.mjs";
import { notifyFarm } from "./lib/payments.mjs";
import {
  amendOrder, getOrder, saveOrder, touchCustomer,
} from "./lib/records.mjs";
import { mailLinks, orderUrlFor } from "./lib/site.mjs";
import { createOrderAndInvoice, dashboardUrl } from "./lib/square.mjs";
import { adjust, checkLines } from "./lib/stock.mjs";
import { stores as defaultStores } from "./lib/store.mjs";
import { completeYourOrder, farmOrderPlaced } from "./lib/templates.mjs";

const index = indexCatalog(catalog);

const KEY = /^[A-Za-z0-9-]{16,64}$/;

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

export const handle = async (req, {
  square = createOrderAndInvoice,
  stores = defaultStores(),
  mail = sendMail,
  env = process.env,
  now = new Date(),
  ip = "",
  sleep,
} = {}) => {
  const payload = await readJson(req);

  if (!payload || typeof payload !== "object") {
    return json(400, { errors: { body: "Expected a JSON body." } });
  }
  if (payload.website || rateLimited(ip, now.getTime())) {
    return new Response(null, { status: 204 });
  }

  const key = String(payload.idempotencyKey || "");

  if (!KEY.test(key)) {
    return json(422, { errors: { idempotencyKey: "Missing submission key." } });
  }

  // A signed-in customer's discount group comes from their record,
  // never from the payload.
  const session = await sessionFrom(stores, req, { now });
  const group = session && session.customer
    ? session.customer.discountGroup || null
    : null;
  const result = validateOrder(payload, { index, terms, now, group });

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

  // Only an on-farm window waits for the farm's agreement; the other
  // methods are born agreed (see records.mjs).
  const method = result.order.fulfilment.method;
  const order = {
    id: orderId(key, now),
    submittedAt: now.toISOString(),
    status: "submitted",
    ...result.order,
    fulfilment: {
      ...result.order.fulfilment,
      state: method === "onfarm" ? "requested" : "agreed",
    },
    meta: {
      formVersion: catalog.version,
      userAgent: String(req.headers.get("user-agent") || "").slice(0, 200),
      referrer: String(req.headers.get("referer") || "").slice(0, 200),
      idempotencyKey: key,
    },
  };

  if (order.flags.totalMismatch) {
    log.warn({
      event: "order.total_mismatch",
      id: order.id,
      claimed: payload.claimedTotal,
      computed: order.totals.total,
    });
  }

  try {
    // With the farm's own mail configured, our "complete your order"
    // email carries the pay link; otherwise Square emails the invoice.
    const ownMail = mailConfigured(env);
    const square_ = await retry(
      () => square(order, key, { emailInvoice: !ownMail }), { sleep }
    );

    // The record is the customer's copy: their order history, the
    // reminders and the account pages all read it. Square remains the
    // system of record for money.
    //
    // A retry of the same submission rebuilds the order from the
    // payload, which knows nothing of what the first attempt did, so
    // carry its record forward: nobody is emailed twice about one
    // order, and the history keeps the whole story.
    const first = await getOrder(stores, order.id);
    const saved = await saveOrder(stores, {
      ...order,
      square: square_,
      ...(first && first.emails ? { emails: first.emails } : {}),
      ...(first && first.history ? { history: first.history } : {}),
    }, now);

    await touchCustomer(stores, order.customer, now);
    await adjust(stores, order.lines, -1);
    await mark(stores, "order", { id: order.id }, now);

    log.info({
      event: "order.created", order, square: square_,
      persistent: stores.persistent,
    });

    // A mail failure never fails the order: the invoice exists and the
    // reminders will pick the order up.
    if (!(saved.emails && saved.emails.completeYourOrder)) {
      try {
        const sent = await mail({
          to: order.customer.email,
          idempotencyKey: `${key}-complete`,
          ...completeYourOrder(saved, {
            orderUrl: orderUrlFor(env, order.id), links: mailLinks(env),
          }),
        }, { env });

        await amendOrder(stores, order.id, {
          emails: {
            ...(saved.emails || {}),
            completeYourOrder: { at: now.toISOString(), ...sent },
          },
        }, "mail.completeYourOrder", now);
        await noteMail(stores, true, now);
      } catch (error) {
        const message = String(error && error.message);

        log.error({
          event: "mail.failed", template: "completeYourOrder", id: order.id,
          error: message, detail: error && error.detail,
        });
        await noteMail(stores, false, now, { error: message });
        await alert(stores, "mail.failed", {
          id: order.id, template: "completeYourOrder", error: message,
        }, { env, mail, now });
      }
    }

    // The farm's own notice. It never fails the order either.
    await notifyFarm(stores, saved, "farmOrderPlaced", farmOrderPlaced(saved, {
      squareUrl: dashboardUrl(square_, env), links: mailLinks(env),
    }), { mail, env, now });

    return json(200, {
      orderId: order.id,
      invoiceUrl: square_.invoiceUrl,
      invoiceNumber: square_.invoiceNumber,
      totals: order.totals,
      fulfilment: order.fulfilment,
      lines: order.lines,
      customer: {
        firstName: order.customer.firstName || "",
        name: order.customer.name,
        email: order.customer.email,
      },
    });
  } catch (error) {
    const retryable = !!(error && error.retryable);

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
      total: order.totals.total,
      error: String(error && error.message),
      detail: error && error.detail ? JSON.stringify(error.detail).slice(0, 500)
        : null,
    }, { env, mail, now });

    // Outside production the answer carries Square's own error, so a
    // sandbox failure can be read from the response.
    const sandbox = process.env.SQUARE_ENV !== "production";

    return json(retryable ? 503 : 502, {
      retryable,
      orderId: order.id,
      message: retryable
        ? "We couldn't reach our payment provider. Your order is saved on " +
          "this device and will be retried."
        : "Something went wrong creating your invoice.",
      detail: sandbox ? { error: String(error.message), square: error.detail }
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
