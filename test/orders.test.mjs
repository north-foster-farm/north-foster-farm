import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle, orderId } from "../netlify/functions/orders.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import {
  OrderCollisionError, attemptKey, completeOrder, finishVenmo,
} from "../netlify/functions/lib/checkout.mjs";
import { readCount, readMark } from "../netlify/functions/lib/health.mjs";
import {
  getCheckout, getCustomer, getOrder, idKey, openOrders, reserveOrderId,
  saveCustomer, saveOrder, submissionKey,
} from "../netlify/functions/lib/records.mjs";
import { SquareError } from "../netlify/functions/lib/square.mjs";
import { getCounts, setCount } from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { Submitter } from "../assets/scripts/order/submit.js";
import { MORNING, SCHEDULE } from "./schedule-fixture.mjs";

const MAILS = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
};

const now = instant("2026-10-06", 9, 0, "America/New_York");
const KEY = "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f";
const SKU = "NFF-CHK-WHL-35-39";

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
    onfarm: { window: MORNING },
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
    findPaid: async () => null,
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

// Fresh stores unless a test shares its own: a submission already paid
// is answered with its record before anything is checked.
const run = (payload, options = {}) => handle(post(payload), {
  stores: testStores(), square: fakeSquare().square,
  paypal: fakePaypal().paypal, now, ...quiet, ...options,
});

describe("orderId", () => {
  it("is stable for a key and carries the year and month", () => {
    const a = orderId(KEY, now);

    assert.equal(a, orderId(KEY, now));
    assert.match(a, /^NFF-2610-[A-Z2-9]{6}$/);
    assert.notEqual(a, orderId("another-key-000000", now));
  });

  it("draws a different, equally stable id each time it is asked again",
    () => {
      const draws = [0, 1, 2].map((n) => orderId(KEY, now, n));

      assert.equal(new Set(draws).size, 3);
      assert.deepEqual(draws, [0, 1, 2].map((n) => orderId(KEY, now, n)));
      for (const id of draws) assert.match(id, /^NFF-2610-[A-Z2-9]{6}$/);
    });
});

// #253. Every draw of the stub is TAKEN for the first try, so two
// submissions collide unless the reservation sends one of them on.
const TAKEN = "NFF-2610-TAKEN2";
const collide = (key, at, n) => (n === 0 ? TAKEN : orderId(key, at, n));
const OTHER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const sam = (overrides = {}) => body({
  idempotencyKey: OTHER,
  customer: {
    firstName: "Sam", lastName: "Okafor", email: "sam@example.com",
    phone: "401-555-0199", contact: "text",
  },
  ...overrides,
});
// A Square that charges once per idempotency key, as the real one does.
const charges = () => {
  const { square, calls } = fakeSquare();

  return {
    square,
    charged: () => new Set(calls.filter((c) => c[0] === "payment")
      .map((c) => c[1])).size,
  };
};

