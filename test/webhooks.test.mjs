// Refused webhook deliveries (#257): each reason is logged with the
// provider, the size and the delivery id but never the body, the ones
// that mean a bad secret alert, an instance alerts once an hour, and
// PayPal's unsigned POSTs never reach PayPal.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { beforeEach, describe, it } from "node:test";

import { readMark } from "../netlify/functions/lib/health.mjs";
import { verifyWebhook } from "../netlify/functions/lib/paypal.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import {
  KIND, REASONS, resetGuard,
} from "../netlify/functions/lib/webhooks.mjs";
import { handle as paypalHook } from "../netlify/functions/paypal-webhook.mjs";
import { handle as resendHook } from "../netlify/functions/resend-webhook.mjs";
import {
  handle as squareHook, signature,
} from "../netlify/functions/square-webhook.mjs";

const now = new Date("2026-10-16T12:00:00Z");
const MARKER = "pat@example.com 401-555-0100";
const body = JSON.stringify({ type: "refund.updated", note: MARKER });
const FARM = { ADMIN_EMAILS: "farm@example.com" };

// The lines the handlers write, parsed, and the alert emails sent.
const watch = (t) => {
  const lines = [];

  for (const level of ["info", "warn", "error"]) {
    t.mock.method(console, level, (text) => {
      lines.push(text);
    });
  }

  const sent = [];
  const mail = async (m) => {
    sent.push(m);

    return { id: `m${sent.length}`, driver: "test" };
  };
  const rejections = () => lines.map((l) => JSON.parse(l))
    .filter((r) => r.event === KIND);

  return { lines, sent, mail, rejections };
};

const post = (path, headers = {}) => new Request(`https://x${path}`, {
  method: "POST", headers, body,
});

const SQUARE_URL = "https://x/api/square/webhook";
const SQUARE = {
  ...FARM, SQUARE_WEBHOOK_SIGNATURE_KEY: "k", SQUARE_WEBHOOK_URL: SQUARE_URL,
};
const PAYPAL = {
  ...FARM, PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s",
  PAYPAL_WEBHOOK_ID: "WH", PAYPAL_ENV: "sandbox",
};
const RESEND_KEY = Buffer.from("resend-test-signing-key").toString("base64");
const RESEND = { ...FARM, RESEND_WEBHOOK_SECRET: `whsec_${RESEND_KEY}` };

const svix = ({ at = now, key = RESEND_KEY } = {}) => {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const sig = createHmac("sha256", Buffer.from(key, "base64"))
    .update(`msg_1.${timestamp}.${body}`).digest("base64");

  return {
    "svix-id": "msg_1", "svix-timestamp": timestamp,
    "svix-signature": `v1,${sig}`,
  };
};

// PayPal's verification API, counting calls; `ok` is its answer.
const paypalApi = (ok) => {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));

    return new Response(JSON.stringify(/oauth2/.test(url)
      ? { access_token: "T", expires_in: 3600 }
      : { verification_status: ok ? "SUCCESS" : "FAILURE" }));
  };

  return { calls, impl };
};

const PAYPAL_SIGNED = {
  "paypal-transmission-id": "tx-1", "paypal-transmission-sig": "sig",
  "paypal-transmission-time": "2026-10-16T12:00:00Z",
  "paypal-cert-url": "https://api.paypal.com/cert", "paypal-auth-algo": "x",
};

// Every provider and reason: the request, the context, and the id the
// log line should carry.
const CASES = [
  ["square", "unconfigured", (o) => squareHook(post("/api/square/webhook", {
    "x-square-hmacsha256-signature": "sig",
  }), { env: FARM, ...o })],
  ["square", "unsigned", (o) => squareHook(post("/api/square/webhook"),
    { env: SQUARE, ...o })],
  ["square", "mismatch", (o) => squareHook(post("/api/square/webhook", {
    "x-square-hmacsha256-signature": signature("other", SQUARE_URL, body),
  }), { env: SQUARE, ...o })],
  ["paypal", "unconfigured", (o) => paypalHook(
    post("/api/paypal/webhook", PAYPAL_SIGNED), { env: FARM, ...o }
  ), "tx-1"],
  ["paypal", "unsigned", (o) => paypalHook(post("/api/paypal/webhook"),
    { env: PAYPAL, ...o })],
  ["paypal", "mismatch", (o) => paypalHook(
    post("/api/paypal/webhook", PAYPAL_SIGNED),
    { env: PAYPAL, fetchImpl: paypalApi(false).impl, ...o }
  ), "tx-1"],
  ["resend", "unconfigured", (o) => resendHook(
    post("/api/resend/webhook", svix()), { env: FARM, ...o }
  ), "msg_1"],
  ["resend", "unsigned", (o) => resendHook(post("/api/resend/webhook"),
    { env: RESEND, ...o })],
  // A scanner's POST to a context with no secret: unsigned, not paged.
  ["square", "unsigned", (o) => squareHook(post("/api/square/webhook"),
    { env: FARM, ...o })],
  ["paypal", "unsigned", (o) => paypalHook(post("/api/paypal/webhook"),
    { env: FARM, ...o })],
  ["resend", "unsigned", (o) => resendHook(post("/api/resend/webhook"),
    { env: FARM, ...o })],
  ["resend", "stale", (o) => resendHook(post("/api/resend/webhook",
    svix({ at: new Date(now.getTime() - 3_600_000) })),
  { env: RESEND, ...o }), "msg_1"],
  ["resend", "mismatch", (o) => resendHook(post("/api/resend/webhook",
    svix({ key: Buffer.from("wrong").toString("base64") })),
  { env: RESEND, ...o }), "msg_1"],
];

