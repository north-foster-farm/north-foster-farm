// PAYPAL_ENV=fake (lib/fake.mjs): every call paypal.mjs makes to
// PayPal, answered here with the same arguments and the same shapes,
// and no request sent. Stateless: the order id carries its amount, so
// the capture can report it as PayPal would, and ids come from the
// request ids, so a retry returns what the first try made.
//
// Each answer is PayPal's own, recorded in James's live Venmo test of
// 2026-11-21 (test/fixtures/paypal/, #708) and read through the same
// code that reads PayPal's: the payer, the times and the statuses are
// the recording's. Only what the fake makes itself is put in: its ids,
// which keep their FAKE- prefixes, and the amount from the request.
// The recordings are read when asked for, by what they recorded, so a
// changed fixture changes the answer.
//
// The stub SDK (assets/scripts/fake/paypal.js) approves at once. The
// server never hears of an approval before the capture, so an order
// here reads as the recorded order nobody approved until it is
// captured: the jobs leave an abandoned fake checkout to the sweep.

import { fakeId, recordedWhere } from "./fake.mjs";
import { PayPalError, captureOf, orderOf, refundOf } from "./paypal.mjs";

const PREFIX = "FAKE-PP";

const amountOf = (paypalOrderId) => {
  const m = String(paypalOrderId).match(/^FAKE-PP-(\d+)-/);

  return m ? Number(m[1]) : null;
};

const ok = (status) => status >= 200 && status < 300;
const is = (method, path) => (r) => r.request.method === method
  && path.test(r.request.path);

// What each answer is recorded from.
const RECORDED = {
  capture: ["paid capture", (r) =>
    is("POST", /^\/v2\/checkout\/orders\/[^/]+\/capture$/)(r)
    && ok(r.status) && r.response.status === "COMPLETED"],
  read: ["order read nobody approved", (r) =>
    is("GET", /^\/v2\/checkout\/orders\/[^/]+$/)(r)
    && r.status === 200 && r.response.status === "CREATED"],
  refund: ["refund", (r) =>
    is("POST", /^\/v2\/payments\/captures\/[^/]+\/refund$/)(r)
    && ok(r.status)],
};

const answer = (kind) => recordedWhere("paypal", ...RECORDED[kind])
  .response;

const notFound = (path) => new PayPalError(`PayPal 404 on ${path}`, {
  status: 404, code: "RESOURCE_NOT_FOUND",
});

export const createOrder = async (order, key) => ({
  paypalOrderId: fakeId(`${PREFIX}-${order.totals.total}`, key),
});

export const getOrder = async (paypalOrderId) => {
  if (amountOf(paypalOrderId) === null) {
    throw notFound(`/v2/checkout/orders/${paypalOrderId}`);
  }

  return orderOf(answer("read"));
};

export const captureOrder = async (paypalOrderId) => {
  const amount = amountOf(paypalOrderId);

  if (amount === null) {
    throw notFound(`/v2/checkout/orders/${paypalOrderId}/capture`);
  }

  return {
    ...captureOf(answer("capture")),
    paypalOrderId,
    paypalCaptureId: fakeId("FAKE-CAPTURE", paypalOrderId),
    amount,
  };
};

export const refundCapture = async ({ amount, key }) => ({
  ...refundOf(answer("refund"), amount),
  paypalRefundId: fakeId("FAKE-PP-REFUND", key),
  amount,
});

// No refund read was recorded (test/fixtures/README.md), so this one
// answer is still the fake's own.
export const getRefund = async (paypalRefundId) => ({
  paypalRefundId, status: "COMPLETED", amount: 0,
});

// PayPal cannot reach this machine, and a fake must never take a
// forged event for a real one: nothing verifies.
export const verifyWebhook = async () => false;

// A webhook delivery as PayPal posts it, for a test to hand to
// paypal-webhook.mjs: the recorded delivery of `eventType`, with ours
// put in where the webhook reads it. -> { headers, body }, the headers
// a plain object and the body the JSON string.
//
// The recording's placeholders for the order, the PayPal order, the
// capture and the refund are swapped for the values given, wherever
// they appear (ids, links, notes), and every amount is scaled to
// `amount` (cents), its fee kept in proportion.
export const webhookDelivery = (eventType, {
  orderId, paypalOrderId, paypalCaptureId, paypalRefundId, amount,
} = {}) => {
  const { request } = recordedWhere("paypal", `${eventType} delivery`,
    (r) => r.request.path === "/api/paypal/webhook"
      && !!r.request.body && r.request.body.event_type === eventType);
  const event = request.body;
  const resource = event.resource || {};
  const up = (resource.links || []).find((link) => link.rel === "up");
  const related = ((resource.supplementary_data || {}).related_ids || {});
  const refunded = event.resource_type === "refund";
  const swaps = [
    [resource.custom_id, orderId],
    [refunded ? null : resource.id, paypalCaptureId],
    [refunded ? resource.id : null, paypalRefundId],
    [related.order_id, paypalOrderId],
    [refunded && up ? up.href.split("/").pop() : null, paypalCaptureId],
  ].filter(([was, now]) => was && now !== undefined && now !== null);
  const swap = (text) => swaps.reduce((s, [was, now]) => s.replace(
    new RegExp(`\\b${was.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"),
    String(now)
  ), text);
  const walk = (node) => {
    if (typeof node === "string") return swap(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node)
        .map(([key, value]) => [key, walk(value)]));
    }

    return node;
  };
  const body = walk(event);

  if (Number.isInteger(amount) && resource.amount) {
    rescale(body.resource, cents(resource.amount.value), amount);
  }

  return { headers: { ...request.headers }, body: JSON.stringify(body) };
};

const cents = (value) => Math.round(Number(value) * 100);
const money = (n) => (n / 100).toFixed(2);

// Every { currency_code, value } under `node`, scaled from `from` cents
// to `to`; a breakdown's net then made its gross less its fee.
const rescale = (node, from, to) => {
  if (!node || typeof node !== "object") return;
  if (typeof node.value === "string" && "currency_code" in node) {
    node.value = money(from ? Math.round(cents(node.value) * to / from) : to);

    return;
  }
  Object.values(node).forEach((child) => rescale(child, from, to));
  const { gross_amount: gross, paypal_fee: fee, net_amount: net } = node;

  if (gross && fee && net) {
    net.value = money(cents(gross.value) - cents(fee.value));
  }
};
