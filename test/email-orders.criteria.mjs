// Criteria tests for #678, boxes 1 to 3 of its "Done when": an email
// address ending in a period goes through without it, a malformed
// domain is refused before Square, and Square's own refusal of an
// address is a field error, not the "our end" panel. Written from the
// issue alone, before the fix (2026-11-19).
//
// Held out of `npm test` by its name until the fix lands; the
// implementer turns it on with
//
//   git mv test/email-orders.criteria.mjs test/email-orders.test.mjs
//
// The server runs whole: orders.mjs with the real lib/square.mjs, over
// a fetch that answers with Square's recorded answers
// (test/fixtures/square/), so what reaches Square's customer search
// and create can be read off the requests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import { handle } from "../netlify/functions/orders.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import { getOrder } from "../netlify/functions/lib/records.mjs";
import { readMark } from "../netlify/functions/lib/health.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import { validateOrder } from "../assets/scripts/order/lib/validate.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { validField } from "../assets/scripts/utils/field-errors.mjs";
import { recorded } from "./recorded.mjs";
import { MORNING, SCHEDULE } from "./schedule-fixture.mjs";

const now = instant("2026-10-06", 9, 0, "America/New_York");
const KEY = "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f";

const ENV = {
  SQUARE_ENV: "sandbox", SQUARE_ACCESS_TOKEN: "tok",
  SQUARE_LOCATION_ID: "LOC", PICKUP_SCHEDULE: SCHEDULE,
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
};

// The existing email field error, as the page shows it under the field.
const EMAIL_ERROR = validField("email");

const order = (email) => ({
  idempotencyKey: KEY,
  attempt: 1,
  customer: {
    firstName: "Pat", lastName: "Example", email,
    phone: "401-555-0100", contact: "call",
  },
  lines: [{ sku: "NFF-CHK-WHL-35-39", qty: 2 }],
  fulfilment: {
    method: "onfarm", date: "2026-10-07", onfarm: { window: MORNING },
  },
  claimedTotal: 5500,
  payment: { method: "card", sourceId: "cnon:card-nonce-ok" },
});

// Square, as recorded: each path answers with its recording, and every
// request is kept. `search` names the recording for the customer
// search.
const SQUARE = {
  "/v2/customers": "customer-create",
  "/v2/orders": "order-create-pickup",
  "/v2/payments": "payment-card-ok",
};

const square = ({ search = "customers-search-none" } = {}) => {
  const calls = [];
  const impl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const name = path === "/v2/customers/search" ? search : SQUARE[path];

    calls.push({
      method: init.method || "GET",
      path,
      body: init.body ? JSON.parse(init.body) : null,
    });
    if (!name) return new Response("{}", { status: 500 });

    const { status, response } = recorded("square", name);

    return new Response(JSON.stringify(response), {
      status, headers: { "Content-Type": "application/json" },
    });
  };

  return { impl, calls };
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

const submit = async (email, { search } = {}) => {
  const stores = testStores();
  const net = square({ search });
  const { sent, mail } = mailbox();
  const res = await handle(new Request("http://x/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(order(email)),
  }), {
    stores, env: ENV, now, mail, fetchImpl: net.impl,
    sleep: async () => {},
  });

  return { res, data: await res.json(), stores, calls: net.calls, sent };
};

const index = indexCatalog(catalog);
const gate = (email) => validateOrder(order(email), {
  index, terms, now, schedule: parseSchedule(SCHEDULE).windows,
});

// A refusal the page shows under the email field: the validation
// answer it reads as "invalid" (assets/scripts/order/submit.js takes
// 400 and 422 alike), with the existing message on customer.email.
const assertEmailFieldError = ({ res, data }, label) => {
  assert.ok([400, 422].includes(res.status),
    `${label}: answered ${res.status}, not a validation error`);
  assert.equal(data.errors && data.errors["customer.email"], EMAIL_ERROR,
    `${label}: no email field error`);
};

describe("#678: an email address ending in a period", () => {
  it("goes through, and the saved record and Square's customer carry " +
    "it without the period", async () => {
    for (const typed of [
      "pat@example.com.",
      "pat@example.com...",
      "  Pat@Example.COM.  ",
    ]) {
      const { res, data, stores, calls } = await submit(typed);

      assert.equal(res.status, 200, `${typed}: ${JSON.stringify(data)}`);

      const search = calls.find((c) => c.path === "/v2/customers/search");
      const create = calls.find((c) =>
        c.path === "/v2/customers" && c.method === "POST");
      const payment = calls.find((c) => c.path === "/v2/payments");

      assert.ok(search, `${typed}: no customer search`);
      assert.equal(search.body.query.filter.email_address.exact,
        "pat@example.com", `${typed}: searched as typed`);
      assert.ok(create, `${typed}: no customer made`);
      assert.equal(create.body.email_address, "pat@example.com",
        `${typed}: Square's customer`);
      assert.equal(payment.body.buyer_email_address, "pat@example.com",
        `${typed}: the payment's buyer`);
      assert.equal((await getOrder(stores, data.orderId)).customer.email,
        "pat@example.com", `${typed}: the saved record`);
    }
  });
});

describe("#678: a malformed domain", () => {
  it("is refused with the email field error, in the browser and by the " +
    "server, and never reaches Square", async () => {
    for (const bad of [
      "name@example..com",
      "name@-example.com",
      "name@example-.com",
      "name@example.c",
      "name@.example.com",
      "name@example",
    ]) {
      const checked = gate(bad);

      assert.equal(checked.ok, false, `${bad}: the browser's gate took it`);
      assert.equal(checked.errors["customer.email"], EMAIL_ERROR,
        `${bad}: the browser's gate gave no email field error`);

      const answer = await submit(bad);

      assertEmailFieldError(answer, bad);
      assert.deepEqual(answer.calls, [], `${bad}: reached Square`);
    }

    // Good addresses stay good.
    for (const good of [
      "name@mail.example.com",
      "name@my-farm.example.com",
      "name+orders@example.com",
      "name2@example2.com",
      "n.ame@example.co",
      "name@example.museum",
      "name@example.photography",
    ]) {
      const checked = gate(good);

      assert.equal(checked.errors && checked.errors["customer.email"],
        undefined, `${good}: refused`);
      assert.equal(checked.ok, true, `${good}: ${
        JSON.stringify(checked.errors)}`);
    }
  });
});

describe("#678: Square refuses the address", () => {
  it("reaches the customer as an error on the email field, and no alert " +
    "says order.create_failed", async () => {
    // Square's recorded 400 INVALID_VALUE on `email` answers the search,
    // whatever the address; this one passes the site's own rule.
    const refusal = recorded("square", "customers-search-email-refused");

    assert.equal(refusal.status, 400);
    assert.equal(refusal.response.errors[0].code, "INVALID_VALUE");
    assert.equal(refusal.response.errors[0].field, "email");

    const answer = await submit("pat@example.com", {
      search: "customers-search-email-refused",
    });

    assert.ok(answer.calls.some((c) => c.path === "/v2/customers/search"),
      "the search was never sent");
    assertEmailFieldError(answer, "Square's refusal");
    assert.ok(!answer.calls.some((c) => c.path === "/v2/payments"),
      "a payment was asked for");
    assert.equal(await readMark(answer.stores, "alert/order.create_failed"),
      null, "alert raised");
    assert.ok(!answer.sent.some((m) =>
      /order\.create_failed/.test(`${m.subject} ${m.text || ""}`)),
    "an alert mail says order.create_failed");
  });
});