describe("POST /api/orders, two submissions drawing one id (#253)", () => {
  it("gives the second a fresh id, charges each once, shows neither the " +
    "other's order", async () => {
    const stores = testStores();
    const pat = charges();
    const other = charges();
    const first = await run(body(), {
      stores, square: pat.square, newId: collide,
    });
    const a = await first.json();
    const second = await run(sam(), {
      stores, square: other.square, newId: collide,
    });
    const b = await second.json();

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(a.orderId, TAKEN);
    assert.equal(b.orderId, orderId(OTHER, now, 1));
    assert.equal(pat.charged(), 1);
    assert.equal(other.charged(), 1);
    assert.doesNotMatch(JSON.stringify(b), /pat@example\.com|Pat/);
    assert.doesNotMatch(JSON.stringify(a), /sam@example\.com|Sam/);
    assert.equal((await getOrder(stores, TAKEN)).customer.email,
      "pat@example.com");
    assert.equal((await getOrder(stores, b.orderId)).customer.email,
      "sam@example.com");
  });

  it("lets exactly one of two racing submissions keep the id", async () => {
    const stores = testStores();
    const [x, y] = await Promise.all([
      run(body(), { stores, newId: collide }),
      run(sam(), { stores, newId: collide }),
    ]);
    const ids = [(await x.json()).orderId, (await y.json()).orderId];

    assert.equal(ids.filter((id) => id === TAKEN).length, 1);
    assert.equal(new Set(ids).size, 2);
    assert.equal((await stores.orders.get(idKey(TAKEN))).key,
      ids[0] === TAKEN ? KEY : OTHER);
  });

  it("answers a true retry with its own order and no second charge",
    async () => {
      const stores = testStores();
      const pat = charges();

      await setCount(stores, SKU, 6);
      await run(sam(), { stores, newId: collide });

      const once = await (await run(body(), {
        stores, square: pat.square, newId: collide,
      })).json();
      const again = await (await run(body(), {
        stores, square: pat.square, newId: collide,
      })).json();

      assert.equal(once.orderId, orderId(KEY, now, 1));
      assert.deepEqual(again, once);
      assert.equal(pat.charged(), 1, "one idempotency key, one charge");
      assert.equal((await getCounts(stores))[SKU], 2, "two orders of two");

      // In the next month the retry still finds its id.
      const later = new Date(now.getTime() + 30 * 24 * 60 * 60_000);

      assert.equal(await reserveOrderId(stores, KEY,
        (n) => orderId(KEY, later, n), later), once.orderId);
    });

  it("passes over an id an older record holds without a reservation",
    async () => {
      const stores = testStores();

      await saveOrder(stores, {
        id: TAKEN, status: "paid", submittedAt: now.toISOString(),
        customer: { email: "lee@example.com", name: "Lee" },
        meta: { idempotencyKey: "an-older-submission-key" },
      }, now);

      const data = await (await run(body(), { stores, newId: collide }))
        .json();

      assert.equal(data.orderId, orderId(KEY, now, 1));
      assert.doesNotMatch(JSON.stringify(data), /lee@example\.com/);
    });

  it("shows the processor's error off production only, even with " +
    "SQUARE_ENV missing", async () => {
    const failing = () => fakeSquare({
      pay: async () => {
        throw new SquareError("processor said no", { retryable: false });
      },
    }).square;
    const env = { ...MAILS, PICKUP_SCHEDULE: SCHEDULE };
    const sandbox = await run(body(), {
      square: failing(), env: { ...env, SQUARE_ENV: "sandbox" },
    });
    const bare = await run(body(), {
      square: failing(),
      env: { ...env, SITE_CONTEXT: "production" },
    });

    assert.equal(sandbox.status, 502);
    assert.match((await sandbox.json()).detail.error, /processor said no/);
    assert.equal(bare.status, 502);
    assert.equal((await bare.json()).detail, undefined);
  });

  it("refuses, alerts and shows nothing when another's record turns up " +
    "after the charge", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const env = { ...MAILS, PICKUP_SCHEDULE: SCHEDULE };
    const { square } = fakeSquare({
      // The reservation was somehow lost, and Lee's order landed in
      // between: the record must not be answered with.
      pay: async (args) => {
        await stores.orders.set(`order/${args.order.id}`, {
          id: args.order.id, status: "paid",
          customer: { email: "lee@example.com", name: "Lee" },
          meta: { idempotencyKey: "someone-else-entirely" },
        });

        return { squarePaymentId: "PAY-PAT", status: "COMPLETED" };
      },
    });
    const res = await run(body(), { stores, square, mail, env });
    const data = await res.json();

    assert.equal(res.status, 502);
    assert.equal(data.retryable, false);
    assert.equal(data.orderId, undefined);
    assert.doesNotMatch(JSON.stringify(data), /lee@example\.com|Lee/);

    const alerted = sent.find((m) =>
      m.subject === "Site alert: order.id_collision");

    assert.ok(alerted);
    assert.match(alerted.text, /PAY-PAT/);
    assert.equal((await getOrder(stores, orderId(KEY, now))).customer.email,
      "lee@example.com", "Lee's record is untouched");
  });
});

