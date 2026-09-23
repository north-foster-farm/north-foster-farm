import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle, orderId } from "../netlify/functions/orders.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import { attemptKey } from "../netlify/functions/lib/checkout.mjs";
import { readCount, readMark } from "../netlify/functions/lib/health.mjs";
import {
  getCheckout, getCustomer, getOrder, openOrders, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { SquareError } from "../netlify/functions/lib/square.mjs";
import { getCounts, setCount } from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const now = instant("2026-10-06", 9, 0, "America/New_York");
const KEY = "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f";
const SKU = "NFF-CHK-WHL-0350-0400";

const card = { method: "card", sourceId: "cnon:tok" };

const body = (overrides = {}) => ({
  idempotencyKey: KEY,
  attempt: 1,
  customer: {
    firstName: "Pat",
    lastName: "Example",
    email: "pat@example.com",
    phone: "401-555-0100",
    contact: "call",
  },
  lines: [{ sku: SKU, qty: 2 }],
  fulfilment: {
    method: "onfarm",
    date: "2026-10-07",
    onfarm: { window: "morning" },
  },
  claimedTotal: 5500,
  payment: card,
  ...overrides,
});

const delivery = () => body({
  fulfilment: {
    method: "delivery",
    date: "2026-10-08",
    delivery: {
      address1: "1 Main St", town: "Foster", zip: "02825", cooler: "Porch",
    },
  },
  // $60 less the $5 tier, plus the $5 delivery fee.
  claimedTotal: 6000,
});

const post = (payload, headers = {}) => new Request("http://x/api/orders", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof payload === "string" ? payload : JSON.stringify(payload),
});

// A Square that records what it is asked and answers well.
const fakeSquare = ({ pay } = {}) => {
  const calls = [];
  const square = {
    createOrder: async (order, key) => {
      calls.push(["order", key, order.id]);

      return { squareOrderId: "SQO", customerId: "CUST" };
    },
    createPayment: async (args) => {
      calls.push(["payment", args.key, args.source]);
      if (pay) return pay(args);

      return {
        squarePaymentId: "PAY", status: "COMPLETED",
        receiptUrl: "https://sq/receipt", brand: "VISA", last4: "4242",
        wallet: null,
      };
    },
    cancelOrder: async (id) => {
      calls.push(["cancel", id]);

      return { id, cancelled: true };
    },
  };

  return { square, calls };
};

