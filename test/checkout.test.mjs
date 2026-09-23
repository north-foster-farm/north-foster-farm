import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CheckoutError, attemptKey, completeOrder, finishVenmo, payWithSquare,
  recordOnSquare, startVenmo, syncSquare,
} from "../netlify/functions/lib/checkout.mjs";
import { readMark } from "../netlify/functions/lib/health.mjs";
import { PayPalError } from "../netlify/functions/lib/paypal.mjs";
import {
  getCheckout, getOrder, openOrders, saveCheckout, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { SquareError } from "../netlify/functions/lib/square.mjs";
import { getCounts, setCount } from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle as config } from "../netlify/functions/checkout.mjs";
import {
  applyEvent, handle as webhook,
} from "../netlify/functions/paypal-webhook.mjs";

const now = new Date("2026-10-06T13:00:00Z");
const KEY = "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f";

const order = (overrides = {}) => ({
  id: "NFF-2610-ABCD",
  submittedAt: now.toISOString(),
  customer: {
    firstName: "Pat", lastName: "Example", name: "Pat Example",
    email: "pat@example.com", phone: "401-555-0100", contact: "call",
  },
  fulfilment: {
    method: "delivery", date: "2026-10-08", onfarm: null, state: "agreed",
    delivery: {
      address1: "1 Main St", town: "Foster", zip: "02825", cooler: "Porch",
    },
  },
  lines: [{
    sku: "NFF-CHK-WHL-0350-0400", label: "Whole Chicken, 3.5 – 3.9 lbs",
    name: "Whole Chicken, 3.5 – 3.9 lbs", unitPrice: 30, qty: 2,
    lineTotal: 60, squareVariationId: null,
  }],
  totals: {
    subtotal: 6000, discountTier: 50, discountAmount: 500, deliveryFee: 500,
    areaFee: 0, total: 6000, discountLabel: "Bulk discount ($50+)",
  },
  notes: "",
  source: "",
  flags: { zipUnlisted: false, totalMismatch: false },
  meta: { idempotencyKey: KEY, attempt: 1 },
  ...overrides,
});

const paid = () => ({
  squarePaymentId: "PAY", status: "COMPLETED", receiptUrl: "https://r",
  brand: "VISA", last4: "4242", wallet: null,
});

const fakeSquare = ({ pay, create } = {}) => {
  const calls = [];
  const square = {
    createOrder: async (o, key) => {
      calls.push(["order", key]);
      if (create) return create();

      return { squareOrderId: "SQO", customerId: "CUST" };
    },
    createPayment: async (args) => {
      calls.push(["payment", args.key, args.source]);
      if (pay) return pay(args);

      return paid();
    },
    cancelOrder: async (id) => {
      calls.push(["cancel", id]);

      return { id, cancelled: true };
    },
  };

  return { square, calls };
};

const capture = (amount = 6000) => ({
  paypalOrderId: "PPO", paypalCaptureId: "CAP", status: "COMPLETED",
  amount, payer: { email: "pat@venmo", name: "Pat" },
});

const fakePaypal = ({ cap } = {}) => {
  const calls = [];
  const paypal = {
    createOrder: async (o, key) => {
      calls.push(["create", key]);

      return { paypalOrderId: "PPO" };
    },
    captureOrder: async (id, key) => {
      calls.push(["capture", key, id]);
      if (cap) return cap();

      return capture();
    },
  };

  return { paypal, calls };
};

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

const quiet = { sleep: async () => {}, env: {}, now };

describe("attemptKey", () => {
  it("is 32 hex characters and changes with the attempt", () => {
    const one = attemptKey(KEY, 1);

    assert.match(one, /^[0-9a-f]{32}$/);
    assert.equal(one, attemptKey(KEY, 1));
    assert.notEqual(one, attemptKey(KEY, 2));
    assert.notEqual(one, attemptKey("other-key-0000000", 1));
  });
});