// #268. The first attempt's charge went through and its answer was
// lost: no record, and the page tries again with fresh keys.
describe("POST /api/orders, a payment whose answer was lost (#268)", () => {
  const lost = (extra = {}) => ({
    squarePaymentId: "PAY-LOST", status: "COMPLETED",
    receiptUrl: "https://sq/lost", brand: "VISA", last4: "1111",
    wallet: null, squareOrderId: "SQO-LOST", customerId: "CUST-LOST",
    amount: 5500, external: false, ...extra,
  });
  const withFind = (find) => {
    const { square, calls } = fakeSquare();
    const searched = [];

    square.findPaid = async (order) => {
      searched.push(order.id);

      return find(order);
    };

    return { square, calls, searched };
  };

  it("records the payment found and charges nothing again", async () => {
    const stores = testStores();
    const { square, calls, searched } = withFind(() => lost());
    const res = await run(body({ attempt: 2 }), { stores, square });
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.status, "paid");
    assert.equal(data.payment.last4, "1111");
    assert.deepEqual(calls, [], "no Square order, no payment");
    assert.deepEqual(searched, [data.orderId]);

    const saved = await getOrder(stores, data.orderId);

    assert.equal(saved.payments.length, 1);
    assert.equal(saved.payments[0].squarePaymentId, "PAY-LOST");
    assert.equal(saved.square.squareOrderId, "SQO-LOST");

    // And a third try is answered from the record, not searched again.
    const again = await run(body({ attempt: 3 }), { stores, square });

    assert.equal(again.status, 200);
    assert.deepEqual(calls, []);
    assert.equal(searched.length, 1);
  });

  it("does not search on the first attempt", async () => {
    const { square, calls, searched } = withFind(() => lost());
    const res = await run(body(), { square });

    assert.equal(res.status, 200);
    assert.deepEqual(searched, []);
    assert.equal(calls.filter((c) => c[0] === "payment").length, 1);
  });

  it("charges as usual when Square holds no payment", async () => {
    const stores = testStores();
    const { square, calls, searched } = withFind(() => null);
    const res = await run(body({ attempt: 2 }), { stores, square });

    assert.equal(res.status, 200);
    assert.equal(searched.length, 1);
    assert.deepEqual(calls.map((c) => c[0]), ["order", "payment"]);
    assert.equal(calls[1][1], attemptKey(KEY, 2));
  });

  it("charges nothing and tells the farm when the amount differs",
    async () => {
      const stores = testStores();
      const { square, calls } = withFind(() => lost({ amount: 9000 }));
      const res = await run(body({ attempt: 2 }), {
        stores, square,
        env: { ...MAILS, PICKUP_SCHEDULE: SCHEDULE },
      });
      const data = await res.json();

      assert.equal(res.status, 409);
      assert.match(data.errors.payment, /do not pay again/);
      assert.deepEqual(calls, []);
      assert.equal(await getOrder(stores, orderId(KEY, now)), null);
      assert.ok(await readMark(stores, "alert/payment.unreconciled"));
    });

  it("charges nothing when the payment found came through Venmo",
    async () => {
      const stores = testStores();
      const { square, calls } = withFind(() => lost({ external: true }));
      const res = await run(body({ attempt: 2 }), { stores, square });

      assert.equal(res.status, 409);
      assert.deepEqual(calls, []);
      assert.ok(await readMark(stores, "alert/payment.unreconciled"));
    });

  it("charges nothing when Square cannot say", async () => {
    const stores = testStores();
    const { square, calls } = withFind(() => {
      throw new SquareError("Square 503", { retryable: true });
    });
    const res = await run(body({ attempt: 2 }), { stores, square });
    const data = await res.json();

    assert.equal(res.status, 503);
    assert.equal(data.retryable, true);
    assert.deepEqual(calls, []);
    assert.equal(await getOrder(stores, orderId(KEY, now)), null);
  });
});

describe("POST /api/orders, a submission already paid (#253)", () => {
  it("answers a new attempt with the order, charging nothing more",
    async () => {
      const stores = testStores();
      const pat = charges();
      const first = await (await run(body(), {
        stores, square: pat.square,
      })).json();
      const res = await run(body({ attempt: 2 }), {
        stores, square: pat.square,
        now: new Date(now.getTime() + 60 * 60_000),
      });

      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), first);
      assert.equal(pat.charged(), 1);
      assert.equal((await getOrder(stores, first.orderId)).payments.length,
        1);
    });

  it("never starts or captures Venmo for it", async () => {
    const stores = testStores();
    const { paypal, calls } = fakePaypal();
    const first = await (await run(body(), { stores })).json();

    for (const stage of ["create", "capture"]) {
      const res = await run(body({
        attempt: 2, payment: { method: "venmo", stage, paypalOrderId: "PPO" },
      }), { stores, paypal });

      assert.equal(res.status, 200, stage);
      assert.equal((await res.json()).orderId, first.orderId, stage);
    }
    assert.deepEqual(calls, []);
  });

  it("charges a double tap once", async () => {
    const stores = testStores();
    const pat = charges();
    const [a, b] = await Promise.all([
      run(body(), { stores, square: pat.square }),
      run(body(), { stores, square: pat.square }),
    ]);

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(pat.charged(), 1);
  });
});

