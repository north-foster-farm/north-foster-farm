// Orders placed through POST /api/orders directly, with Square's
// sandbox test nonces instead of the card iframe: fast setup for the
// specs that need a paid order to exist, and the only way to reach
// the answers a browser rarely sees (402, 409, 422, 204).
// docs/order-form.md has the payload and the answers.

import { randomUUID } from "node:crypto";

import { SKU } from "./order.mjs";

export const NONCE = {
  ok: "cnon:card-nonce-ok",
  declined: "cnon:card-nonce-declined",
};

// The first date offered for a method, from the live list.
export const firstDate = async (request, method) => {
  const dates = await (await request.get("/api/dates")).json();

  return dates[method][0].date;
};

// A valid on-farm order for one dozen eggs ($7), ready to send.
export const eggOrder = async (request, {
  email, nonce = NONCE.ok, claimedTotal = 700, qty = 1, extra = {},
} = {}) => ({
  customer: {
    firstName: "QA", lastName: "Api", email, phone: "", contact: "text",
    marketing: false,
  },
  lines: [{ sku: SKU.eggs, qty }],
  fulfilment: {
    method: "onfarm",
    date: await firstDate(request, "onfarm"),
    onfarm: { window: "morning" },
    delivery: {},
  },
  code: "",
  claimedTotal,
  website: "",
  idempotencyKey: randomUUID(),
  attempt: 1,
  payment: { method: "card", sourceId: nonce },
  ...extra,
});

// The order endpoint answers 429 past its rate limit: 12 requests per
// 10 minutes per address, per function instance, counted before
// anything else is checked. A whole run of the suite sends about ten.
// Only the honeypot is dropped silently (204).
export const RATE_LIMITED = "Answered 429: the order endpoint's rate " +
  "limit (12 per 10 minutes per IP) was hit. Wait ten minutes and run " +
  "again.";

// -> { status, body }. `limited` lets the rate-limit spec see its 429.
export const postOrder = async (request, payload, { limited = false } = {}) => {
  const res = await request.post("/api/orders", { data: payload });
  const text = await res.text();

  if (res.status() === 429 && !limited) throw new Error(RATE_LIMITED);

  return { status: res.status(), body: text ? JSON.parse(text) : null };
};
