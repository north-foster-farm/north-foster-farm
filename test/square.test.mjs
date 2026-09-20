import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SquareError, buildInvoice, buildOrder, closeBankTransfer,
  createOrderAndInvoice, dashboardUrl, e164, settings,
} from "../netlify/functions/lib/square.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const env = {
  SQUARE_ACCESS_TOKEN: "tok",
  SQUARE_LOCATION_ID: "LOC",
  SQUARE_ENV: "sandbox",
};
const cfg = settings(env);
const now = instant("2026-10-06", 9, 0, "America/New_York");

const order = (overrides = {}) => ({
  id: "NFF-2610-ABCD",
  customer: {
    name: "Pat Example",
    email: "pat@example.com",
    phone: "401-555-0100",
    contact: "text",
  },
  fulfilment: {
    method: "onfarm",
    date: "2026-10-07",
    onfarm: { window: "morning" },
    delivery: null,
  },
  lines: [{
    sku: "NFF-CHK-WHL-0350-0400",
    label: "Whole Chicken, 3.5 – 3.9 lbs",
    name: "Whole Chicken (per each), 3.5 – 3.9 lbs",
    unitPrice: 30,
    qty: 2,
    lineTotal: 60,
    squareVariationId: null,
  }],
  totals: {
    subtotal: 6000, discountTier: 50, discountAmount: 500,
    deliveryFee: 0, total: 5500,
  },
  notes: "",
  source: "Flyer",
  flags: { zipUnlisted: false, totalMismatch: false },
  ...overrides,
});

// A fetch stub that records calls and answers each path in turn.
const fakeFetch = (answers) => {
  const calls = [];
  const impl = async (url, init) => {
    const path = new URL(url).pathname;

    calls.push({
      path,
      method: init.method,
      body: init.body ? JSON.parse(init.body) : null,
      headers: init.headers,
    });
    const answer = answers[path];

    if (typeof answer === "function") return answer(calls.length);

    return new Response(JSON.stringify(answer || {}), { status: 200 });
  };

  return { impl, calls };
};

describe("settings", () => {
  it("fails fast without credentials", () => {
    assert.throws(() => settings({}), SquareError);
  });

  it("targets the sandbox unless told otherwise", () => {
    assert.match(cfg.host, /squareupsandbox/);
    assert.match(settings({ ...env, SQUARE_ENV: "production" }).host,
      /connect\.squareup\.com/);
  });
});

describe("e164", () => {
  it("normalises US numbers and drops the rest", () => {
    assert.equal(e164("(401) 555-0100"), "+14015550100");
    assert.equal(e164("1 401 555 0100"), "+14015550100");
    assert.equal(e164("555"), undefined);
  });
});

describe("buildOrder", () => {
  it("uses an ad hoc line while the variation id is null", () => {
    const o = buildOrder(order(), "CUST", cfg);

    assert.equal(o.location_id, "LOC");
    assert.equal(o.reference_id, "NFF-2610-ABCD");
    assert.deepEqual(o.line_items[0], {
      name: "Whole Chicken (per each), 3.5 – 3.9 lbs",
      quantity: "2",
      base_price_money: { amount: 3000, currency: "USD" },
    });
  });

  it("uses the catalog object in production once the id is set", () => {
    const o = order();

    o.lines[0].squareVariationId = "VAR1";

    const production = settings({ ...env, SQUARE_ENV: "production" });
    const built = buildOrder(o, "CUST", production);

    assert.deepEqual(built.line_items[0],
      { catalog_object_id: "VAR1", quantity: "2" });
  });

  it("sends ad hoc lines to the sandbox, whose library is its own", () => {
    const o = order();

    o.lines[0].squareVariationId = "VAR1";
    const built = buildOrder(o, "CUST", cfg);

    assert.equal(built.line_items[0].catalog_object_id, undefined);
    assert.equal(built.line_items[0].name, o.lines[0].name);
    assert.deepEqual(built.line_items[0].base_price_money,
      { amount: 3000, currency: "USD" });
  });

  it("carries the discount as an order-scope amount", () => {
    const o = buildOrder(order(), "CUST", cfg);

    assert.equal(o.discounts[0].amount_money.amount, 500);
    assert.equal(o.discounts[0].scope, "ORDER");
    assert.equal(o.service_charges, undefined);
  });

  it("schedules a morning on-farm pickup at 9:00 New York", () => {
    const o = buildOrder(order(), "CUST", cfg);
    const f = o.fulfillments[0];

    assert.equal(f.type, "PICKUP");
    assert.equal(f.pickup_details.pickup_at, "2026-10-07T13:00:00.000Z");
    assert.equal(f.pickup_details.recipient.phone_number, "+14015550100");
    assert.match(f.pickup_details.note, /prefers text/);
    assert.match(f.pickup_details.note, /morning pickup/);
  });

  it("builds a delivery fulfillment with fee and address", () => {
    const o = order({
      fulfilment: {
        method: "delivery",
        date: "2026-10-08",
        onfarm: null,
        delivery: {
          address1: "1 Main St",
          address2: "",
          town: "Foster",
          zip: "02825",
          gate: "1234",
          cooler: "Side porch",
          notes: "Dog in the yard",
          zipStatus: "approved",
        },
      },
      totals: {
        subtotal: 6000, discountTier: 50, discountAmount: 500,
        deliveryFee: 500, total: 6000,
      },
    });
    const built = buildOrder(o, "CUST", cfg);
    const f = built.fulfillments[0];

    assert.equal(built.service_charges[0].amount_money.amount, 500);
    assert.equal(f.type, "DELIVERY");
    assert.equal(f.delivery_details.deliver_at, "2026-10-08T14:00:00.000Z");
    assert.equal(f.delivery_details.recipient.address.postal_code, "02825");
    assert.equal(
      f.delivery_details.recipient.address.administrative_district_level_1,
      "RI"
    );
    assert.match(f.delivery_details.note, /gate: 1234/);
    assert.match(f.delivery_details.note, /Dog in the yard/);
  });
});

