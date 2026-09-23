import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  DECLINE_MESSAGES, PayPalError, captureOrder, clientConfig, configured,
  createOrder, forgetTokens, getOrder, refundCapture, settings,
  verifyWebhook,
} from "../netlify/functions/lib/paypal.mjs";

const env = {
  PAYPAL_CLIENT_ID: "cid",
  PAYPAL_CLIENT_SECRET: "sec",
  PAYPAL_ENV: "sandbox",
  PAYPAL_WEBHOOK_ID: "WH-1",
};
const now = new Date("2026-10-06T13:00:00Z");
const KEY = "0123456789abcdef0123456789abcdef";

const order = () => ({
  id: "NFF-2610-ABCD",
  customer: { name: "Pat Example", email: "pat@example.com" },
  totals: { total: 5500 },
});

// A fetch stub that records calls and answers each path in turn.
const fakeFetch = (answers) => {
  const calls = [];
  const impl = async (url, init = {}) => {
    const path = new URL(url).pathname;

    calls.push({
      path,
      method: init.method || "GET",
      body: init.body && init.headers["Content-Type"] === "application/json"
        ? JSON.parse(init.body)
        : init.body || null,
      headers: init.headers,
    });
    const answer = answers[path];

    if (typeof answer === "function") return answer(calls.length);

    return new Response(JSON.stringify(answer || {}), { status: 200 });
  };

  return { impl, calls };
};

const token = { access_token: "tok", expires_in: 3600 };

const capturedOrder = (status = "COMPLETED") => ({
  id: "PPO",
  status: "COMPLETED",
  payer: {
    email_address: "pat@venmo", name: { given_name: "Pat", surname: "E" },
  },
  purchase_units: [{
    payments: {
      captures: [{ id: "CAP", status, amount: { value: "55.00" } }],
    },
  }],
});

const opts = (impl) => ({ env, fetchImpl: impl, now });

beforeEach(() => forgetTokens());

describe("settings", () => {
  it("knows when it is configured and fails fast otherwise", () => {
    assert.equal(configured({}), false);
    assert.equal(configured(env), true);
    assert.throws(() => settings({}), PayPalError);
    assert.match(settings(env).host, /api-m\.sandbox\.paypal\.com/);
    assert.match(settings({ ...env, PAYPAL_ENV: "live" }).host,
      /api-m\.paypal\.com/);
    assert.equal(settings(env).webhookId, "WH-1");
  });

  it("gives the page the SDK address, with Venmo on", () => {
    assert.equal(clientConfig({}), null);

    const c = clientConfig(env);
    const url = new URL(c.sdkUrl);

    assert.equal(c.clientId, "cid");
    assert.equal(c.env, "sandbox");
    assert.equal(url.origin + url.pathname, "https://www.paypal.com/sdk/js");
    assert.equal(url.searchParams.get("client-id"), "cid");
    assert.equal(url.searchParams.get("enable-funding"), "venmo");
    assert.equal(url.searchParams.get("intent"), "capture");
    assert.equal(url.searchParams.get("buyer-country"), "US");

    const live = new URL(clientConfig({ ...env, PAYPAL_ENV: "live" }).sdkUrl);

    assert.equal(live.searchParams.get("buyer-country"), null);
  });

  it("has a customer sentence for each decline", () => {
    for (const [code, text] of Object.entries(DECLINE_MESSAGES)) {
      assert.ok(text.length > 10, code);
    }
    assert.match(DECLINE_MESSAGES.INSTRUMENT_DECLINED, /declined/);
  });
});

describe("the token", () => {
  it("is fetched with the client credentials and kept", async () => {
    const { impl, calls } = fakeFetch({
      "/v1/oauth2/token": token,
      "/v2/checkout/orders": { id: "PPO" },
    });

    await createOrder(order(), KEY, opts(impl));
    await createOrder(order(), KEY, opts(impl));

    const tokens = calls.filter((c) => c.path === "/v1/oauth2/token");

    assert.equal(tokens.length, 1, "one token for two calls");
    assert.equal(tokens[0].method, "POST");
    assert.equal(tokens[0].headers.Authorization,
      `Basic ${Buffer.from("cid:sec").toString("base64")}`);
    assert.equal(tokens[0].body, "grant_type=client_credentials");
    assert.equal(calls[1].headers.Authorization, "Bearer tok");
  });

  it("is fetched again once it is about to expire", async () => {
    const { impl, calls } = fakeFetch({
      "/v1/oauth2/token": { access_token: "tok", expires_in: 30 },
      "/v2/checkout/orders": { id: "PPO" },
    });

    await createOrder(order(), KEY, opts(impl));
    await createOrder(order(), KEY, opts(impl));
    assert.equal(calls.filter((c) => c.path === "/v1/oauth2/token").length,
      2);
  });

  it("fails without one", async () => {
    const { impl } = fakeFetch({
      "/v1/oauth2/token": () => new Response("{}", { status: 401 }),
    });

    await assert.rejects(createOrder(order(), KEY, opts(impl)),
      (e) => e instanceof PayPalError && e.retryable === false);
  });
});