const fakePaypal = () => {
  const calls = [];
  const paypal = {
    createOrder: async (order, key) => {
      calls.push(["create", key, order.id]);

      return { paypalOrderId: "PPO" };
    },
    captureOrder: async (id, key) => {
      calls.push(["capture", key, id]);

      return {
        paypalOrderId: id, paypalCaptureId: "CAP", status: "COMPLETED",
        amount: 5500, payer: { email: "pat@venmo", name: "Pat" },
      };
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

const quiet = { sleep: async () => {} };

const run = (payload, options = {}) => handle(post(payload), {
  square: fakeSquare().square, paypal: fakePaypal().paypal, now, ...quiet,
  ...options,
});

describe("orderId", () => {
  it("is stable for a key and carries the year and month", () => {
    const a = orderId(KEY, now);

    assert.equal(a, orderId(KEY, now));
    assert.match(a, /^NFF-2610-[A-Z2-9]{4}$/);
    assert.notEqual(a, orderId("another-key-000000", now));
  });
});

describe("POST /api/orders with a card", () => {
  it("makes the Square order and payment under one key and answers paid",
    async () => {
      const { square, calls } = fakeSquare();
      const res = await run(body(), { square });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.status, "paid");
      assert.equal(data.orderId, orderId(KEY, now));
      assert.equal(data.totals.total, 5500);
      assert.equal(data.payment.method, "card");
      assert.equal(data.payment.last4, "4242");
      assert.equal(data.payment.receiptUrl, "https://sq/receipt");
      assert.equal(data.lines[0].unitPrice, 30);

      const k = attemptKey(KEY, 1);

      assert.deepEqual(calls[0], ["order", k, orderId(KEY, now)]);
      assert.equal(calls[1][0], "payment");
      assert.equal(calls[1][1], k);
      assert.deepEqual(calls[1][2], {
        sourceId: "cnon:tok", verificationToken: undefined,
      });
    });

  it("persists the paid record, its indexes, the customer and the stock",
    async () => {
      const stores = testStores();

      await setCount(stores, SKU, 5);
      await run(body(), { stores });

      const id = orderId(KEY, now);
      const saved = await getOrder(stores, id);

      assert.equal(saved.status, "paid");
      assert.equal(saved.paidAt, now.toISOString());
      assert.equal(saved.fulfilment.state, "requested");
      assert.deepEqual(saved.square, {
        squareOrderId: "SQO", customerId: "CUST",
      });
      assert.equal(saved.payment.via, "square");
      assert.equal(saved.payment.squarePaymentId, "PAY");
      assert.equal(saved.meta.attempt, 1);
      assert.equal(saved.meta.idempotencyKey, KEY);
      assert.equal(saved.history[0].event, "paid");
      assert.deepEqual((await openOrders(stores)).map((o) => o.id), [id]);
      assert.equal((await getCustomer(stores, "pat@example.com")).name,
        "Pat Example");
      assert.equal((await getCounts(stores))[SKU], 3);
      assert.equal((await readMark(stores, "paid")).id, id);

      // The same submission again is the same record, once.
      await run(body(), { stores });
      assert.equal((await openOrders(stores)).length, 1);
      assert.equal((await getCounts(stores))[SKU], 3);
    });

  it("emails the customer and the farm, once each", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const env = {
      ADMIN_EMAILS: "farm@x.com", SQUARE_ENV: "production",
      URL: "https://northfosterfarm.com", ACCOUNTS_ENABLED: "true",
    };

    await run(body(), { stores, mail, env });

    const customer = sent.filter((m) => !Array.isArray(m.to));
    const farm = sent.filter((m) => Array.isArray(m.to));

    assert.equal(customer.length, 1);
    assert.equal(customer[0].subject, "Payment received");
    assert.match(customer[0].text, /- Requested: Wednesday, October 7/);
    assert.equal(farm.length, 1);
    assert.deepEqual(farm[0].to, ["farm@x.com"]);
    assert.match(farm[0].subject, /^New order NFF-.* — \$55, on-farm pickup$/);
    assert.match(farm[0].text, /Paid: \*\*\$55 by Visa ending 4242\*\*/);
    assert.match(farm[0].text,
      /app\.squareup\.com\/dashboard\/orders\/overview\/SQO/);
    assert.match(farm[0].text, /bin\/nff orders confirm NFF-/);

    const saved = await getOrder(stores, orderId(KEY, now));

    assert.equal(saved.emails.paymentReceived.id, "m1");
    assert.equal(saved.emails.farmOrderPlaced.id, "m2");

    await run(body(), { stores, mail, env });
    assert.equal(sent.length, 2, "a retry sends nothing again");

    // A delivery is confirmed by paying.
    const { sent: sent2, mail: mail2 } = mailbox();

    await run(delivery(), { stores: testStores(), mail: mail2, env });
    assert.equal(sent2[0].subject, "Your order is confirmed");
    assert.match(sent2[0].text, /Your payment of \$60 came through/);
  });

  it("answers 402 on a decline, closes the Square order, keeps nothing",
    async () => {
      const stores = testStores();
      const { square, calls } = fakeSquare({
        pay: () => {
          throw new SquareError("x", {
            declined: true, code: "CARD_DECLINED",
          });
        },
      });
      const res = await run(body(), { stores, square });
      const data = await res.json();

      assert.equal(res.status, 402);
      assert.equal(data.declined, true);
      assert.equal(data.code, "CARD_DECLINED");
      assert.match(data.message, /declined/);
      assert.deepEqual(calls.at(-1), ["cancel", "SQO"]);
      assert.equal(await getOrder(stores, orderId(KEY, now)), null);
      assert.equal(await readCount(stores, "declined", "2026-10-06"), 1);

      // The next try is a fresh set of keys.
      calls.length = 0;
      await run(body({ attempt: 2 }), { stores, square });
      assert.equal(calls[0][1], attemptKey(KEY, 2));
      assert.notEqual(calls[0][1], attemptKey(KEY, 1));
    });

  it("refuses a total that no longer matches, charging nothing",
    async () => {
      const { square, calls } = fakeSquare();
      const res = await run(body({ claimedTotal: 5000 }), { square });
      const data = await res.json();

      assert.equal(res.status, 422);
      assert.match(data.errors.total, /total changed/);
      assert.equal(data.totals.total, 5500);
      assert.deepEqual(calls, []);
    });

  it("applies a signed-in customer's discount group from the record",
    async () => {
      const stores = testStores();
      const session = await createSession(stores, "pat@example.com", { now });

      await saveCustomer(stores, {
        ...(await getCustomer(stores, "pat@example.com")),
        discountGroup: "wholesale",
      });

      // $60 subtotal: wholesale 20% ($12) beats the $5 tier.
      const res = await handle(post(body({ claimedTotal: 4800 }), {
        cookie: `nff_session=${session.id}`,
      }), { square: fakeSquare().square, stores, now, ...quiet });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.totals.discountAmount, 1200);
      assert.equal(data.totals.discountLabel, "Wholesale (20%)");

      // The payload cannot claim a group.
      const anon = await run({ ...body(), group: "wholesale" }, {
        stores: testStores(),
      });

      assert.equal((await anon.json()).totals.discountAmount, 500);
    });

  it("refuses what just sold out", async () => {
    const stores = testStores();

    await setCount(stores, SKU, 1);

    const short = await run(body(), { stores });
    const data = await short.json();

    assert.equal(short.status, 422);
    assert.match(data.errors[`lines.${SKU}`], /Only 1/);
    assert.equal(data.stock[SKU].available, 1);
  });

  it("wants a payment method and a card token", async () => {
    const none = await run(body({ payment: undefined }));

    assert.equal(none.status, 422);
    assert.ok((await none.json()).errors.payment);

    const odd = await run(body({ payment: { method: "cheque" } }));

    assert.equal(odd.status, 422);

    const bare = await run(body({ payment: { method: "card" } }));

    assert.equal(bare.status, 422);
    assert.match((await bare.json()).errors.payment, /card details/);
  });
});