describe("POST /api/orders, when the reservation fails (#253)", () => {
  const env = { ...MAILS, PICKUP_SCHEDULE: SCHEDULE };

  // Blobs answers { modified: true } for a conditional write that
  // failed with anything but a 412; here the write is simply dropped.
  const dropping = (stores, drop) => {
    const real = stores.orders;

    stores.orders = {
      ...real,
      create: async (k, v) => (drop(k) ? true : real.create(k, v)),
    };

    return () => { stores.orders = real; };
  };

  for (const [what, drop] of [
    ["the id", (k) => k === idKey(orderId(KEY, now))],
    ["the pointer", (k) => k.startsWith("submission/")],
  ]) {
    it(`answers 503 when ${what} does not stick, and the retry keeps one id`,
      async () => {
        const stores = testStores();
        const pat = charges();
        const { sent, mail } = mailbox();
        const restore = dropping(stores, drop);
        const res = await run(body(), {
          stores, square: pat.square, mail, env,
        });

        assert.equal(res.status, 503);
        assert.equal((await res.json()).retryable, true);
        assert.equal(pat.charged(), 0);
        assert.ok(sent.some((m) =>
          m.subject === "Site alert: order.reserve_failed"));

        restore();

        const again = await (await run(body(), {
          stores, square: pat.square,
        })).json();

        assert.equal(again.orderId, orderId(KEY, now));
        assert.equal(pat.charged(), 1);
        assert.equal((await stores.orders.list("order/")).length, 1);
        assert.deepEqual(await stores.orders.get(submissionKey(KEY)), {
          id: again.orderId,
        });
      });
  }

  it("answers 503 and charges nothing when every draw is taken",
    async () => {
      const stores = testStores();
      const pat = charges();

      for (let n = 0; n < 8; n++) {
        await stores.orders.create(idKey(orderId(KEY, now, n)), { key: "x" });
      }

      const res = await run(body(), { stores, square: pat.square });

      assert.equal(res.status, 503);
      assert.equal(pat.charged(), 0);
    });
});

describe("completeOrder and finishVenmo, on another's record", () => {
  const theirs = (id) => ({
    id, status: "paid", submittedAt: now.toISOString(),
    customer: { email: "lee@example.com", name: "Lee" },
    payments: [{ via: "venmo", paypalOrderId: "PPO" }],
    meta: { idempotencyKey: "someone-else-entirely" },
  });

  it("throws rather than return it", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const env = { ...MAILS };

    await saveOrder(stores, theirs("NFF-2610-ABCD"), now);
    await assert.rejects(completeOrder(stores, {
      id: "NFF-2610-ABCD", meta: { idempotencyKey: KEY },
    }, { square: null, payment: { squarePaymentId: "PAY" } }, {
      mail, env, now,
    }), OrderCollisionError);

    const { paypal, calls } = fakePaypal();

    await assert.rejects(finishVenmo(stores, {
      id: "NFF-2610-ABCD", meta: { idempotencyKey: KEY },
    }, { key: KEY, paypalOrderId: "PPO" }, { paypal, mail, env, now }),
    OrderCollisionError);
    assert.deepEqual(calls, [], "nothing captured");
    assert.ok(sent.some((m) => m.subject === "Site alert: order.id_collision"));
  });
});

