import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SquareError, buildOrder, cancelOrder, clientConfig, createOrder,
  createPayment, dashboardUrl, e164, getPayment, refundPayment, settings,
} from "../netlify/functions/lib/square.mjs";

const env = {
  SQUARE_ACCESS_TOKEN: "tok",
  SQUARE_LOCATION_ID: "LOC",
  SQUARE_ENV: "sandbox",
};
const cfg = settings(env);
const KEY = "0123456789abcdef0123456789abcdef";

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

const completed = (extra = {}) => ({
  payment: {
    id: "PAY-1", status: "COMPLETED", receipt_url: "https://sq/receipt",
    card_details: { card: { card_brand: "VISA", last_4: "4242" } },
    ...extra,
  },
});

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

describe("clientConfig", () => {
  it("is null until the application id is set", () => {
    assert.equal(clientConfig(env), null);
    assert.equal(clientConfig({ SQUARE_APPLICATION_ID: "app" }), null,
      "the location is needed too");
  });

  it("names the SDK for the right Square", () => {
    const sandbox = clientConfig({ ...env, SQUARE_APPLICATION_ID: "sb-app" });

    assert.deepEqual(sandbox, {
      applicationId: "sb-app",
      locationId: "LOC",
      env: "sandbox",
      sdkUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
    });

    const live = clientConfig({
      ...env, SQUARE_ENV: "production", SQUARE_APPLICATION_ID: "sq-app",
    });

    assert.equal(live.env, "production");
    assert.equal(live.sdkUrl, "https://web.squarecdn.com/v1/square.js");
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

  it("splits the outside-area fee onto its own line", () => {
    const o = buildOrder(order({
      fulfilment: { method: "delivery", date: "2026-10-08", onfarm: null,
        delivery: { address1: "1 Main St", address2: "", town: "Coventry",
          zip: "02816", cooler: "Porch", notes: "", zipStatus: "unlisted" } },
      totals: {
        subtotal: 6000, discountTier: 50, discountAmount: 500,
        deliveryFee: 800, areaFee: 300, total: 6300,
      },
    }), "CUST", cfg);

    assert.deepEqual(
      o.service_charges.map((c) => [c.name, c.amount_money.amount]),
      [["Delivery fee", 500], ["Outside-area fee", 300]]
    );
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

describe("createOrder", () => {
  it("searches, creates the customer and the order with derived keys",
    async () => {
      const { impl, calls } = fakeFetch({
        "/v2/customers/search": { customers: [] },
        "/v2/customers": { customer: { id: "CUST" } },
        "/v2/orders": { order: { id: "SQO" } },
      });
      const out = await createOrder(order(), KEY, { env, fetchImpl: impl });

      assert.deepEqual(out, { squareOrderId: "SQO", customerId: "CUST" });
      assert.deepEqual(calls.map((c) => c.path), [
        "/v2/customers/search", "/v2/customers", "/v2/orders",
      ]);
      assert.deepEqual(calls[0].body.query.filter.email_address,
        { exact: "pat@example.com" });
      assert.equal(calls[1].body.idempotency_key, `${KEY}-customer`);
      assert.equal(calls[1].body.given_name, "Pat");
      assert.equal(calls[1].body.family_name, "Example");
      assert.equal(calls[2].body.idempotency_key, `${KEY}-order`);
      assert.equal(calls[2].body.order.customer_id, "CUST");
      assert.equal(calls[2].body.order.reference_id, "NFF-2610-ABCD");
      assert.equal(calls[0].headers["Square-Version"], "2026-09-16");
      assert.equal(calls[0].headers.Authorization, "Bearer tok");
    });

  it("reuses an existing customer", async () => {
    const { impl, calls } = fakeFetch({
      "/v2/customers/search": { customers: [{ id: "OLD" }] },
      "/v2/orders": { order: { id: "SQO" } },
    });
    const out = await createOrder(order(), KEY, { env, fetchImpl: impl });

    assert.equal(out.customerId, "OLD");
    assert.ok(!calls.some((c) => c.path === "/v2/customers"));
    assert.equal(calls[1].body.order.customer_id, "OLD");
  });

  it("marks 5xx and network failures retryable and 4xx not", async () => {
    const boom = fakeFetch({
      "/v2/customers/search": () => new Response("{}", { status: 503 }),
    });

    await assert.rejects(
      createOrder(order(), KEY, { env, fetchImpl: boom.impl }),
      (e) => e instanceof SquareError && e.retryable === true
    );

    const bad = fakeFetch({
      "/v2/customers/search": () => new Response(
        JSON.stringify({ errors: [{ code: "BAD" }] }), { status: 400 }
      ),
    });

    await assert.rejects(
      createOrder(order(), KEY, { env, fetchImpl: bad.impl }),
      (e) => e.retryable === false && e.declined === false
        && e.code === "BAD" && e.detail[0].code === "BAD"
    );

    const offline = async () => { throw new TypeError("fetch failed"); };

    await assert.rejects(
      createOrder(order(), KEY, { env, fetchImpl: offline }),
      (e) => e.retryable === true
    );
  });
});

describe("createPayment", () => {
  const source = { sourceId: "cnon:card-nonce" };
  const args = (extra = {}) => ({
    order: order(), squareOrderId: "SQO", customerId: "CUST", key: KEY,
    source, ...extra,
  });

  it("charges the order's total against the order, with a derived key",
    async () => {
      const { impl, calls } = fakeFetch({ "/v2/payments": completed() });
      const out = await createPayment(args(), { env, fetchImpl: impl });

      assert.deepEqual(out, {
        squarePaymentId: "PAY-1",
        status: "COMPLETED",
        receiptUrl: "https://sq/receipt",
        brand: "VISA",
        last4: "4242",
        wallet: null,
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, "POST");
      assert.deepEqual(calls[0].body, {
        idempotency_key: `${KEY}-payment`,
        amount_money: { amount: 5500, currency: "USD" },
        order_id: "SQO",
        location_id: "LOC",
        customer_id: "CUST",
        buyer_email_address: "pat@example.com",
        reference_id: "NFF-2610-ABCD",
        note: "North Foster Farm order NFF-2610-ABCD",
        source_id: "cnon:card-nonce",
      });
    });

  it("passes the verification token only when given", async () => {
    const { impl, calls } = fakeFetch({ "/v2/payments": completed() });

    await createPayment(args({
      source: { ...source, verificationToken: "verf:1" },
    }), { env, fetchImpl: impl });
    assert.equal(calls[0].body.verification_token, "verf:1");
  });

  it("records money that came another way as an external tender",
    async () => {
      const { impl, calls } = fakeFetch({
        "/v2/payments": completed({ card_details: undefined }),
      });
      const out = await createPayment(args({
        source: { external: { source: "Venmo", sourceId: "CAP-1" } },
      }), { env, fetchImpl: impl });

      assert.equal(calls[0].body.source_id, "EXTERNAL");
      assert.deepEqual(calls[0].body.external_details, {
        type: "SOCIAL", source: "Venmo", source_id: "CAP-1",
      });
      assert.equal(calls[0].body.verification_token, undefined);
      assert.equal(out.brand, null);
      assert.equal(out.last4, null);
    });

  it("keeps the wallet's name when a wallet paid", async () => {
    const { impl } = fakeFetch({
      "/v2/payments": completed({
        wallet_details: { brand: "CASH_APP", status: "CAPTURED" },
      }),
    });
    const out = await createPayment(args(), { env, fetchImpl: impl });

    assert.equal(out.wallet, "CASH_APP");
  });

  it("says a declined card was declined, with Square's code", async () => {
    const { impl } = fakeFetch({
      "/v2/payments": () => new Response(
        JSON.stringify({ errors: [{
          category: "PAYMENT_METHOD_ERROR", code: "CARD_DECLINED",
        }] }), { status: 402 }
      ),
    });

    await assert.rejects(
      createPayment(args(), { env, fetchImpl: impl }),
      (e) => e instanceof SquareError && e.declined === true
        && e.code === "CARD_DECLINED" && e.retryable === false
        && e.status === 402
    );
  });

  it("is retryable on a temporary error, not declined", async () => {
    const { impl } = fakeFetch({
      "/v2/payments": () => new Response(
        JSON.stringify({ errors: [{ code: "TEMPORARY_ERROR" }] }),
        { status: 400 }
      ),
    });

    await assert.rejects(
      createPayment(args(), { env, fetchImpl: impl }),
      (e) => e.retryable === true && e.declined === false
        && e.code === "TEMPORARY_ERROR"
    );
  });

  it("treats a payment that did not complete as declined", async () => {
    const { impl } = fakeFetch({
      "/v2/payments": completed({ status: "FAILED" }),
    });

    await assert.rejects(
      createPayment(args(), { env, fetchImpl: impl }),
      (e) => e.declined === true && e.code === "FAILED"
    );

    const empty = fakeFetch({ "/v2/payments": {} });

    await assert.rejects(
      createPayment(args(), { env, fetchImpl: empty.impl }),
      (e) => e.declined === true && e.code === "UNKNOWN"
    );
  });

  it("takes an approved payment as good", async () => {
    const { impl } = fakeFetch({
      "/v2/payments": completed({ status: "APPROVED" }),
    });
    const out = await createPayment(args(), { env, fetchImpl: impl });

    assert.equal(out.status, "APPROVED");
  });
});

describe("cancelOrder", () => {
  const answers = (state) => ({
    "/v2/orders/SQO": (n) => new Response(JSON.stringify(n === 1
      ? { order: { id: "SQO", state, version: 3 } }
      : { order: { id: "SQO", state: "CANCELED", version: 4 } })),
  });

  it("reads the version, then cancels", async () => {
    const { impl, calls } = fakeFetch(answers("OPEN"));
    const out = await cancelOrder("SQO", { env, fetchImpl: impl });

    assert.deepEqual(out, { id: "SQO", cancelled: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[1].method, "PUT");
    assert.deepEqual(calls[1].body, {
      order: { location_id: "LOC", version: 3, state: "CANCELED" },
    });
  });

  it("leaves an order that is no longer open alone", async () => {
    const { impl, calls } = fakeFetch(answers("COMPLETED"));
    const out = await cancelOrder("SQO", { env, fetchImpl: impl });

    assert.equal(out.cancelled, false);
    assert.equal(calls.length, 1);
  });
});

describe("refundPayment", () => {
  it("posts the refund with a derived key and a trimmed reason",
    async () => {
      const { impl, calls } = fakeFetch({
        "/v2/refunds": { refund: {
          id: "REF-1", status: "PENDING",
          amount_money: { amount: 1200, currency: "USD" },
        } },
      });
      const out = await refundPayment({
        squarePaymentId: "PAY-1", amount: 1200, key: "refund-x",
        reason: "x".repeat(200),
      }, { env, fetchImpl: impl });

      assert.deepEqual(out, {
        squareRefundId: "REF-1", status: "PENDING", amount: 1200,
      });
      assert.equal(calls[0].path, "/v2/refunds");
      assert.equal(calls[0].body.idempotency_key, "refund-x-refund");
      assert.equal(calls[0].body.payment_id, "PAY-1");
      assert.deepEqual(calls[0].body.amount_money,
        { amount: 1200, currency: "USD" });
      assert.equal(calls[0].body.reason.length, 192);
    });

  it("sends no reason when there is none", async () => {
    const { impl, calls } = fakeFetch({ "/v2/refunds": { refund: {} } });
    const out = await refundPayment({
      squarePaymentId: "PAY-1", amount: 500, key: "k",
    }, { env, fetchImpl: impl });

    assert.equal(calls[0].body.reason, undefined);
    assert.equal(out.amount, 500, "the asked amount when Square is quiet");
  });
});

describe("getPayment", () => {
  it("reads one payment back in the record's shape", async () => {
    const { impl, calls } = fakeFetch({ "/v2/payments/PAY-1": completed() });
    const out = await getPayment("PAY-1", { env, fetchImpl: impl });

    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].body, null);
    assert.equal(out.squarePaymentId, "PAY-1");
    assert.equal(out.last4, "4242");
  });
});

describe("dashboardUrl", () => {
  const square = { squareOrderId: "SO-1", customerId: "CUST" };

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

  it("is nothing without a Square order", () => {
    assert.equal(dashboardUrl({}, env), "");
    assert.equal(dashboardUrl({ invoiceId: "INV-1" }, env), "",
      "an invoice-era record without an order id links nowhere");
    assert.equal(dashboardUrl(null, env), "");
  });
});