describe("completeOrder", () => {
  it("writes the paid record once, moves stock, marks and emails",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailbox();
      const env = { ADMIN_EMAILS: "farm@x.com" };

      await setCount(stores, "NFF-CHK-WHL-0350-0400", 4);
      const first = await completeOrder(stores, order(), {
        square: { squareOrderId: "SQO", customerId: "CUST" },
        payment: { via: "square", method: "card", ...paid() },
      }, { mail, env, now });

      assert.equal(first.status, "paid");
      assert.equal(first.paidAt, now.toISOString());
      assert.equal(first.payment.at, now.toISOString());
      assert.equal(first.payment.last4, "4242");
      assert.deepEqual((await openOrders(stores)).map((o) => o.id),
        ["NFF-2610-ABCD"]);
      assert.equal((await getCounts(stores))["NFF-CHK-WHL-0350-0400"], 2);
      assert.equal((await readMark(stores, "order")).id, "NFF-2610-ABCD");
      assert.equal((await readMark(stores, "paid")).via, "square");
      assert.equal(sent.length, 2);
      assert.equal(sent[0].subject, "Your order is confirmed");
      assert.match(sent[1].subject, /^New order/);

      const again = await completeOrder(stores, order(), {
        square: null, payment: { via: "square" },
      }, { mail, env, now });

      assert.equal(again.payment.last4, "4242", "the first record stands");
      assert.equal((await getCounts(stores))["NFF-CHK-WHL-0350-0400"], 2);
      assert.equal(sent.length, 2);
    });
});

describe("payWithSquare", () => {
  it("orders then pays under the attempt's key and records both",
    async () => {
      const stores = testStores();
      const { square, calls } = fakeSquare();
      const saved = await payWithSquare(stores, order(), {
        key: KEY, attempt: 3, method: "googlepay", sourceId: "tok",
        verificationToken: "ver",
      }, { square, ...quiet });
      const k = attemptKey(KEY, 3);

      assert.deepEqual(calls, [
        ["order", k],
        ["payment", k, { sourceId: "tok", verificationToken: "ver" }],
      ]);
      assert.equal(saved.status, "paid");
      assert.equal(saved.payment.method, "googlepay");
      assert.equal(saved.payment.via, "square");
      assert.equal(saved.payment.squarePaymentId, "PAY");
      assert.deepEqual(saved.square, {
        squareOrderId: "SQO", customerId: "CUST",
      });
    });

  it("records an unknown method as a card", async () => {
    const saved = await payWithSquare(testStores(), order(), {
      key: KEY, method: "sock", sourceId: "tok",
    }, { square: fakeSquare().square, ...quiet });

    assert.equal(saved.payment.method, "card");
  });

  it("closes the Square order on a decline and rethrows", async () => {
    const stores = testStores();
    const { square, calls } = fakeSquare({
      pay: () => {
        throw new SquareError("no", { declined: true, code: "CVV_FAILURE" });
      },
    });

    await assert.rejects(payWithSquare(stores, order(), {
      key: KEY, method: "card", sourceId: "tok",
    }, { square, ...quiet }), (e) => e.declined && e.code === "CVV_FAILURE");
    assert.deepEqual(calls.at(-1), ["cancel", "SQO"]);
    assert.equal(await getOrder(stores, "NFF-2610-ABCD"), null);

    // A cancel that fails is only logged.
    square.cancelOrder = async () => { throw new Error("nope"); };
    await assert.rejects(payWithSquare(stores, order(), {
      key: KEY, method: "card", sourceId: "tok",
    }, { square, ...quiet }), (e) => e.declined);
  });

  it("does not close the order on an outage, and retries first",
    async () => {
      let n = 0;
      const { square, calls } = fakeSquare({
        pay: () => {
          n += 1;
          if (n < 2) throw new SquareError("503", { retryable: true });

          return paid();
        },
      });
      const saved = await payWithSquare(testStores(), order(), {
        key: KEY, method: "card", sourceId: "tok",
      }, { square, ...quiet });

      assert.equal(saved.status, "paid");
      assert.ok(!calls.some((c) => c[0] === "cancel"));
    });
});