describe("a refused webhook delivery", () => {
  beforeEach(() => resetGuard());

  it("covers every reason", () => {
    assert.deepEqual([...new Set(CASES.map((c) => c[1]))].sort(),
      [...REASONS].sort());
  });

  for (const [provider, reason, send, id = null] of CASES) {
    const alerts = reason !== "unsigned";

    it(`${provider}, ${reason}: 401, logged without the body, ${
      alerts ? "alerts" : "no alert"}`, async (t) => {
      const w = watch(t);
      const stores = testStores();
      const out = await send({ stores, now, mail: w.mail });

      assert.equal(out.status, 401);
      assert.deepEqual(await out.json(), { error: "Bad signature." });

      const [line, ...more] = w.rejections();

      assert.equal(more.length, 0);
      assert.equal(line.level, "warn");
      assert.equal(line.provider, provider);
      assert.equal(line.reason, reason);
      assert.equal(line.bytes, Buffer.byteLength(body));
      assert.equal(line.deliveryId, id);
      assert.equal(line.alert, alerts);
      assert.ok(!w.lines.some((l) => l.includes(MARKER)),
        "no line carries the body");
      assert.equal(w.sent.length, alerts ? 1 : 0);
      if (alerts) {
        assert.equal(w.sent[0].to[0], "farm@example.com");
        assert.ok(!JSON.stringify(w.sent[0]).includes(MARKER));
        assert.ok((await readMark(stores, `alert/${KIND}`)).at);
      } else {
        assert.equal(await readMark(stores, `alert/${KIND}`), null);
      }
    });
  }

  it("alerts once an hour from one instance, without touching Blobs",
    async (t) => {
      const w = watch(t);
      const stores = testStores();
      const forged = () => squareHook(post("/api/square/webhook", {
        "x-square-hmacsha256-signature": "forged",
      }), { env: SQUARE, stores, now, mail: w.mail });

      for (let i = 0; i < 5; i += 1) await forged();

      assert.equal(w.sent.length, 1);
      assert.deepEqual(w.rejections().map((r) => r.alert),
        [true, false, false, false, false]);
      assert.equal((await readMark(stores, `alert/${KIND}`)).muted, 0,
        "alert() was not even asked");

      await squareHook(post("/api/square/webhook", {
        "x-square-hmacsha256-signature": "forged",
      }), {
        env: SQUARE, stores, now: new Date(now.getTime() + 3_600_001),
        mail: w.mail,
      });

      assert.equal(w.sent.length, 2, "an hour later it alerts again");
    });

  it("still lets a good delivery through", async () => {
    const stores = testStores();
    const res = await squareHook(post("/api/square/webhook", {
      "x-square-hmacsha256-signature": signature("k", SQUARE_URL, body),
    }), { env: SQUARE, stores, now });

    assert.equal(res.status, 200);
  });

  describe("during a Square key swap", () => {
    const swap = { ...SQUARE, SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS: "old" };
    const deliver = (key, env) => squareHook(post("/api/square/webhook", {
      "x-square-hmacsha256-signature": signature(key, SQUARE_URL, body),
    }), { env, stores: testStores(), now });

    it("accepts a signature from either key", async () => {
      assert.equal((await deliver("k", swap)).status, 200);
      assert.equal((await deliver("old", swap)).status, 200);
    });

    it("refuses any other key", async () => {
      assert.equal((await deliver("other", swap)).status, 401);
    });

    it("refuses the old key once PREVIOUS is removed", async () => {
      assert.equal((await deliver("old", SQUARE)).status, 401);
    });

    it("accepts the previous key alone while the new is unset",
      async () => {
        const only = { ...FARM, SQUARE_WEBHOOK_URL: SQUARE_URL,
          SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS: "old" };

        assert.equal((await deliver("old", only)).status, 200);
      });
  });
});

describe("PayPal's verification", () => {
  it("never calls PayPal for an unsigned delivery", async () => {
    const api = paypalApi(true);

    assert.equal(await verifyWebhook(new Headers(), body,
      { env: PAYPAL, fetchImpl: api.impl, now }), false);
    assert.deepEqual(api.calls, []);

    resetGuard();

    const res = await paypalHook(post("/api/paypal/webhook"), {
      env: PAYPAL, fetchImpl: api.impl, stores: testStores(), now,
      mail: async () => {},
    });

    assert.equal(res.status, 401);
    assert.deepEqual(api.calls, []);
  });

  it("calls PayPal once for a signed one", async () => {
    const api = paypalApi(true);

    assert.equal(await verifyWebhook(new Headers(PAYPAL_SIGNED), body,
      { env: PAYPAL, fetchImpl: api.impl, now }), true);
    assert.equal(api.calls.filter((c) => /verify/.test(c)).length, 1);
  });
});