describe("buildInvoice", () => {
  it("is due the day before, never earlier than today", () => {
    const inv = buildInvoice(order(), "SQO", "CUST", cfg, now);

    assert.equal(inv.order_id, "SQO");
    assert.equal(inv.payment_requests[0].due_date, "2026-10-06");
    assert.equal(inv.delivery_method, "EMAIL");
    assert.equal(inv.accepted_payment_methods.card, true);
    assert.match(inv.description, /On-farm pickup on Wednesday, October 7/);
  });

  it("is due the day before a later date", () => {
    const o = order();

    o.fulfilment.date = "2026-10-15";
    const inv = buildInvoice(o, "SQO", "CUST", cfg, now);

    assert.equal(inv.payment_requests[0].due_date, "2026-10-14");
  });

  it("offers bank transfer only when it can clear in time", () => {
    // `now` is Tuesday 6 October. Business days after it: the 7th is
    // one, Monday the 12th is four, Tuesday the 13th is five.
    const offered = (date) => {
      const o = order();

      o.fulfilment.date = date;

      return buildInvoice(o, "SQO", "CUST", cfg, now)
        .accepted_payment_methods.bank_account;
    };

    assert.equal(offered("2026-10-07"), false);
    assert.equal(offered("2026-10-12"), false);
    assert.equal(offered("2026-10-13"), true);
  });
});