describe("createOrder", () => {
  it("asks for a capture of the total, named for the order", async () => {
    const { impl, calls } = fakeFetch({
      "/v1/oauth2/token": token,
      "/v2/checkout/orders": { id: "PPO", status: "CREATED" },
    });
    const out = await createOrder(order(), KEY, opts(impl));

    assert.deepEqual(out, { paypalOrderId: "PPO" });

    const call = calls.find((c) => c.path === "/v2/checkout/orders");
    const unit = call.body.purchase_units[0];

    assert.equal(call.method, "POST");
    assert.equal(call.headers["PayPal-Request-Id"], `${KEY}-create`);
    assert.equal(call.body.intent, "CAPTURE");
    assert.equal(call.body.purchase_units.length, 1);
    assert.equal(unit.reference_id, "NFF-2610-ABCD");
    assert.equal(unit.custom_id, "NFF-2610-ABCD");
    assert.deepEqual(unit.amount, { currency_code: "USD", value: "55.00" });
    assert.match(unit.description, /NFF-2610-ABCD/);
    assert.equal(call.body.application_context.shipping_preference,
      "NO_SHIPPING");
    assert.equal(call.body.application_context.brand_name,
      "North Foster Farm");
  });

  it("refuses an answer with no id", async () => {
    const { impl } = fakeFetch({
      "/v1/oauth2/token": token,
      "/v2/checkout/orders": {},
    });

    await assert.rejects(createOrder(order(), KEY, opts(impl)),
      /no order id/);
  });
});

describe("captureOrder", () => {
  it("returns the completed capture, the amount in cents and the payer",
    async () => {
      const { impl, calls } = fakeFetch({
        "/v1/oauth2/token": token,
        "/v2/checkout/orders/PPO/capture": capturedOrder(),
      });
      const out = await captureOrder("PPO", KEY, opts(impl));

      assert.deepEqual(out, {
        paypalOrderId: "PPO",
        paypalCaptureId: "CAP",
        status: "COMPLETED",
        amount: 5500,
        payer: { email: "pat@venmo", name: "Pat E" },
      });

      const call = calls.find((c) => /capture$/.test(c.path));

      assert.equal(call.headers["PayPal-Request-Id"], `${KEY}-capture`);
    });

  it("reads back an order already captured", async () => {
    const { impl, calls } = fakeFetch({
      "/v1/oauth2/token": token,
      "/v2/checkout/orders/PPO/capture": () => new Response(JSON.stringify({
        name: "UNPROCESSABLE_ENTITY",
        details: [{ issue: "ORDER_ALREADY_CAPTURED" }],
      }), { status: 422 }),
      "/v2/checkout/orders/PPO": capturedOrder(),
    });
    const out = await captureOrder("PPO", KEY, opts(impl));

    assert.equal(out.paypalCaptureId, "CAP");
    assert.equal(calls.at(-1).method, "GET");
    assert.equal(calls.at(-1).path, "/v2/checkout/orders/PPO");
  });

  it("marks a declined instrument as declined, not retryable", async () => {
    const { impl } = fakeFetch({
      "/v1/oauth2/token": token,
      "/v2/checkout/orders/PPO/capture": () => new Response(JSON.stringify({
        name: "UNPROCESSABLE_ENTITY",
        details: [{ issue: "INSTRUMENT_DECLINED" }],
      }), { status: 422 }),
    });

    await assert.rejects(captureOrder("PPO", KEY, opts(impl)),
      (e) => e instanceof PayPalError && e.declined === true
        && e.code === "INSTRUMENT_DECLINED" && e.retryable === false);
  });

  it("treats a capture that is not completed as declined", async () => {
    const { impl } = fakeFetch({
      "/v1/oauth2/token": token,
      "/v2/checkout/orders/PPO/capture": capturedOrder("DECLINED"),
    });

    await assert.rejects(captureOrder("PPO", KEY, opts(impl)),
      (e) => e.declined === true && e.code === "DECLINED");
  });

  it("marks 5xx and network failures retryable", async () => {
    const boom = fakeFetch({
      "/v1/oauth2/token": token,
      "/v2/checkout/orders/PPO/capture": () =>
        new Response("{}", { status: 503 }),
    });

    await assert.rejects(captureOrder("PPO", KEY, opts(boom.impl)),
      (e) => e instanceof PayPalError && e.retryable === true);

    let n = 0;

    forgetTokens();
    const offline = async (url) => {
      n += 1;
      if (/oauth2/.test(url)) return new Response(JSON.stringify(token));
      throw new TypeError("fetch failed");
    };

    await assert.rejects(captureOrder("PPO", KEY, opts(offline)),
      (e) => e.retryable === true);
    assert.equal(n, 2);
  });

  it("reads one order", async () => {
    const { impl } = fakeFetch({
      "/v1/oauth2/token": token,
      "/v2/checkout/orders/PPO": { id: "PPO", status: "APPROVED" },
    });
    const out = await getOrder("PPO", opts(impl));

    assert.deepEqual(out, { status: "APPROVED", capture: null });
  });
});