describe("POST /api/orders with Venmo", () => {
  it("creates the PayPal order and keeps the checkout, then captures it",
    async () => {
      const stores = testStores();
      const { paypal, calls: ppCalls } = fakePaypal();
      const { square, calls: sqCalls } = fakeSquare();
      const { sent, mail } = mailbox();
      const env = { ADMIN_EMAILS: "farm@x.com" };
      const create = await run(body({
        payment: { method: "venmo", stage: "create" },
      }), { stores, paypal, square, mail, env });
      const first = await create.json();
      const id = orderId(KEY, now);

      assert.equal(create.status, 200);
      assert.deepEqual(first, { orderId: id, paypalOrderId: "PPO" });
      assert.deepEqual(ppCalls, [["create", attemptKey(KEY, 1), id]]);
      assert.deepEqual(sqCalls, []);

      const kept = await getCheckout(stores, KEY);

      assert.equal(kept.paypalOrderId, "PPO");
      assert.equal(kept.order.id, id);
      assert.equal(kept.order.totals.total, 5500);
      assert.equal(await getOrder(stores, id), null, "no record yet");

      const capture = await run(body({
        payment: { method: "venmo", stage: "capture", paypalOrderId: "PPO" },
      }), { stores, paypal, square, mail, env });
      const data = await capture.json();

      assert.equal(capture.status, 200);
      assert.equal(data.status, "paid");
      assert.equal(data.payment.via, "venmo");
      assert.equal(data.payment.method, "venmo");
      assert.deepEqual(ppCalls[1], ["capture", attemptKey(KEY, 1), "PPO"]);
      assert.equal(sqCalls[0][0], "order");
      assert.equal(sqCalls[1][0], "payment");
      assert.deepEqual(sqCalls[1][2], {
        external: { source: "Venmo", sourceId: "CAP" },
      });

      const saved = await getOrder(stores, id);

      assert.equal(saved.status, "paid");
      assert.equal(saved.payment.paypalCaptureId, "CAP");
      assert.equal(saved.payment.squarePaymentId, "PAY");
      assert.deepEqual(saved.square, {
        squareOrderId: "SQO", customerId: "CUST",
      });
      assert.equal(await getCheckout(stores, KEY), null);
      assert.match(sent.find((m) => Array.isArray(m.to)).text,
        /Paid: \*\*\$55 by Venmo\*\*/);
    });

  it("refuses a capture that names another PayPal order", async () => {
    const stores = testStores();
    const { paypal } = fakePaypal();

    await run(body({ payment: { method: "venmo", stage: "create" } }),
      { stores, paypal });
    const res = await run(body({
      payment: { method: "venmo", stage: "capture", paypalOrderId: "OTHER" },
    }), { stores, paypal });

    assert.equal(res.status, 409);
    assert.match((await res.json()).errors.payment, /Start again/);
    assert.equal(await getOrder(stores, orderId(KEY, now)), null);

    const missing = await run(body({
      payment: { method: "venmo", stage: "capture" },
    }), { stores, paypal });

    assert.equal(missing.status, 422);

    const which = await run(body({ payment: { method: "venmo" } }),
      { stores, paypal });

    assert.equal(which.status, 422);
  });

  it("keeps the order when Square fails after the capture, and alerts",
    async () => {
      const stores = testStores();
      const { paypal } = fakePaypal();
      const { sent, mail } = mailbox();
      const env = { ADMIN_EMAILS: "farm@x.com" };
      const square = {
        createOrder: async () => {
          throw new SquareError("down", { retryable: false });
        },
        createPayment: async () => { throw new Error("unreachable"); },
        cancelOrder: async () => {},
      };

      await run(body({ payment: { method: "venmo", stage: "create" } }),
        { stores, paypal, square, mail, env });
      const res = await run(body({
        payment: { method: "venmo", stage: "capture", paypalOrderId: "PPO" },
      }), { stores, paypal, square, mail, env });

      assert.equal(res.status, 200);

      const saved = await getOrder(stores, orderId(KEY, now));

      assert.equal(saved.status, "paid");
      assert.equal(saved.square, null);
      assert.equal(saved.payment.squarePaymentId, null);
      assert.equal(saved.payment.paypalCaptureId, "CAP");
      assert.ok(sent.some((m) =>
        m.subject === "Site alert: square.record_failed"));
    });
});

