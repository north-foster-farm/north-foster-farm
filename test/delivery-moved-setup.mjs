// Shared by the tests for moving a week's delivery day (#640):
// test/delivery-moved.criteria.mjs and test/delivery-default.test.mjs.
// Not a test file itself. Orders are placed through POST /api/orders
// with the farm's schedule in `env`, as the function reads it on
// every request; the fakes are those of test/group-delivery-stored.mjs.

import assert from "node:assert/strict";

import { scheduleFor } from "../bin/dev-schedule.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { editOrder } from "../netlify/functions/lib/edit.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle as placeOrder } from "../netlify/functions/orders.mjs";

export const TZ = "America/New_York";
export const ny = (iso, h = 9, m = 0) => instant(iso, h, m, TZ);

// Every weekday of November and December 2026 with its two windows,
// and a pickup line for every series' occurrence: a schedule the
// check passes, before any delivery line is added.
export const BASE = scheduleFor("2026-11-01", "2026-12-31");

// The schedule with these lines added, as `bin/nff schedule set`
// would leave PICKUP_SCHEDULE.
export const withLines = (...lines) => [BASE, ...lines].join("\n");

// Thanksgiving week: delivery Wednesday the 25th, not the 26th.
export const THANKSGIVING = withLines("2026-11-25 delivery");
// An ordinary week moved: Wednesday December 9 for Thursday the 10th.
export const DECEMBER = withLines("2026-12-09 delivery");

export const EMAIL = "pat@example.com";
export const SKU = "NFF-CHK-WHL-35-39";
export const WINDOW = "between 10:00 AM and 4:00 PM";

export const envWith = (schedule) => ({
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  URL: "https://x",
  PICKUP_SCHEDULE: schedule,
});

export const square = {
  createOrder: async () => ({ squareOrderId: "SQO", customerId: "CUST" }),
  createChangeOrder: async () => ({ squareOrderId: "SQC", customerId: "CUST" }),
  createPayment: async (args) => ({
    squarePaymentId: `PAY-${args.squareOrderId}`, status: "COMPLETED",
    receiptUrl: null, brand: "VISA", last4: "4242", wallet: null,
  }),
  payZeroOrder: async (id) => ({ squareOrderId: id }),
  updateFulfillment: async () => {},
  cancelFulfillment: async () => {},
  refundPayment: async () => ({ squareRefundId: "R", status: "COMPLETED" }),
};

const quiet = { sleep: async () => {} };

// A mail function that keeps what it is given.
export const outbox = () => {
  const sent = [];
  const mail = async (m) => {
    sent.push(m);

    return { id: `m${sent.length}`, driver: "test" };
  };

  return { sent, mail };
};

// The words of a message, text and HTML together.
export const words = (m) => `${m.subject || ""}\n${m.text || ""}\n${
  m.html || ""}`;

let keys = 0;

// A delivery of two chickens to 1 Main St on `date`, paid by card,
// placed at `now` against `schedule`. `extra` joins the payload (a
// group code). -> { res, data, sent, stores }
export const place = async ({
  date, now, schedule, stores = testStores(), extra = {},
}) => {
  const { sent, mail } = outbox();

  keys += 1;

  const res = await placeOrder(new Request("http://x/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: `0f7c1e3a-9c9b-4b3a-8e9d-${
        String(keys).padStart(12, "0")}`,
      payment: { method: "card", sourceId: "cnon:tok" },
      customer: {
        firstName: "Pat", lastName: "Example", email: EMAIL,
        phone: "401-555-0100", contact: "text",
      },
      lines: [{ sku: SKU, qty: 2 }],
      fulfilment: {
        method: "delivery", date,
        delivery: { address1: "1 Main St", town: "Foster", zip: "02825",
          cooler: "Porch" },
      },
      // $60 less the $5 tier, plus the $5 fee.
      claimedTotal: 6000,
      ...extra,
    }),
  }), { stores, square, now, env: envWith(schedule), mail, ...quiet });

  return { res, data: await res.json(), sent, stores };
};

// `place`, which must succeed. -> { id, sent, stores }
export const placed = async (args) => {
  const { res, data, sent, stores } = await place(args);

  assert.equal(res.status, 200, JSON.stringify(data));

  return { id: data.orderId, sent, stores };
};

// The customer's own edit, asked once without a total to learn it, as
// the order page learns it, then sent. -> { result, sent }
export const edit = async (stores, id, body, { now, schedule }) => {
  const { sent, mail } = outbox();
  const opts = { now, env: envWith(schedule), square, mail, ...quiet };
  const first = await editOrder(stores, { email: EMAIL }, id, body, opts);

  if (first.ok || !first.errors || !first.errors.total) {
    return { result: first, sent };
  }

  return {
    result: await editOrder(stores, { email: EMAIL }, id, {
      ...body, claimedTotal: first.totals.total,
    }, opts),
    sent,
  };
};