describe("closeBankTransfer", () => {
  const answers = (status) => ({
    "/v2/invoices/INV": (n) => new Response(JSON.stringify(n === 1
      ? { invoice: { id: "INV", status, version: 3 } }
      : { invoice: { id: "INV", status, version: 4 } })),
  });

  it("reads the version, then edits the methods to card only", async () => {
    const { impl, calls } = fakeFetch(answers("UNPAID"));
    const out = await closeBankTransfer("INV", { env, fetchImpl: impl });

    assert.deepEqual(out, { id: "INV", status: "UNPAID", closed: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[1].method, "PUT");
    assert.equal(calls[1].body.invoice.version, 3);
    assert.equal(calls[1].body.invoice.accepted_payment_methods.card, true);
    assert.equal(
      calls[1].body.invoice.accepted_payment_methods.bank_account, false
    );
  });

  it("leaves an invoice that is no longer unpaid alone", async () => {
    const { impl, calls } = fakeFetch(answers("PAYMENT_PENDING"));
    const out = await closeBankTransfer("INV", { env, fetchImpl: impl });

    assert.equal(out.closed, false);
    assert.equal(calls.length, 1);
  });
});

describe("createOrderAndInvoice", () => {
  it("says whether the invoice offered bank transfer", async () => {
    const { impl } = fakeFetch({
      "/v2/customers/search": { customers: [{ id: "CUST" }] },
      "/v2/orders": { order: { id: "SQO" } },
      "/v2/invoices": { invoice: { id: "INV", version: 1 } },
      "/v2/invoices/INV/publish": { invoice: { id: "INV" } },
    });
    const farOut = order();

    farOut.fulfilment.date = "2026-10-13";
    const out = await createOrderAndInvoice(farOut, "key-1234567890123", {
      env, fetchImpl: impl, now,
    });

    assert.equal(out.bankTransfer, true);
  });

  it("searches, creates, drafts and publishes with derived keys", async () => {
    const { impl, calls } = fakeFetch({
      "/v2/customers/search": { customers: [] },
      "/v2/customers": { customer: { id: "CUST" } },
      "/v2/orders": { order: { id: "SQO" } },
      "/v2/invoices": { invoice: { id: "INV", version: 1 } },
      "/v2/invoices/INV/publish": {
        invoice: { id: "INV", invoice_number: "000123", public_url: "https://pay" },
      },
    });
    const out = await createOrderAndInvoice(order(), "key-1234567890123", {
      env, fetchImpl: impl, now,
    });

    assert.deepEqual(out, {
      squareOrderId: "SQO",
      invoiceId: "INV",
      invoiceNumber: "000123",
      invoiceUrl: "https://pay",
      bankTransfer: false,
    });
    assert.deepEqual(calls.map((c) => c.path), [
      "/v2/customers/search", "/v2/customers", "/v2/orders", "/v2/invoices",
      "/v2/invoices/INV/publish",
    ]);
    assert.equal(calls[1].body.idempotency_key, "key-1234567890123-customer");
    assert.equal(calls[2].body.idempotency_key, "key-1234567890123-order");
    assert.equal(calls[3].body.idempotency_key, "key-1234567890123-invoice");
    assert.equal(calls[4].body.idempotency_key, "key-1234567890123-publish");
    assert.equal(calls[4].body.version, 1);
    assert.equal(calls[0].headers["Square-Version"], "2026-09-16");
  });

  it("reuses an existing customer", async () => {
    const { impl, calls } = fakeFetch({
      "/v2/customers/search": { customers: [{ id: "OLD" }] },
      "/v2/orders": { order: { id: "SQO" } },
      "/v2/invoices": { invoice: { id: "INV", version: 3 } },
      "/v2/invoices/INV/publish": { invoice: { id: "INV" } },
    });

    await createOrderAndInvoice(order(), "key-1234567890123", {
      env, fetchImpl: impl, now,
    });
    assert.ok(!calls.some((c) => c.path === "/v2/customers"));
    assert.equal(calls[1].body.order.customer_id, "OLD");
  });

  it("marks 5xx and network failures retryable and 4xx not", async () => {
    const boom = fakeFetch({
      "/v2/customers/search": () => new Response("{}", { status: 503 }),
    });

    await assert.rejects(
      createOrderAndInvoice(order(), "key-1234567890123",
        { env, fetchImpl: boom.impl, now }),
      (e) => e instanceof SquareError && e.retryable === true
    );

    const bad = fakeFetch({
      "/v2/customers/search": () => new Response(
        JSON.stringify({ errors: [{ code: "BAD" }] }), { status: 400 }
      ),
    });

    await assert.rejects(
      createOrderAndInvoice(order(), "key-1234567890123",
        { env, fetchImpl: bad.impl, now }),
      (e) => e.retryable === false && e.detail[0].code === "BAD"
    );

    const offline = async () => { throw new TypeError("fetch failed"); };

    await assert.rejects(
      createOrderAndInvoice(order(), "key-1234567890123",
        { env, fetchImpl: offline, now }),
      (e) => e.retryable === true
    );
  });
});

describe("dashboardUrl", () => {
  const square = { squareOrderId: "SO-1", invoiceId: "INV-1" };

  it("points at the order, in the right Square", () => {
    assert.equal(
      dashboardUrl(square, { SQUARE_ENV: "production" }),
      "https://app.squareup.com/dashboard/orders/overview/SO-1"
    );
    assert.equal(
      dashboardUrl(square, env),
      "https://app.squareupsandbox.com/dashboard/orders/overview/SO-1"
    );
    assert.equal(dashboardUrl(square, {}).includes("sandbox"), true,
      "anything but production is the sandbox");
  });

  it("falls back to the invoice, then to nothing", () => {
    assert.equal(
      dashboardUrl({ invoiceId: "INV-1" }, env),
      "https://app.squareupsandbox.com/dashboard/invoices/INV-1"
    );
    assert.equal(dashboardUrl({}, env), "");
    assert.equal(dashboardUrl(null, env), "");
  });
});
