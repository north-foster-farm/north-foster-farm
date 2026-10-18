import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { ORDER_BUDGET_MS, retry } from "../netlify/functions/lib/http.mjs";
import { MailError, sendMail } from "../netlify/functions/lib/mail.mjs";
import * as paypal from "../netlify/functions/lib/paypal.mjs";
import * as square from "../netlify/functions/lib/square.mjs";

const sqEnv = {
  SQUARE_ACCESS_TOKEN: "tok",
  SQUARE_LOCATION_ID: "LOC",
  SQUARE_ENV: "sandbox",
};
const ppEnv = {
  PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret",
  PAYPAL_ENV: "sandbox",
};
const order = {
  id: "NFF-2610-ABCD",
  customer: { name: "Pat Example", email: "pat@example.com" },
  totals: { total: 5500 },
};
const KEY = "0123456789abcdef0123456789abcdef";

// A fetch that never answers; it fails the way fetch does when its
// signal's timeout fires, and keeps the signals it was given.
const hanging = () => {
  const signals = [];
  const impl = (url, init) => new Promise((resolve, reject) => {
    signals.push(init.signal);
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  });

  return { impl, signals };
};

// A fetch that answers at once, with a body that never finishes.
const stalledBody = () => async (url, init) => ({
  ok: true,
  status: 200,
  json: () => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  }),
});

const payment = (fetchImpl, extra = {}) => square.createPayment({
  order, squareOrderId: "SQO", customerId: "C", key: KEY,
  source: { sourceId: "cnon:card" },
}, { env: sqEnv, fetchImpl, ...extra });

describe("Square calls", () => {
  it("carry a timeout signal and fail with a clear error", async () => {
    const { impl, signals } = hanging();
    const started = Date.now();

    await assert.rejects(
      payment(impl, { deadline: Date.now() + 400 }),
      (e) => e.name === "SquareError" && e.retryable === true
        && e.code === "timeout" && e.declined === false
        && /\/v2\/payments did not answer in 0\.\d s/.test(e.message)
    );
    assert.equal(signals.length, 1);
    assert.ok(signals[0] instanceof AbortSignal);
    assert.ok(Date.now() - started < 2000);
  });

  it("are not started with the request's time spent", async () => {
    let called = 0;

    await assert.rejects(
      payment(async () => { called += 1; }, { deadline: Date.now() + 50 }),
      (e) => e.code === "timeout" && /No time left/.test(e.message)
    );
    assert.equal(called, 0);
  });

  it("read a stalled body as a timeout, not a declined payment", async () => {
    await assert.rejects(
      payment(stalledBody(), { deadline: Date.now() + 400 }),
      (e) => e.retryable === true && e.declined === false
        && e.code === "timeout"
    );
  });

  it("name the budget the order request works within", () => {
    assert.ok(ORDER_BUDGET_MS <= 8500);
    assert.ok(square.PAYMENT_MS + 1000 < 10_000);
  });
});

describe("PayPal calls", () => {
  beforeEach(() => paypal.forgetTokens());

  it("time out on the token and on the call", async () => {
    const { impl } = hanging();

    await assert.rejects(
      paypal.createOrder(order, KEY, {
        env: ppEnv, fetchImpl: impl, now: new Date(),
        deadline: Date.now() + 400,
      }),
      (e) => e.name === "PayPalError" && e.retryable === true
        && e.code === "timeout"
        && /oauth2\/token did not answer/.test(e.message)
    );
  });

  it("time out on the capture after a token", async () => {
    const seen = [];
    const impl = async (url, init) => {
      seen.push(new URL(url).pathname);

      if (url.endsWith("/token")) {
        return new Response(JSON.stringify({
          "access_token": "t", "expires_in": 3600,
        }), { status: 200 });
      }

      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    };

    await assert.rejects(
      paypal.captureOrder("PP-1", KEY, {
        env: ppEnv, fetchImpl: impl, now: new Date(),
        deadline: Date.now() + 500,
      }),
      (e) => e.retryable === true && e.code === "timeout"
        && /capture did not answer/.test(e.message)
    );
    assert.equal(seen.length, 2);
  });
});

describe("Resend", () => {
  it("is called with a timeout and fails clearly when it fires", async () => {
    let signal;
    const impl = async (url, init) => {
      signal = init.signal;
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const env = {
      MAIL_DRIVER: "resend", RESEND_API_KEY: "k", MAIL_FROM: "a@b.c",
      SITE_CONTEXT: "production",
    };

    await assert.rejects(
      sendMail({ to: "a@b.c", subject: "s", text: "t" }, {
        env, fetchImpl: impl,
      }),
      (e) => e instanceof MailError && e.retryable === true
        && /Resend did not answer/.test(e.message)
    );
    assert.ok(signal instanceof AbortSignal);
  });
});

describe("retry until", () => {
  it("does not begin a retry that cannot finish", async () => {
    let tries = 0;

    await assert.rejects(
      retry(async () => {
        tries += 1;
        throw Object.assign(new Error("slow"), { retryable: true });
      }, { sleep: async () => {}, until: Date.now() + 600 }),
      /slow/
    );
    assert.equal(tries, 1);
  });

  it("retries as before with no deadline", async () => {
    let tries = 0;

    const out = await retry(async () => {
      tries += 1;
      if (tries < 3) throw Object.assign(new Error("x"), { retryable: true });

      return "ok";
    }, { sleep: async () => {} });

    assert.equal(out, "ok");
    assert.equal(tries, 3);
  });
});
