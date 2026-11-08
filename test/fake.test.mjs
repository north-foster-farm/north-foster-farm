// The fake payment drivers (#265): each real call has a fake with the
// same arguments and the same answer, a fake works only in local
// development, and with the development sample's settings an order
// is paid by card and by Venmo without a single request leaving.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import * as fakePaypal from "../netlify/functions/lib/fake-paypal.mjs";
import * as fakeSquare from "../netlify/functions/lib/fake-square.mjs";
import { FAKE_SDK_URLS } from "../netlify/functions/lib/fake.mjs";
import * as paypal from "../netlify/functions/lib/paypal.mjs";
import { getOrder } from "../netlify/functions/lib/records.mjs";
import * as square from "../netlify/functions/lib/square.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle as checkoutConfig } from "../netlify/functions/checkout.mjs";
import { handle as orders, orderId } from "../netlify/functions/orders.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { reply } from "./recorded.mjs";
import { MORNING, SCHEDULE } from "./schedule-fixture.mjs";

const MAILS = {
  FARM_NOTIFICATIONS_EMAIL: "farm@example.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@example.com",
};

const KEY = "0123456789abcdef0123456789abcdef";
const DEV = { SITE_CONTEXT: "dev", SQUARE_ENV: "fake", PAYPAL_ENV: "fake" };

// The real modules' calls to their vendor are their async exports.
const calls = (mod) => Object.keys(mod)
  .filter((name) => mod[name] && mod[name].constructor
    && mod[name].constructor.name === "AsyncFunction")
  .sort();

// Nothing may reach the network while a fake answers.
const offline = () => {
  const seen = [];
  const impl = async (url) => {
    seen.push(String(url));
    throw new Error(`fetch ${url}`);
  };

  return { seen, impl };
};

const order = () => ({
  id: "NFF-2610-ABCD",
  customer: {
    name: "Pat Example", email: "pat@example.com", phone: "401-555-0100",
    contact: "text",
  },
  fulfilment: {
    method: "onfarm", date: "2026-10-07", onfarm: { window: "morning" },
    delivery: null,
  },
  lines: [{
    sku: "NFF-CHK-WHL-35-39", label: "Whole Chicken",
    name: "Whole Chicken", unitPrice: 30, qty: 2, lineTotal: 60,
    squareVariationId: null,
  }],
  totals: {
    subtotal: 6000, discountAmount: 500, discountLabel: "Bulk", total: 5500,
    deliveryFee: 0, areaFee: 0,
  },
  notes: "",
  source: "",
  flags: { zipUnlisted: false },
});