describe("POST /api/orders with a card", () => {
  it("answers no receipt link for a sandbox payment (#441)", async () => {
    const { square } = fakeSquare({
      pay: () => ({
        squarePaymentId: "PAY", status: "COMPLETED",
        receiptUrl: "https://squareupsandbox.com/receipt/preview/PAY",
        brand: "VISA", last4: "4242", wallet: null,
      }),
    });
    const data = await (await run(body(), { square })).json();

    assert.equal(data.status, "paid");
    assert.equal(data.payment.receiptUrl, null);
  });

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
      assert.equal(saved.fulfilment.state, "agreed", "booked by paying");
      assert.deepEqual(saved.fulfilment.onfarm, {
        window: MORNING, from: "09:00", to: "12:00",
      });
      assert.deepEqual(saved.square, {
        squareOrderId: "SQO", customerId: "CUST",
      });
      assert.equal(saved.payments[0].via, "square");
      assert.equal(saved.payments[0].squarePaymentId, "PAY");
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
      ...MAILS, SQUARE_ENV: "production",
      URL: "https://northfosterfarm.com", ACCOUNTS_ENABLED: "true",
      PICKUP_SCHEDULE: SCHEDULE,
    };

    await run(body(), { stores, mail, env });

    const customer = sent.filter((m) => !Array.isArray(m.to));
    const farm = sent.filter((m) => Array.isArray(m.to));

    assert.equal(customer.length, 1);
    assert.equal(customer[0].subject, "Your order is confirmed");
    assert.match(customer[0].text,
      /- When: Wednesday, October 7, 9 AM – noon/);
    assert.equal(farm.length, 1);
    assert.deepEqual(farm[0].to, ["farm@x.com"]);
    assert.match(farm[0].subject, /^New order NFF-.*: \$55, on-farm pickup$/);
    assert.match(farm[0].text, /Paid: \*\*\$55 by Visa ending 4242\*\*/);
    assert.match(farm[0].text,
      /app\.squareup\.com\/dashboard\/orders\/overview\/SQO/);
    assert.doesNotMatch(farm[0].text, /orders confirm/);

    const saved = await getOrder(stores, orderId(KEY, now));

    assert.equal(saved.emails.orderConfirmed.id, "m1");
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
    assert.match(data.errors[`lines.${SKU}`], /: only 1 left in stock\.$/);
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
      const env = { ...MAILS, PICKUP_SCHEDULE: SCHEDULE };
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
      assert.equal(saved.payments[0].paypalCaptureId, "CAP");
      assert.equal(saved.payments[0].squarePaymentId, "PAY");
      assert.deepEqual(saved.square, {
        squareOrderId: "SQO", customerId: "CUST",
      });
      assert.equal(await getCheckout(stores, KEY), null);
      assert.match(sent.find((m) => Array.isArray(m.to)).text,
        /Paid: \*\*\$55 by Venmo\*\*/);
    });

  it("reserves a fresh id before PayPal hears of a taken one (#253)",
    async () => {
      const stores = testStores();
      const { paypal, calls: ppCalls } = fakePaypal();
      const venmo = (stage) => sam({
        payment: { method: "venmo", stage, paypalOrderId: "PPO" },
      });

      await run(body(), { stores, newId: collide });

      const create = await (await run(venmo("create"), {
        stores, paypal, newId: collide,
      })).json();
      const fresh = orderId(OTHER, now, 1);

      assert.equal(create.orderId, fresh);
      assert.deepEqual(ppCalls[0], ["create", attemptKey(OTHER, 1), fresh]);

      const res = await run(venmo("capture"), {
        stores, paypal, newId: collide,
      });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.orderId, fresh);
      assert.doesNotMatch(JSON.stringify(data), /pat@example\.com|Pat/);
      assert.equal((await getOrder(stores, fresh)).customer.email,
        "sam@example.com");
      assert.equal((await getOrder(stores, TAKEN)).customer.email,
        "pat@example.com");

      // The page's retry of the capture answers with the same order.
      const again = await (await run(venmo("capture"), {
        stores, paypal, newId: collide,
      })).json();

      assert.equal(again.orderId, fresh);
      assert.equal(ppCalls.filter((c) => c[0] === "capture").length, 1);
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
      const env = { ...MAILS, PICKUP_SCHEDULE: SCHEDULE };
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
      assert.equal(saved.payments[0].squarePaymentId, null);
      assert.equal(saved.payments[0].paypalCaptureId, "CAP");
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
      stores, square, mail,
      env: { ...MAILS, PICKUP_SCHEDULE: SCHEDULE },
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

  it("rate limits a single address, and says so", async () => {
    let last;

    for (let i = 0; i < 13; i++) {
      last = await run(body(), { ip: "203.0.113.9" });
    }
    assert.equal(last.status, 429);
    assert.equal(last.headers.get("Retry-After"), "600");
    assert.match((await last.json()).message, /too many tries/);
  });

  // #154: the page once took the limit's answer for a placed order. The
  // handler's own answer, fed to the page's Submitter, must read busy.
  it("gives the page an answer it never reads as placed", async () => {
    const realFetch = globalThis.fetch;
    let last;

    for (let i = 0; i < 13; i++) {
      last = await run(body(), { ip: "203.0.113.14" });
    }
    globalThis.fetch = async () => last;
    try {
      const outcome = await new Submitter().send(body());

      assert.equal(outcome.kind, "busy");
      assert.match(outcome.message, /too many tries/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("lets the staging token past the limit, never in production",
    async () => {
      const token = { "X-Staging-Token": "t0k" };
      const hammer = async (ip, env, headers) => {
        let last;

        for (let i = 0; i < 13; i++) {
          last = await handle(post(body(), headers), {
            square: fakeSquare().square, paypal: fakePaypal().paypal, now,
            ...quiet, ip, env,
          });
        }

        return last.status;
      };
      const staging = { SITE_CONTEXT: "branch-deploy", STAGING_TOKEN: "t0k" };
      const live = { SITE_CONTEXT: "production", STAGING_TOKEN: "t0k" };

      assert.notEqual(await hammer("203.0.113.10", staging, token), 429);
      assert.equal(await hammer("203.0.113.11", staging, {}), 429);
      assert.equal(await hammer("203.0.113.12", staging, {
        "X-Staging-Token": "wrong",
      }), 429);
      assert.equal(await hammer("203.0.113.13", live, token), 429);
    });
});