describe("startVenmo and finishVenmo", () => {
  it("keeps the checkout under the key and finds it again", async () => {
    const stores = testStores();
    const { paypal, calls } = fakePaypal();
    const out = await startVenmo(stores, order(), { key: KEY, attempt: 2 }, {
      paypal, ...quiet,
    });

    assert.deepEqual(out, { paypalOrderId: "PPO" });
    assert.deepEqual(calls, [["create", attemptKey(KEY, 2)]]);

    const kept = await getCheckout(stores, KEY);

    assert.equal(kept.attempt, 2);
    assert.equal(kept.at, now.toISOString());
    assert.equal(kept.order.id, "NFF-2610-ABCD");

    const { square, calls: sq } = fakeSquare();
    const saved = await finishVenmo(stores, order(), {
      key: KEY, paypalOrderId: "PPO",
    }, { paypal, square, ...quiet });
    const k = attemptKey(KEY, 2);

    assert.deepEqual(calls[1], ["capture", k, "PPO"]);
    assert.deepEqual(sq, [
      ["order", k],
      ["payment", k, { external: { source: "Venmo", sourceId: "CAP" } }],
    ]);
    assert.equal(saved.status, "paid");
    assert.equal(saved.payment.via, "venmo");
    assert.equal(saved.payment.paypalOrderId, "PPO");
    assert.equal(saved.payment.paypalCaptureId, "CAP");
    assert.deepEqual(saved.payment.payer, { email: "pat@venmo", name: "Pat" });
    assert.equal(saved.payment.receiptUrl, null);
    assert.equal(await getCheckout(stores, KEY), null);
  });

  it("refuses a missing or mismatched checkout, or a changed total",
    async () => {
      const stores = testStores();
      const { paypal, calls } = fakePaypal();
      const options = { paypal, square: fakeSquare().square, ...quiet };

      await assert.rejects(finishVenmo(stores, order(), {
        key: KEY, paypalOrderId: "PPO",
      }, options), (e) => e instanceof CheckoutError
        && e.code === "checkout.unknown");

      await startVenmo(stores, order(), { key: KEY }, options);
      await assert.rejects(finishVenmo(stores, order(), {
        key: KEY, paypalOrderId: "OTHER",
      }, options), (e) => e.code === "checkout.unknown");

      const changed = order();

      changed.totals = { ...changed.totals, total: 9900 };
      await assert.rejects(finishVenmo(stores, changed, {
        key: KEY, paypalOrderId: "PPO",
      }, options), (e) => e.code === "checkout.changed");
      assert.ok(!calls.some((c) => c[0] === "capture"), "nothing captured");
      assert.equal(await getOrder(stores, "NFF-2610-ABCD"), null);
    });

  it("records the order and alerts when the capture is the wrong amount",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailbox();
      const env = { ADMIN_EMAILS: "farm@x.com" };
      const { paypal } = fakePaypal({ cap: () => capture(5900) });
      const options = {
        paypal, square: fakeSquare().square, mail, env, sleep: quiet.sleep,
        now,
      };

      await startVenmo(stores, order(), { key: KEY }, options);
      const saved = await finishVenmo(stores, order(), {
        key: KEY, paypalOrderId: "PPO",
      }, options);

      assert.equal(saved.status, "paid");
      assert.ok(sent.some((m) =>
        m.subject === "Site alert: venmo.amount_mismatch"));
    });

  it("passes a decline from PayPal up", async () => {
    const stores = testStores();
    const { paypal } = fakePaypal({
      cap: () => {
        throw new PayPalError("no", {
          declined: true, code: "INSTRUMENT_DECLINED",
        });
      },
    });
    const options = { paypal, square: fakeSquare().square, ...quiet };

    await startVenmo(stores, order(), { key: KEY }, options);
    await assert.rejects(finishVenmo(stores, order(), {
      key: KEY, paypalOrderId: "PPO",
    }, options), (e) => e.declined && e.code === "INSTRUMENT_DECLINED");
    assert.ok(await getCheckout(stores, KEY), "the checkout stays");
  });
});

