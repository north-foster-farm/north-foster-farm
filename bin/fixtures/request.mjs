#!/usr/bin/env node
// The requests our own Square code sends, for bin/fixtures/record to send
// to the sandbox. It runs the real functions in lib/square.mjs against a
// stub fetch that records what they ask for and answers with the least
// that keeps them going, so the recorded request is the code's, never a
// copy of it. Nothing here reaches the network.
//
//   request.mjs <call> '<json of arguments>'
//
// Prints a JSON array of { method, path, body } in the order sent. A
// customer or order id the call needs from an earlier response comes in
// through the arguments; ids the stub invents are written as
// __CUSTOMER_ID__ for the recorder to swap for the real one.

import { pathToFileURL } from "node:url";

import {
  buildChangeOrder, cancelFulfillment, cancelOrder, completeOrder,
  createChangeOrder, createOrder, createPayment, customerOrders,
  deleteCustomer, findPaid, inventoryCounts, payZeroOrder, refundPayment,
  productionStock, renameCustomerEmail, searchOpenOrders, updateFulfillment,
} from "../../netlify/functions/lib/square.mjs";
import { sendMail } from "../../netlify/functions/lib/mail.mjs";
import { testStores } from "../../netlify/functions/lib/store.mjs";

const day = (days) => new Date(Date.now() + days * 864e5)
  .toISOString().slice(0, 10);

// The order record the order function hands square.mjs (see the
// `order` helper in test/square.test.mjs). `kind` picks the shape.
export const sampleOrder = ({ kind = "pickup", email, variationId }) => ({
  id: "NFF-2610-FIXT",
  customer: {
    name: "Pat Fixture",
    email,
    phone: "401-555-0100",
    contact: "text",
  },
  fulfilment: kind === "delivery"
    ? {
      method: "delivery",
      date: day(7),
      onfarm: null,
      delivery: {
        address1: "1 Example Way", address2: "", town: "Providence",
        state: "RI", zip: "02903", cooler: "yes", gate: "", notes: "",
      },
    }
    : {
      method: "onfarm",
      date: day(7),
      onfarm: { window: "morning" },
      delivery: null,
    },
  lines: [{
    sku: "NFF-CHK-WHL-35-39",
    label: "Whole Chicken, 3.5 - 3.9 lbs",
    name: "Whole Chicken (per each), 3.5 - 3.9 lbs",
    unitPrice: 30,
    qty: 2,
    lineTotal: 60,
    squareVariationId: kind === "catalog" ? variationId : null,
  }],
  totals: kind === "delivery"
    ? {
      subtotal: 6000, discountTier: 0, discountAmount: 0,
      deliveryFee: 500, total: 6500,
    }
    : {
      subtotal: 6000, discountTier: 50, discountAmount: 500,
      deliveryFee: 0, total: 5500,
    },
  notes: "",
  source: "Fixture recorder",
  flags: { zipUnlisted: false, totalMismatch: false },
});

