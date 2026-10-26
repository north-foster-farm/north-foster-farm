// What the site logs (and so what Axiom stores) carries order ids, not
// customers' email addresses, names, phone numbers or street
// addresses (#267). The scrub in lib/log.mjs holds for every call
// site; the second block fails if a real failure path logs one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { log, scrub } from "../netlify/functions/lib/log.mjs";
import { SquareError } from "../netlify/functions/lib/square.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle as ordersApi } from "../netlify/functions/orders.mjs";
import { MORNING, SCHEDULE } from "./schedule-fixture.mjs";

const MAILS = {
  FARM_NOTIFICATIONS_EMAIL: "farm@example.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@example.com",
};

const now = instant("2026-10-06", 9, 0, "America/New_York");
const PERSONAL = [
  "pat.example@gmail.test", "Pat", "Examplesen", "401-555-0142",
  "17 Quiet Lane",
];
const env = {
  ...MAILS,
  SITE_URL: "https://staging.example.com",
  PICKUP_SCHEDULE: SCHEDULE,
};

const capture = (t) => {
  const lines = [];

  for (const level of ["info", "warn", "error"]) {
    t.mock.method(console, level, (text) => {
      lines.push(String(text));
    });
  }

  return lines;
};

describe("the log scrub", () => {
  it("replaces an email address with a hash that stays the same", () => {
    const a = scrub({ message: "No mail for Pat.Example@gmail.test" });
    const b = scrub({ message: "No mail for pat.example@gmail.test" });

    assert.match(a.message, /^No mail for \[email:[0-9a-f]{8}\]$/);
    assert.equal(a.message, b.message);
  });

  it("replaces a phone number but not a date or an id", () => {
    const out = scrub({
      a: "call 401-555-0142 or (401) 555 0142 or +1 401.555.0142",
      b: "2026-10-18T09:00:00Z on NFF-2610-AAAAAA, 12345678",
    });

    assert.equal(out.a, "call [phone] or [phone] or [phone]");
    assert.equal(out.b, "2026-10-18T09:00:00Z on NFF-2610-AAAAAA, 12345678");
  });

  it("removes the fields that hold contact details, at any depth", () => {
    const out = scrub({
      id: "NFF-2610-AAAAAA",
      order: {
        id: "NFF-2610-AAAAAA",
        customer: { name: "Pat Examplesen", phone: "401-555-0142" },
        fulfilment: {
          method: "delivery",
          address: { street: "17 Quiet Lane", zip: "02857" },
          notes: "Leave at the side door",
        },
        lines: [{ sku: "NFF-CHK-WHL-35-39", qty: 2 }],
      },
    });

    assert.equal(out.order.customer, "[removed]");
    assert.equal(out.order.fulfilment.address, "[removed]");
    assert.equal(out.order.fulfilment.notes, "[removed]");
    assert.equal(out.order.fulfilment.method, "delivery");
    assert.deepEqual(out.order.lines,
      [{ sku: "NFF-CHK-WHL-35-39", qty: 2 }]);
  });

  it("scrubs an error and survives a loop", () => {
    const loop = { id: "x" };

    loop.self = loop;

    const out = scrub({
      error: new Error("bounced: pat.example@gmail.test"), loop,
    });

    assert.doesNotMatch(JSON.stringify(out), /pat\.example@/);
  });

  it("scrubs every line log writes", (t) => {
    const lines = capture(t);

    log.warn({
      event: "test", id: "NFF-2610-AAAAAA",
      customer: { email: "pat.example@gmail.test" },
      error: "rejected pat.example@gmail.test",
    });

    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /pat\.example@/);
    assert.match(lines[0], /NFF-2610-AAAAAA/);
  });
});

describe("a failed order", () => {
  it("logs the order's id and none of the customer", async (t) => {
    const lines = capture(t);
    const detail = [{
      code: "INVALID_EMAIL_ADDRESS",
      detail: "pat.example@gmail.test is not valid, 401-555-0142",
    }];
    const res = await ordersApi(new Request("https://x/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
        attempt: 1,
        customer: {
          firstName: "Pat", lastName: "Examplesen",
          email: "pat.example@gmail.test", phone: "401-555-0142",
          contact: "call",
        },
        lines: [{ sku: "NFF-CHK-WHL-35-39", qty: 2 }],
        fulfilment: {
          method: "onfarm", date: "2026-10-07", onfarm: { window: MORNING },
        },
        claimedTotal: 5500,
        payment: { method: "card", sourceId: "cnon:tok" },
      }),
    }), {
      stores: testStores(), env, now, sleep: async () => {},
      mail: async () => ({ id: "m", driver: "test" }),
      square: {
        createOrder: async () => {
          throw new SquareError("Square 400 on /orders", {
            status: 400, detail,
          });
        },
      },
    });

    assert.notEqual(res.status, 200);

    const logged = lines.join("\n");

    assert.match(logged, /order\.failed/, "the failure path ran");
    assert.match(logged, /NFF-\d{4}-[A-Z0-9]+/, "and names the order");

    for (const text of PERSONAL) {
      assert.ok(!logged.includes(text), `the log holds ${text}`);
    }
  });
});
