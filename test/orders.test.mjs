import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle, orderId } from "../netlify/functions/orders.mjs";
import {
  getCustomer, getOrder, openOrders,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const now = instant("2026-10-06", 9, 0, "America/New_York");
const KEY = "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f";

const body = (overrides = {}) => ({
  idempotencyKey: KEY,
  customer: { name: "Pat Example", email: "pat@example.com", phone: "" },
  lines: [{ sku: "NFF-CHK-WHL-0350-0400", qty: 2 }],
  fulfilment: {
    method: "onfarm",
    date: "2026-10-07",
    onfarm: { window: "morning", phone: "401-555-0100", textOk: false },
  },
  claimedTotal: 5500,
  ...overrides,
});

const post = (payload, headers = {}) => new Request("http://x/api/orders", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof payload === "string" ? payload : JSON.stringify(payload),
});

const ok = async () => ({
  squareOrderId: "SQO", invoiceId: "INV", invoiceNumber: "7", invoiceUrl: "u",
});

const quiet = { sleep: async () => {} };

describe("orderId", () => {
  it("is stable for a key and carries the year and month", () => {
    const a = orderId(KEY, now);

    assert.equal(a, orderId(KEY, now));
    assert.match(a, /^NFF-2610-[A-Z2-9]{4}$/);
    assert.notEqual(a, orderId("another-key-000000", now));
  });
});

describe("POST /api/orders", () => {
  it("creates the order and returns the invoice link", async () => {
    const seen = [];
    const square = async (order, key) => {
      seen.push({ order, key });

      return ok();
    };
    const res = await handle(post(body()), { square, now, ...quiet });
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.invoiceUrl, "u");
    assert.equal(data.totals.total, 5500);
    assert.equal(seen[0].key, KEY);
    assert.equal(seen[0].order.id, orderId(KEY, now));
    assert.equal(seen[0].order.lines[0].unitPrice, 30);
  });

  it("persists the order, its Square ids and the customer", async () => {
    const stores = testStores();

    await handle(post(body()), { square: ok, stores, now, ...quiet });

    const id = orderId(KEY, now);
    const saved = await getOrder(stores, id);

    assert.equal(saved.status, "submitted");
    assert.equal(saved.square.invoiceId, "INV");
    assert.equal(saved.customer.email, "pat@example.com");
    assert.equal(saved.history[0].event, "submitted");
    assert.deepEqual((await openOrders(stores)).map((o) => o.id), [id]);
    assert.equal((await getCustomer(stores, "pat@example.com")).name,
      "Pat Example");

    // A retried submission with the same key writes the same record.
    await handle(post(body()), { square: ok, stores, now, ...quiet });
    assert.equal((await openOrders(stores)).length, 1);
  });

  it("emails the pay link and records it, and survives mail failing",
    async () => {
      const stores = testStores();
      const sent = [];
      const mail = async (message) => {
        sent.push(message);

        return { id: "email_1", driver: "test" };
      };
      const env = {
        MAIL_DRIVER: "resend", RESEND_API_KEY: "k", MAIL_FROM: "f@x",
        URL: "https://northfosterfarm.com",
      };
      let squareOpts;
      const square = async (order, key, opts) => {
        squareOpts = opts;

        return ok();
      };

      await handle(post(body()), {
        square, stores, mail, env, now, ...quiet,
      });

      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, "pat@example.com");
      assert.match(sent[0].subject, /One more step: pay for order/);
      assert.match(sent[0].text, /https:\/\/northfosterfarm.com\/account\//);
      assert.equal(squareOpts.emailInvoice, false, "our mail, not Square's");

      const saved = await getOrder(stores, orderId(KEY, now));

      assert.equal(saved.emails.completeYourOrder.id, "email_1");
      assert.equal(saved.history.at(-1).event, "mail.completeYourOrder");

      // Mail down: the order still succeeds and Square emails instead.
      const broken = testStores();
      const down = async () => { throw new Error("resend down"); };
      const res = await handle(post(body()), {
        square, stores: broken, mail: down, env: {}, now, ...quiet,
      });

      assert.equal(res.status, 200);
      assert.equal(squareOpts.emailInvoice, true, "Square emails the link");
      assert.equal((await getOrder(broken, orderId(KEY, now))).emails,
        undefined);
    });

  it("does not persist an order Square rejected", async () => {
    const stores = testStores();
    const down = async () => {
      throw Object.assign(new Error("400"), { retryable: false });
    };

    await handle(post(body()), { square: down, stores, now, ...quiet });
    assert.equal(await getOrder(stores, orderId(KEY, now)), null);
  });

  it("rejects a bad body", async () => {
    const res = await handle(post("{nope"), { square: ok, now });

    assert.equal(res.status, 400);
  });

  it("drops the honeypot silently", async () => {
    const res = await handle(post(body({ website: "spam" })), {
      square: ok, now,
    });

    assert.equal(res.status, 204);
  });

  it("requires a submission key", async () => {
    const res = await handle(post(body({ idempotencyKey: "" })), {
      square: ok, now,
    });

    assert.equal(res.status, 422);
  });

  it("returns 422 with field errors", async () => {
    const res = await handle(post(body({ lines: [] })), { square: ok, now });
    const data = await res.json();

    assert.equal(res.status, 422);
    assert.ok(data.errors.lines);
  });

  it("returns 409 and fresh dates when the date is stale", async () => {
    const stale = body();

    stale.fulfilment.date = "2026-10-06";
    const res = await handle(post(stale), { square: ok, now });
    const data = await res.json();

    assert.equal(res.status, 409);
    assert.equal(data.dates[0].date, "2026-10-07");
  });

  it("retries a transient Square failure then succeeds", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("503"), { retryable: true });

      return ok();
    };
    const res = await handle(post(body()), { square: flaky, now, ...quiet });

    assert.equal(res.status, 200);
    assert.equal(calls, 3);
  });

  it("answers 503 when retries are exhausted", async () => {
    const down = async () => {
      throw Object.assign(new Error("503"), { retryable: true });
    };
    const res = await handle(post(body()), { square: down, now, ...quiet });
    const data = await res.json();

    assert.equal(res.status, 503);
    assert.equal(data.retryable, true);
    assert.equal(data.orderId, orderId(KEY, now));
  });

  it("answers 502 on a permanent rejection without retrying", async () => {
    let calls = 0;
    const bad = async () => {
      calls++;
      throw Object.assign(new Error("400"), { retryable: false });
    };
    const res = await handle(post(body()), { square: bad, now, ...quiet });

    assert.equal(res.status, 502);
    assert.equal(calls, 1);
  });

  it("rate limits a single address", async () => {
    let last;

    for (let i = 0; i < 13; i++) {
      last = await handle(post(body()), {
        square: ok, now, ip: "203.0.113.9", ...quiet,
      });
    }
    assert.equal(last.status, 204);
  });
});