describe("recordOnSquare and syncSquare", () => {
  it("returns nulls and alerts when Square is down", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const { square } = fakeSquare({
      create: () => { throw new SquareError("down", { retryable: false }); },
    });
    const out = await recordOnSquare(stores, order(), attemptKey(KEY, 1),
      capture(), {
        square, mail, env: { ADMIN_EMAILS: "farm@x.com" }, now,
        sleep: quiet.sleep,
      });

    assert.deepEqual(out, { square: null, squarePaymentId: null });
    assert.equal(sent[0].subject, "Site alert: square.record_failed");
  });

  it("fills in the Square copy later, only where one is missing",
    async () => {
      const stores = testStores();
      const venmo = order({
        status: "paid",
        square: null,
        payment: {
          via: "venmo", method: "venmo", squarePaymentId: null,
          paypalOrderId: "PPO", paypalCaptureId: "CAP",
        },
      });

      await saveOrder(stores, venmo, now);

      const { square, calls } = fakeSquare();
      const synced = await syncSquare(stores, venmo, { square, ...quiet });
      const k = attemptKey(KEY, 1);

      assert.deepEqual(calls, [
        ["order", k],
        ["payment", k, { external: { source: "Venmo", sourceId: "CAP" } }],
      ]);
      assert.deepEqual(synced.square, {
        squareOrderId: "SQO", customerId: "CUST",
      });
      assert.equal(synced.payment.squarePaymentId, "PAY");
      assert.equal(synced.history.at(-1).event, "square.recorded");

      // Already there, or nothing to go on: untouched.
      calls.length = 0;
      assert.equal(await syncSquare(stores, synced, { square, ...quiet }),
        synced);
      const keyless = { ...venmo, meta: {} };

      assert.equal(await syncSquare(stores, keyless, { square, ...quiet }),
        keyless);
      const card = order({ status: "paid", square: null, payment: {
        via: "square", squarePaymentId: "PAY",
      } });

      assert.equal(await syncSquare(stores, card, { square, ...quiet }),
        card);
      assert.deepEqual(calls, []);

      // Square still down: the record is left as it was.
      const down = fakeSquare({
        create: () => { throw new SquareError("x"); },
      });

      assert.equal((await syncSquare(stores, venmo, {
        square: down.square, ...quiet,
      })).square, null);
    });
});