describe("POST /api/orders, the gate", () => {
  it("rejects a bad body", async () => {
    const res = await run("{nope");

    assert.equal(res.status, 400);
  });

  it("drops the honeypot silently", async () => {
    const res = await run(body({ website: "spam" }));

    assert.equal(res.status, 204);
  });

  it("requires a submission key", async () => {
    const res = await run(body({ idempotencyKey: "" }));

    assert.equal(res.status, 422);
  });

  it("returns 422 with field errors", async () => {
    const res = await run(body({ lines: [] }));
    const data = await res.json();

    assert.equal(res.status, 422);
    assert.ok(data.errors.lines);
  });

  it("returns 409 and fresh dates when the date is stale", async () => {
    const stale = body();

    stale.fulfilment.date = "2026-10-06";
    const res = await run(stale);
    const data = await res.json();

    assert.equal(res.status, 409);
    assert.equal(data.dates[0].date, "2026-10-07");
  });

  it("retries a transient Square failure then succeeds", async () => {
    let calls = 0;
    const { square } = fakeSquare();

    square.createOrder = async () => {
      calls++;
      if (calls < 3) throw new SquareError("503", { retryable: true });

      return { squareOrderId: "SQO", customerId: "CUST" };
    };
    const res = await run(body(), { square });

    assert.equal(res.status, 200);
    assert.equal(calls, 3);
  });

  it("answers 503 when retries are exhausted, and alerts", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const { square } = fakeSquare();

    square.createOrder = async () => {
      throw new SquareError("503", { retryable: true });
    };
    const res = await run(body(), {
      stores, square, mail, env: { ADMIN_EMAILS: "farm@x.com" },
    });
    const data = await res.json();

    assert.equal(res.status, 503);
    assert.equal(data.retryable, true);
    assert.equal(data.orderId, orderId(KEY, now));
    assert.equal(await getOrder(stores, orderId(KEY, now)), null);
    assert.ok(sent.some((m) =>
      m.subject === "Site alert: order.create_failed"));
  });

  it("answers 502 on a permanent rejection without retrying", async () => {
    let calls = 0;
    const { square } = fakeSquare();

    square.createOrder = async () => {
      calls++;
      throw new SquareError("400", { retryable: false });
    };
    const res = await run(body(), { square });

    assert.equal(res.status, 502);
    assert.equal(calls, 1);
  });

  it("rate limits a single address", async () => {
    let last;

    for (let i = 0; i < 13; i++) {
      last = await run(body(), { ip: "203.0.113.9" });
    }
    assert.equal(last.status, 204);
  });
});