// A fetch that records and answers. `current` is the Square order a GET
// of /v2/orders/{id} returns, so the functions that read an order before
// changing it build their change from a real one.
const stub = (current, found = false) => {
  const sent = [];
  const impl = async (url, init) => {
    const { pathname } = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    let answer = {};

    if (method === "GET" && /^\/v2\/orders\//.test(pathname)) {
      answer = { order: current };
    } else if (method === "GET" && pathname === "/v2/locations") {
      answer = { locations: [] };
    } else if (pathname === "/v2/customers/search") {
      answer = found ? { customers: [{ id: "__CUSTOMER_ID__" }] } : {};
    } else if (pathname === "/v2/customers" && method === "POST") {
      answer = { customer: { id: "__CUSTOMER_ID__" } };
    } else if (pathname === "/v2/orders" && method === "POST") {
      answer = { order: { id: "__ORDER_ID__" } };
    } else if (pathname === "/v2/payments") {
      answer = { payment: { id: "__PAYMENT_ID__", status: "COMPLETED" } };
    } else if (pathname === "/emails") {
      answer = { id: "__EMAIL_ID__" };
    } else if (pathname === "/v2/refunds") {
      answer = { refund: { id: "__REFUND_ID__", status: "PENDING" } };
    }

    if (!(method === "GET" && /^\/v2\/orders\//.test(pathname))) {
      const headers = { ...init.headers };

      delete headers.Authorization;

      sent.push({
        method, host: new URL(url).host, path: pathname, headers, body,
      });
    }

    return new Response(JSON.stringify(answer), { status: 200 });
  };

  return { impl, sent };
};

const CALLS = {
  "create-order": (a, o) => createOrder(
    sampleOrder(a), a.key, o
  ),
  "create-change-order": (a, o) => createChangeOrder(
    sampleOrder(a), a.change || { added: [], difference: 0 }, a.key, o
  ),
  "pay-zero": (a, o) => payZeroOrder(a.orderId, a.key, o),
  "create-payment": (a, o) => createPayment({
    order: sampleOrder(a),
    squareOrderId: a.orderId,
    customerId: a.customerId,
    key: a.key,
    amount: a.amount,
    source: a.source,
  }, o),
  "refund": (a, o) => refundPayment({
    squarePaymentId: a.paymentId, amount: a.amount, key: a.key,
    reason: a.reason,
  }, o),
  "update-fulfillment": (a, o) => updateFulfillment(
    a.orderId, sampleOrder(a), o
  ),
  "cancel-fulfillment": (a, o) => cancelFulfillment(a.orderId, o),
  "complete-order": (a, o) => completeOrder(a.orderId, o),
  "cancel-order": (a, o) => cancelOrder(a.orderId, o),
  "find-paid": (a, o) => findPaid(sampleOrder(a), o),
  "search-open": (a, o) => searchOpenOrders({
    before: new Date(), max: 100,
  }, o),
  "customer-orders": (a, o) => customerOrders(a.customerId, {
    since: new Date(Date.now() - 36e5),
  }, o),
  "inventory-counts": (a, o) => inventoryCounts(a.ids, o),
  "catalog-search": (a, o) => productionStock(["NFF-CHK-EGG-LG"], {
    ...o,
    env: {
      STOCK_SOURCE_TOKEN: "stub", STOCK_SOURCE_LOCATION_ID: a.locationId,
    },
  }),
  // The one Resend send: mail.mjs builds the request, MAIL_DRIVER=resend
  // and the production context let it through, the stub keeps it local.
  "resend-send": (a, o) => sendMail(a.message, {
    env: {
      MAIL_DRIVER: "resend", RESEND_API_KEY: "stub", MAIL_FROM: a.from,
      MAIL_REPLY_TO: a.replyTo, SITE_CONTEXT: "production",
    },
    fetchImpl: o.fetchImpl,
    stores: testStores(),
  }),
  "delete-customer": (a, o) => deleteCustomer(a.customerId, o),
  "rename-customer": (a, o) => renameCustomerEmail(
    a.from, a.to, { ...o, apply: true }
  ),
};

// The change order's own body, which createChangeOrder wraps; exported
// for the unit test that holds the recorder to the code.
export { buildChangeOrder };

const main = async () => {
  const [, , call, json = "{}"] = process.argv;
  const run = CALLS[call];

  if (!run) {
    console.error(`Unknown call "${call}". Known: ${Object.keys(CALLS)}`);
    process.exit(2);
  }

  const args = JSON.parse(json);
  const net = stub(args.current || {}, !!args.found);
  // "production" turns on catalog lines and stock reads; the stub
  // keeps it off the wire.
  const catalog = args.kind === "catalog" || call === "inventory-counts";
  const env = {
    SQUARE_ENV: catalog ? "production" : "sandbox",
    SQUARE_ACCESS_TOKEN: "stub",
    SQUARE_LOCATION_ID: args.locationId,
  };

  await run(args, { env, fetchImpl: net.impl });
  console.log(JSON.stringify(net.sent));
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