describe("POST /api/paypal/webhook", () => {
  const event = (type, resource) => JSON.stringify({
    event_type: type, resource,
  });
  const completed = (paypalOrderId = "PPO") => event(
    "PAYMENT.CAPTURE.COMPLETED", {
      id: "CAP",
      status: "COMPLETED",
      custom_id: "NFF-2610-ABCD",
      amount: { value: "60.00" },
      supplementary_data: { related_ids: { order_id: paypalOrderId } },
    }
  );
  const post = (body) => new Request("http://x/api/paypal/webhook", {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
  const yes = async () => true;

  it("refuses an unverified delivery and a bad body", async () => {
    const stores = testStores();
    const no = await webhook(post(completed()), {
      stores, verify: async () => false, now,
    });

    assert.equal(no.status, 401);

    const bad = await webhook(post("{nope"), { stores, verify: yes, now });

    assert.equal(bad.status, 400);

    const odd = await webhook(post(JSON.stringify({ x: 1 })), {
      stores, verify: yes, now,
    });

    assert.equal(odd.status, 400);
  });

  it("finishes a checkout the browser never came back for", async () => {
    const stores = testStores();
    const { paypal } = fakePaypal();
    const { square } = fakeSquare();

    await startVenmo(stores, order(), { key: KEY }, { paypal, ...quiet });

    const res = await webhook(post(completed()), {
      stores, verify: yes, paypal, square, now, sleep: quiet.sleep, env: {},
    });
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(data, {
      handled: true, id: "NFF-2610-ABCD", recovered: true,
    });
    assert.equal((await getOrder(stores, "NFF-2610-ABCD")).status, "paid");
    assert.equal((await readMark(stores, "webhook")).type,
      "PAYMENT.CAPTURE.COMPLETED");

    // Delivered again: the checkout is gone but the order is known.
    await saveCheckout(stores, {
      key: KEY, attempt: 1, at: now.toISOString(), order: order(),
      paypalOrderId: "PPO",
    });
    const again = await webhook(post(completed()), {
      stores, verify: yes, paypal, square, now, sleep: quiet.sleep, env: {},
    });

    assert.deepEqual(await again.json(), {
      handled: true, id: "NFF-2610-ABCD", repeat: true,
    });
  });

  it("ignores a capture it knows nothing of, and other events", async () => {
    const stores = testStores();

    assert.deepEqual(await applyEvent(stores, JSON.parse(completed("X")), {
      now,
    }), { handled: false, reason: "unknown checkout" });
    assert.deepEqual(await applyEvent(stores, JSON.parse(event(
      "PAYMENT.CAPTURE.COMPLETED", {}
    )), { now }), { handled: false, reason: "no order id" });
    assert.deepEqual(await applyEvent(stores, JSON.parse(event(
      "CHECKOUT.ORDER.APPROVED", {}
    )), { now }), { handled: false, reason: "ignored" });
  });

  it("notes a refund made in PayPal on the order", async () => {
    const stores = testStores();

    await saveOrder(stores, order({
      status: "paid",
      payment: { via: "venmo", paypalCaptureId: "CAP", squarePaymentId: "PAY" },
    }), now);

    const refunded = event("PAYMENT.CAPTURE.REFUNDED", {
      id: "CAP", status: "REFUNDED", amount: { value: "60.00" },
      refund: { id: "REF" },
    });
    const res = await webhook(post(refunded), { stores, verify: yes, now });

    assert.deepEqual(await res.json(), { handled: true, id: "NFF-2610-ABCD" });

    const saved = await getOrder(stores, "NFF-2610-ABCD");

    assert.equal(saved.refund.amount, 6000);
    assert.equal(saved.refund.total, true);
    assert.equal(saved.refund.source, "paypal");
    assert.equal(saved.refund.paypalRefundId, "REF");
    assert.equal(saved.history.at(-1).event, "refund.recorded");

    const again = await webhook(post(refunded), { stores, verify: yes, now });

    assert.deepEqual(await again.json(), {
      handled: true, id: "NFF-2610-ABCD", repeat: true,
    });

    const unknown = await applyEvent(stores, JSON.parse(event(
      "PAYMENT.CAPTURE.REFUNDED", { id: "NOPE" }
    )), { now });

    assert.deepEqual(unknown, { handled: false, reason: "unknown capture" });
  });
});

describe("GET /api/checkout/config", () => {
  it("is empty until the processors are configured", async () => {
    const res = await config(new Request("http://x/api/checkout/config"), {
      env: {},
    });

    assert.deepEqual(await res.json(), { square: null, paypal: null });
  });

  it("names the application, the location and the SDK addresses",
    async () => {
      const res = await config(new Request("http://x/api/checkout/config"), {
        env: {
          SQUARE_APPLICATION_ID: "sq0idp-x", SQUARE_LOCATION_ID: "LOC",
          SQUARE_ENV: "sandbox", PAYPAL_CLIENT_ID: "cid",
        },
      });
      const data = await res.json();

      assert.deepEqual(data.square, {
        applicationId: "sq0idp-x", locationId: "LOC", env: "sandbox",
        sdkUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
      });
      assert.equal(data.paypal.clientId, "cid");
      assert.equal(data.paypal.env, "sandbox");

      const url = new URL(data.paypal.sdkUrl);

      assert.equal(url.searchParams.get("client-id"), "cid");
      assert.equal(url.searchParams.get("enable-funding"), "venmo");
      assert.equal(url.searchParams.get("buyer-country"), "US");

      const live = await config(new Request("http://x/api/checkout/config"), {
        env: {
          SQUARE_APPLICATION_ID: "sq0idp-x", SQUARE_LOCATION_ID: "LOC",
          SQUARE_ENV: "production", PAYPAL_CLIENT_ID: "cid",
          PAYPAL_ENV: "live",
        },
      });
      const prod = await live.json();

      assert.equal(prod.square.sdkUrl, "https://web.squarecdn.com/v1/square.js");
      assert.equal(new URL(prod.paypal.sdkUrl).searchParams
        .get("buyer-country"), null);
    });
});