// Square as the real module meets it: its recorded answers
// (test/fixtures/square), one per path.
const squareHost = () => async (url, { method }) => {
  const path = new URL(url).pathname;
  const answers = [
    [/^\/v2\/customers\/search$/, "customers-search-found"],
    [/^\/v2\/customers\//, method === "DELETE"
      ? "customer-delete" : "customer-update"],
    [/^\/v2\/orders\/[^/]+\/pay$/, "order-pay-zero"],
    [/^\/v2\/orders\/search$/, "orders-search-customer"],
    [/^\/v2\/locations$/, "locations-list"],
    [/^\/v2\/orders\/[^/]+$/, method === "GET"
      ? "order-get-line-discount" : "order-update-fulfillment"],
    [/^\/v2\/orders$/, "order-create-pickup"],
    [/^\/v2\/payments\/[^/]+$/, "payment-get"],
    [/^\/v2\/payments$/, "payment-card-ok"],
    [/^\/v2\/refunds$/, "refund-create"],
    [/^\/v2\/refunds\//, "refund-get"],
    [/^\/v2\/catalog\/search$/, "catalog-search"],
    [/^\/v2\/inventory\//, "inventory-counts"],
  ];
  const [, name] = answers.find(([re]) => re.test(path));

  return reply("square", name);
};

const paypalHost = () => async (url) => {
  const path = new URL(url).pathname;
  const captured = {
    id: "PPO", status: "COMPLETED", update_time: "2026-10-06T13:00:00Z",
    purchase_units: [{
      payments: {
        captures: [{
          id: "CAP", status: "COMPLETED", amount: { value: "55.00" },
        }],
      },
    }],
    payer: {
      email_address: "pat@venmo", name: { given_name: "Pat", surname: "E" },
    },
  };
  const answers = [
    [/^\/v1\/oauth2\/token$/, { access_token: "T", expires_in: 3600 }],
    [/^\/v1\/notifications\//, { verification_status: "SUCCESS" }],
    [/^\/v2\/checkout\/orders$/, { id: "PPO" }],
    [/^\/v2\/checkout\/orders\//, captured],
    [/^\/v2\/payments\/captures\//, {
      id: "RF", status: "COMPLETED", amount: { value: "1.00" },
    }],
    [/^\/v2\/payments\/refunds\//, {
      id: "RF", status: "COMPLETED", amount: { value: "1.00" },
    }],
  ];
  const [, data] = answers.find(([re]) => re.test(path));

  return new Response(JSON.stringify(data), { status: 200 });
};

// Every call, with its arguments; `ids` are the vendor's own, or the
// fake's.
const SQUARE_CALLS = {
  createOrder: (o) => square.createOrder(order(), KEY, o),
  createChangeOrder: (o) => square.createChangeOrder(order(), {
    added: [], difference: 500, carries: false,
  }, `${KEY}-change`, o),
  payZeroOrder: (o) => square.payZeroOrder("O1", KEY, o),
  createPayment: (o) => square.createPayment({
    order: order(), squareOrderId: "O1", customerId: "C1", key: KEY,
    source: { sourceId: "fake:ok-1" },
  }, o),
  getOrder: (o) => square.getOrder("O1", o),
  updateFulfillment: (o) => square.updateFulfillment("O1", order(), o),
  cancelFulfillment: (o) => square.cancelFulfillment("O1", o),
  cancelOrder: (o) => square.cancelOrder("O1", o),
  completeOrder: (o) => square.completeOrder("O1", o),
  refundPayment: (o) => square.refundPayment({
    squarePaymentId: "P1", amount: 100, key: KEY, reason: "test",
  }, o),
  getPayment: (o) => square.getPayment("P1", o),
  getRefund: (o) => square.getRefund("R1", o),
  inventoryCounts: (o) => square.inventoryCounts(["V1"], o),
  findPaid: (o) => square.findPaid(order(), o),
  deleteCustomer: (o) => square.deleteCustomer("C1", o),
  customerOrders: (o) => square.customerOrders("C1", {
    since: new Date(),
  }, o),
  searchOpenOrders: (o) => square.searchOpenOrders({
    before: new Date(),
  }, o),
  renameCustomerEmail: (o) => square.renameCustomerEmail(
    "a@example.com", "b@example.com", o
  ),
};

const PAYPAL_CALLS = {
  createOrder: (o) => paypal.createOrder(order(), KEY, o),
  getOrder: async (o, id) => paypal.getOrder(await id(o), o),
  captureOrder: async (o, id) => paypal.captureOrder(await id(o), KEY, o),
  refundCapture: (o) => paypal.refundCapture({
    paypalCaptureId: "CAP", amount: 100, key: KEY, note: "test",
  }, o),
  getRefund: (o) => paypal.getRefund("RF", o),
  verifyWebhook: (o) => paypal.verifyWebhook(
    new Headers({ "paypal-transmission-sig": "sig" }), "{}", o
  ),
};

const shape = (value) => {
  if (Array.isArray(value)) return "array";
  if (value && typeof value === "object") return Object.keys(value).sort();

  return typeof value;
};

describe("the fakes match the real calls", () => {
  for (const [name, real, fake, table] of [
    ["square", square, fakeSquare, SQUARE_CALLS],
    ["paypal", paypal, fakePaypal, PAYPAL_CALLS],
  ]) {
    it(`${name}: every call has a fake, and nothing else does`, () => {
      assert.deepEqual(calls(fake), calls(real));
      assert.deepEqual(Object.keys(table).sort(), calls(real),
        "every call is checked below");
    });

    it(`${name}: no fake takes an argument the real call lacks`, () => {
      for (const call of calls(real)) {
        assert.ok(fake[call].length <= real[call].length, call);
      }
    });
  }

  it("square: each fake answers in the real call's shape, offline",
    async () => {
      const live = { SQUARE_ENV: "sandbox", SQUARE_ACCESS_TOKEN: "t",
        SQUARE_LOCATION_ID: "L" };

      for (const [call, run] of Object.entries(SQUARE_CALLS)) {
        const net = offline();
        const want = await run({ env: live, fetchImpl: squareHost() });
        const got = await run({ env: DEV, fetchImpl: net.impl });

        assert.deepEqual(shape(got), shape(want), call);
        assert.deepEqual(net.seen, [], call);
      }
    });

  it("paypal: each fake answers in the real call's shape, offline",
    async () => {
      const live = { PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: "id",
        PAYPAL_CLIENT_SECRET: "s", PAYPAL_WEBHOOK_ID: "WH" };
      const id = async (o) => (await paypal.createOrder(order(), KEY, o))
        .paypalOrderId;

      for (const [call, run] of Object.entries(PAYPAL_CALLS)) {
        const net = offline();

        paypal.forgetTokens();

        const want = await run({ env: live, fetchImpl: paypalHost() }, id);
        const got = await run({ env: DEV, fetchImpl: net.impl }, id);

        assert.deepEqual(shape(got), shape(want), call);
        if (want && want.capture) {
          assert.deepEqual(shape(got.capture || want.capture),
            shape(want.capture), call);
        }
        assert.deepEqual(net.seen, [], call);
      }
    });

  it("square: a fake card token can be declined with Square's code",
    async () => {
      await assert.rejects(square.createPayment({
        order: order(), squareOrderId: "O1", customerId: "C1", key: KEY,
        source: { sourceId: "fake:CARD_DECLINED" },
      }, { env: DEV }), (e) => e instanceof square.SquareError
        && e.declined && e.code === "CARD_DECLINED");
    });

  it("square: the sandbox's test nonces decline as the sandbox does",
    async () => {
      for (const [nonce, code] of [
        ["cnon:card-nonce-declined", "GENERIC_DECLINE"],
        ["cnon:card-nonce-rejected-cvv", "CVV_FAILURE"],
      ]) {
        await assert.rejects(square.createPayment({
          order: order(), squareOrderId: "O1", customerId: "C1", key: KEY,
          source: { sourceId: nonce },
        }, { env: DEV }), (e) => e instanceof square.SquareError
          && e.declined && e.code === code, nonce);
      }
    });

  it("paypal: a fake capture reports the amount the order was made for",
    async () => {
      const { paypalOrderId } = await paypal.createOrder(order(), KEY,
        { env: DEV });
      const capture = await paypal.captureOrder(paypalOrderId, KEY,
        { env: DEV });

      assert.equal(capture.amount, 5500);
      assert.equal(capture.status, "COMPLETED");
      assert.equal((await paypal.captureOrder(paypalOrderId, KEY,
        { env: DEV })).paypalCaptureId, capture.paypalCaptureId,
      "a retry gets the same capture");
    });

  it("paypal: a fake never verifies a webhook", async () => {
    assert.equal(await paypal.verifyWebhook(new Headers(), "{}",
      { env: DEV }), false);
  });
});

describe("a fake only in local development", () => {
  // No context counts as production, as everywhere else.
  const elsewhere = ["production", "", "branch-deploy", "deploy-preview"];

  for (const context of elsewhere) {
    const env = { ...DEV, SITE_CONTEXT: context,
      SQUARE_ACCESS_TOKEN: "t", SQUARE_LOCATION_ID: "L",
      SQUARE_APPLICATION_ID: "A", PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: "s", PAYPAL_WEBHOOK_ID: "WH" };
    const label = context || "no context";

    it(`refuses every Square call: ${label}`, async () => {
      for (const [call, run] of Object.entries(SQUARE_CALLS)) {
        const net = offline();

        await assert.rejects(run({ env, fetchImpl: net.impl }),
          (e) => e instanceof square.SquareError
            && e.code === "FAKE_REFUSED", call);
        assert.deepEqual(net.seen, [], call);
      }
      assert.throws(() => square.settings(env), /local development only/);
    });

    it(`refuses every PayPal call: ${label}`, async () => {
      const id = async () => "FAKE-PP-5500-0123456789ABCDEF";

      for (const [call, run] of Object.entries(PAYPAL_CALLS)) {
        const net = offline();

        await assert.rejects(run({ env, fetchImpl: net.impl }, id),
          (e) => e instanceof paypal.PayPalError
            && e.code === "FAKE_REFUSED", call);
        assert.deepEqual(net.seen, [], call);
      }
      assert.equal(paypal.configured(env), false);
    });

    it(`offers the page no payment: ${label}`, async () => {
      const res = await checkoutConfig(new Request("http://x"), { env });

      assert.deepEqual(await res.json(), { square: null, paypal: null });
    });
  }

  it("refuses a dev context on a deployed function (Lambda)", async () => {
    const lambda = { ...DEV, AWS_LAMBDA_FUNCTION_NAME: "orders" };
    const net = offline();

    await assert.rejects(SQUARE_CALLS.createOrder({
      env: lambda, fetchImpl: net.impl,
    }), (e) => e.code === "FAKE_REFUSED");
    await assert.rejects(PAYPAL_CALLS.createOrder({
      env: lambda, fetchImpl: net.impl,
    }), (e) => e.code === "FAKE_REFUSED");
    assert.deepEqual(net.seen, []);

    const res = await checkoutConfig(new Request("http://x"),
      { env: lambda });

    assert.deepEqual(await res.json(), { square: null, paypal: null });
    assert.equal(paypal.configured(lambda), false);
  });

  it("allows it under netlify dev, which may set the Lambda name too",
    async () => {
      const local = {
        ...DEV, NETLIFY_DEV: "true", AWS_LAMBDA_FUNCTION_NAME: "orders",
      };
      const out = await SQUARE_CALLS.createOrder({ env: local });

      assert.match(out.squareOrderId, /^FAKE-ORDER-/);
    });

  it("offers the page the stub SDKs in development", async () => {
    const res = await checkoutConfig(new Request("http://x"),
      { env: { ...DEV, VENMO_HIDDEN: "1" } });
    const { square: sq, paypal: pp } = await res.json();

    assert.equal(sq.env, "fake");
    assert.equal(sq.sdkUrl, FAKE_SDK_URLS.square);
    assert.ok(sq.applicationId && sq.locationId);
    assert.equal(pp.env, "fake");
    assert.equal(pp.sdkUrl, FAKE_SDK_URLS.paypal);
    assert.equal(pp.hidden, true, "VENMO_HIDDEN still applies");
    assert.equal(paypal.configured(DEV), true);
  });

  it("gives no Square dashboard link for a fake order", () => {
    assert.equal(square.dashboardUrl({ squareOrderId: "O1" }, DEV), "");
  });
});

describe("the development sample takes orders offline", () => {
  const now = instant("2026-10-06", 9, 0, "America/New_York");
  const out = mkdtempSync(join(tmpdir(), "nff-fake-"));
  // What .env.development.sample holds that the order path reads:
  // fake payments, mail to files, Resend's keys with fake values and
  // no audience, so the sync stays off (#267).
  const env = {
    ...DEV,
    SQUARE_APPLICATION_ID: "fake-application",
    SQUARE_LOCATION_ID: "FAKE-LOCATION",
    PAYPAL_CLIENT_ID: "fake-client",
    MAIL_DRIVER: "file",
    MAIL_OUT: out,
    MAIL_FROM: "North Foster Farm <orders@example.com>",
    ...MAILS,
    RESEND_API_KEY: "re_fake_development",
    RESEND_WEBHOOK_SECRET: "whsec_ZmFrZQ==",
    PICKUP_SCHEDULE: SCHEDULE,
  };
  const realFetch = globalThis.fetch;
  let net;

  beforeEach(() => {
    net = offline();
    globalThis.fetch = net.impl;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  after(() => rmSync(out, { recursive: true, force: true }));

  const body = (key, payment) => ({
    idempotencyKey: key,
    attempt: 1,
    customer: {
      firstName: "Pat", lastName: "Example", email: "pat@example.com",
      phone: "401-555-0100", contact: "call",
    },
    lines: [{ sku: "NFF-CHK-WHL-35-39", qty: 2 }],
    fulfilment: {
      method: "onfarm", date: "2026-10-07", onfarm: { window: MORNING },
    },
    claimedTotal: 5500,
    payment,
  });
  const stores = testStores();
  const post = (payload) => orders(new Request("http://x/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }), { stores, env, now, sleep: async () => {} });

  it("pays by card", async () => {
    const key = "1f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f";
    const res = await post(body(key, {
      method: "card", sourceId: "fake:ok-1",
    }));
    const data = await res.json();

    assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.status, "paid");
    assert.equal(data.payment.via, "square");

    const saved = await getOrder(stores, orderId(key, now));

    assert.match(saved.square.squareOrderId, /^FAKE-ORDER-/);
    assert.match(saved.payments[0].squarePaymentId, /^FAKE-PAYMENT-/);
    assert.deepEqual(net.seen, []);
  });

  it("declines the stub's declined card", async () => {
    const key = "2f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f";
    const res = await post(body(key, {
      method: "card", sourceId: "fake:CARD_DECLINED",
    }));

    assert.equal(res.status, 402);
    assert.deepEqual(net.seen, []);
  });

  it("pays by Venmo", async () => {
    const key = "3f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f";
    const create = await post(body(key, { method: "venmo", stage: "create" }));
    const { paypalOrderId } = await create.json();

    assert.equal(create.status, 200);
    assert.match(paypalOrderId, /^FAKE-PP-5500-/);

    const res = await post(body(key, {
      method: "venmo", stage: "capture", paypalOrderId,
    }));
    const data = await res.json();

    assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.status, "paid");
    assert.equal(data.payment.via, "venmo");

    const saved = await getOrder(stores, orderId(key, now));

    assert.match(saved.payments[0].paypalCaptureId, /^FAKE-CAPTURE-/);
    assert.deepEqual(net.seen, []);
  });
});
