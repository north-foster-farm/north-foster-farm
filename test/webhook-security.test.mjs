/* eslint-disable camelcase -- the providers name their fields their way */
// The three webhooks (Square, PayPal, Resend) each answer a missing, a
// bad and a replayed signature the same way: refused or a no-op, with
// every record left exactly as it was (#267, code analysis). The
// per-provider suites cover the details; this one holds the guarantee
// side by side so a change to one handler cannot quietly loosen it.
//
// A refused delivery may log and alert (lib/webhooks.mjs), so the
// comparison covers the stores that hold the farm's records, not the
// jobs store that keeps the alert's own state.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { optIn } from "../netlify/functions/lib/news.mjs";
import {
  getCustomer, getOrder, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { resetGuard } from "../netlify/functions/lib/webhooks.mjs";
import { handle as paypalHook } from "../netlify/functions/paypal-webhook.mjs";
import {
  TOLERANCE, handle as resendHook,
} from "../netlify/functions/resend-webhook.mjs";
import {
  handle as squareHook, signature,
} from "../netlify/functions/square-webhook.mjs";

const NOW = new Date("2026-10-18T12:00:00Z");
const MAILS = {
  FARM_NOTIFICATIONS_EMAIL: "farm@example.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@example.com",
};
const RECORDS = ["orders", "customers", "auth", "stock", "gate"];

// Everything the farm's records hold, as one string to compare.
const snapshot = (stores) => JSON.stringify(
  RECORDS.map((name) => [name, [...stores[name].data.entries()]]),
);

const mailbox = () => {
  const sent = [];

  return {
    sent,
    mail: async (m) => {
      sent.push(m);

      return { id: `m${sent.length}`, driver: "test" };
    },
  };
};

const post = (path, body, headers = {}) => new Request(
  `https://x${path}`, { method: "POST", headers, body },
);

const paidOrder = (payment) => ({
  id: "NFF-1",
  status: "paid",
  submittedAt: "2026-10-18T10:00:00Z",
  paidAt: "2026-10-18T10:00:00Z",
  customer: {
    name: "Pat Example", firstName: "Pat", email: "pat@example.com",
    phone: "",
  },
  lines: [{ sku: "A", label: "Eggs (per dozen)", qty: 1, lineTotal: 7 }],
  totals: { subtotal: 700, discountAmount: 0, deliveryFee: 0, total: 700 },
  fulfilment: {
    method: "delivery", date: "2026-10-20", state: "agreed", onfarm: null,
    delivery: { address1: "1 Main St", town: "Foster", zip: "02825" },
  },
  square: { squareOrderId: "SQO", customerId: "CUST" },
  payment: { at: "2026-10-18T10:00:00Z", ...payment },
});

// One entry per provider: a store holding what the event would change,
// the delivery in its signed form, the same with its signature
// removed and spoiled, and what the event changes.
const SQUARE_URL = "https://x/api/square/webhook";
const SQUARE_ENV = {
  ...MAILS, SQUARE_WEBHOOK_SIGNATURE_KEY: "k", SQUARE_WEBHOOK_URL: SQUARE_URL,
};
const SQUARE_BODY = JSON.stringify({
  type: "refund.updated",
  data: {
    object: {
      refund: {
        id: "REF-1", payment_id: "PAY-1", status: "COMPLETED",
        amount_money: { amount: 700, currency: "USD" },
      },
    },
  },
});

const square = {
  name: "Square",
  setup: async () => {
    const stores = testStores();

    await saveOrder(stores, paidOrder({
      via: "square", method: "card", squarePaymentId: "PAY-1",
    }), NOW);

    return stores;
  },
  send: (stores, headers = {}, extra = {}) => squareHook(
    post("/api/square/webhook", SQUARE_BODY, headers),
    { stores, env: SQUARE_ENV, now: NOW, ...extra },
  ),
  signed: () => ({
    "x-square-hmacsha256-signature": signature("k", SQUARE_URL, SQUARE_BODY),
  }),
  forged: () => ({
    "x-square-hmacsha256-signature": signature("wrong", SQUARE_URL,
      SQUARE_BODY),
  }),
  changed: async (stores) =>
    ((await getOrder(stores, "NFF-1")).refunds || []).length > 0,
};

const PAYPAL_ENV = {
  ...MAILS, PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s",
  PAYPAL_WEBHOOK_ID: "WH", PAYPAL_ENV: "sandbox",
};
const PAYPAL_BODY = JSON.stringify({
  event_type: "PAYMENT.CAPTURE.REFUNDED",
  resource: {
    id: "PPR-1", status: "COMPLETED",
    amount: { currency_code: "USD", value: "7.00" },
    links: [{
      href: "https://api.sandbox.paypal.com/v2/payments/captures/CAP",
      rel: "up",
    }],
  },
});
const PAYPAL_HEADERS = {
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-time": "2026-10-18T12:00:00Z",
  "paypal-cert-url": "https://api.paypal.com/cert",
  "paypal-auth-algo": "x",
};

// PayPal vouches for a delivery by its own API; the stand-in says yes
// only to the signature this suite calls good.
const paypalVerdict = async (headers) =>
  headers.get("paypal-transmission-sig") === "good";

const paypal = {
  name: "PayPal",
  setup: async () => {
    const stores = testStores();

    await saveOrder(stores, paidOrder({
      via: "venmo", paypalCaptureId: "CAP", squarePaymentId: null,
    }), NOW);

    return stores;
  },
  send: (stores, headers = {}, extra = {}) => paypalHook(
    post("/api/paypal/webhook", PAYPAL_BODY, headers),
    { stores, env: PAYPAL_ENV, now: NOW, verify: paypalVerdict, ...extra },
  ),
  signed: () => ({ ...PAYPAL_HEADERS, "paypal-transmission-sig": "good" }),
  forged: () => ({ ...PAYPAL_HEADERS, "paypal-transmission-sig": "bad" }),
  changed: async (stores) =>
    ((await getOrder(stores, "NFF-1")).refunds || []).length > 0,
};

const RESEND_KEY = Buffer.from("resend-test-signing-key").toString("base64");
const RESEND_ENV = {
  ...MAILS, RESEND_WEBHOOK_SECRET: `whsec_${RESEND_KEY}`,
  RESEND_AUDIENCE_ID: "aud",
};
const RESEND_BODY = JSON.stringify({
  type: "contact.updated",
  created_at: "2026-10-18T11:59:00.000Z",
  data: {
    id: "c1", audience_id: "aud", segment_ids: ["aud"],
    updated_at: "2026-10-18T11:59:00.000Z",
    email: "pat@example.com", unsubscribed: true,
  },
});

const svix = ({ at = NOW, key = RESEND_KEY } = {}) => {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const sig = createHmac("sha256", Buffer.from(key, "base64"))
    .update(`msg_1.${timestamp}.${RESEND_BODY}`).digest("base64");

  return {
    "svix-id": "msg_1", "svix-timestamp": timestamp,
    "svix-signature": `v1,${sig}`,
  };
};

const resend = {
  name: "Resend",
  setup: async () => {
    const stores = testStores();

    await optIn(stores, "pat@example.com", { firstName: "Pat" },
      new Date("2026-09-01T00:00:00Z"));

    return stores;
  },
  send: (stores, headers = {}, extra = {}) => resendHook(
    post("/api/resend/webhook", RESEND_BODY, headers),
    { stores, env: RESEND_ENV, now: NOW, ...extra },
  ),
  signed: () => svix(),
  forged: () => svix({ key: Buffer.from("wrong").toString("base64") }),
  changed: async (stores) =>
    (await getCustomer(stores, "pat@example.com")).marketing === false,
};

for (const provider of [square, paypal, resend]) {
  describe(`the ${provider.name} webhook`, () => {
    it("refuses an unsigned delivery and changes nothing", async () => {
      resetGuard();

      const stores = await provider.setup();
      const before = snapshot(stores);
      const { mail } = mailbox();
      const res = await provider.send(stores, {}, { mail });

      assert.equal(res.status, 401);
      assert.equal(snapshot(stores), before);
      assert.equal(await provider.changed(stores), false);
    });

    it("refuses a forged signature and changes nothing", async () => {
      resetGuard();

      const stores = await provider.setup();
      const before = snapshot(stores);
      const { mail } = mailbox();
      const res = await provider.send(stores, provider.forged(), { mail });

      assert.equal(res.status, 401);
      assert.equal(snapshot(stores), before);
      assert.equal(await provider.changed(stores), false);
    });

    it("applies a signed delivery once and a replay of it not at all",
      async () => {
        resetGuard();

        const stores = await provider.setup();
        const { mail, sent } = mailbox();
        const first = await provider.send(stores, provider.signed(), { mail });

        assert.equal(first.status, 200);
        assert.equal(await provider.changed(stores), true);

        const applied = snapshot(stores);
        const mails = sent.length;
        const replay = await provider.send(stores, provider.signed(),
          { mail });

        assert.equal(replay.status, 200);
        assert.equal(snapshot(stores), applied,
          "a replay leaves every record as the first delivery did");
        assert.equal(sent.length, mails, "and sends nothing more");
      });
  });
}

describe("a Resend delivery replayed after its time", () => {
  it("is refused, so an old unsubscribe cannot undo a later opt-in",
    async () => {
      resetGuard();

      const stores = await resend.setup();
      const { mail } = mailbox();

      assert.equal(
        (await resend.send(stores, resend.signed(), { mail })).status, 200);
      assert.equal(await resend.changed(stores), true);

      // The customer signs up again; the captured delivery is sent anew
      // once its timestamp has aged out.
      const later = new Date(NOW.getTime() + TOLERANCE + 60_000);

      await optIn(stores, "pat@example.com", { firstName: "Pat" }, later);

      const before = snapshot(stores);
      const replay = await resend.send(stores, resend.signed(),
        { mail, now: later });

      assert.equal(replay.status, 401);
      assert.equal(snapshot(stores), before);
      assert.equal((await getCustomer(stores, "pat@example.com")).marketing,
        true);
    });
});

describe("a Square delivery signed for another body", () => {
  it("is refused: the signature binds the body and the URL", async () => {
    resetGuard();

    const stores = await square.setup();
    const before = snapshot(stores);
    const { mail } = mailbox();
    const tampered = SQUARE_BODY.replace("700", "70000");
    const res = await squareHook(
      post("/api/square/webhook", tampered, square.signed()),
      { stores, env: SQUARE_ENV, now: NOW, mail },
    );
    const elsewhere = await squareHook(
      post("/api/square/webhook", SQUARE_BODY, square.signed()),
      {
        stores,
        env: { ...SQUARE_ENV, SQUARE_WEBHOOK_URL: "https://y/api/square/webhook" },
        now: NOW,
        mail,
      },
    );

    assert.equal(res.status, 401);
    assert.equal(elsewhere.status, 401);
    assert.equal(snapshot(stores), before);
  });
});
