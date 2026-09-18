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
import { json, readJson, retry } from "./lib/http.mjs";
import { createOrderAndInvoice } from "./lib/square.mjs";

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

  const result = validateOrder(payload, { index, terms, now });

  if (!result.ok) {
    return json(result.status, {
      errors: result.errors,
      dates: result.dates || undefined,
    });
  }

  const order = {
    id: orderId(key, now),
    submittedAt: now.toISOString(),
    status: "submitted",
    ...result.order,
    meta: {
      formVersion: catalog.version,
      userAgent: String(req.headers.get("user-agent") || "").slice(0, 200),
      referrer: String(req.headers.get("referer") || "").slice(0, 200),
      idempotencyKey: key,
    },
  };

  if (order.flags.totalMismatch) {
    console.warn(JSON.stringify({
      event: "order.total_mismatch",
      id: order.id,
      claimed: payload.claimedTotal,
      computed: order.totals.total,
    }));
  }

  try {
    const square_ = await retry(() => square(order, key), { sleep });

    console.info(JSON.stringify({
      event: "order.created", order, square: square_,
    }));

    return json(200, {
      orderId: order.id,
      invoiceUrl: square_.invoiceUrl,
      invoiceNumber: square_.invoiceNumber,
      totals: order.totals,
      fulfilment: order.fulfilment,
      lines: order.lines,
      customer: { name: order.customer.name, email: order.customer.email },
    });
  } catch (error) {
    const retryable = !!(error && error.retryable);

    console.error(JSON.stringify({
      event: "order.failed",
      retryable,
      error: String(error && error.message),
      detail: error && error.detail,
      order,
    }));

    return json(retryable ? 503 : 502, {
      retryable,
      orderId: order.id,
      message: retryable
        ? "We couldn't reach our payment provider. Your order is saved on " +
          "this device and will be retried."
        : "Something went wrong creating your invoice.",
    });
  }
};

export default async (req, context) =>
  handle(req, { ip: context && context.ip });

export const config = {
  path: "/api/orders",
  method: "POST",
};