describe("refundCapture", () => {
  it("sends the amount back with a note, under its own request id",
    async () => {
      const { impl, calls } = fakeFetch({
        "/v1/oauth2/token": token,
        "/v2/payments/captures/CAP/refund": {
          id: "REF", status: "COMPLETED", amount: { value: "12.34" },
        },
      });
      const out = await refundCapture({
        paypalCaptureId: "CAP", amount: 1234, key: KEY, note: "Sorry",
      }, opts(impl));

      assert.deepEqual(out, {
        paypalRefundId: "REF", status: "COMPLETED", amount: 1234,
      });

      const call = calls.find((c) => /refund$/.test(c.path));

      assert.equal(call.headers["PayPal-Request-Id"], `${KEY}-refund`);
      assert.deepEqual(call.body, {
        amount: { currency_code: "USD", value: "12.34" },
        note_to_payer: "Sorry",
      });
    });
});

describe("verifyWebhook", () => {
  const headers = new Headers({
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.paypal.com/cert",
    "paypal-transmission-id": "T1",
    "paypal-transmission-sig": "sig",
    "paypal-transmission-time": "2026-10-06T13:00:00Z",
  });
  const body = JSON.stringify({ event_type: "PAYMENT.CAPTURE.COMPLETED" });

  it("asks PayPal, with the headers and the event as received", async () => {
    const { impl, calls } = fakeFetch({
      "/v1/oauth2/token": token,
      "/v1/notifications/verify-webhook-signature": {
        verification_status: "SUCCESS",
      },
    });

    assert.equal(await verifyWebhook(headers, body, opts(impl)), true);

    const call = calls.find((c) => /verify-webhook/.test(c.path));

    assert.deepEqual(call.body, {
      auth_algo: "SHA256withRSA",
      cert_url: "https://api.paypal.com/cert",
      transmission_id: "T1",
      transmission_sig: "sig",
      transmission_time: "2026-10-06T13:00:00Z",
      webhook_id: "WH-1",
      webhook_event: { event_type: "PAYMENT.CAPTURE.COMPLETED" },
    });
  });

  it("says no on FAILURE, on a bad body, and without a webhook id",
    async () => {
      const { impl, calls } = fakeFetch({
        "/v1/oauth2/token": token,
        "/v1/notifications/verify-webhook-signature": {
          verification_status: "FAILURE",
        },
      });

      assert.equal(await verifyWebhook(headers, body, opts(impl)), false);
      assert.equal(await verifyWebhook(headers, "{nope", opts(impl)), false);
      assert.equal(await verifyWebhook(headers, body, {
        ...opts(impl), env: { ...env, PAYPAL_WEBHOOK_ID: "" },
      }), false);
      assert.equal(calls.filter((c) => /verify/.test(c.path)).length, 1);
    });
});
