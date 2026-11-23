// Criteria tests for #814 (the order.undeliverable console line never
// carries its idempotency key), written before the fix from the
// issue's words alone: one test per box of its "Done when" list,
// named for it. Held out of `npm test` by its name; the fix turns it
// on with
//
//   git mv test/order-undeliverable.criteria.mjs \
//     test/order-undeliverable.test.mjs
//
// The issue: fail() in assets/scripts/order/order-form.js logs
// `payload.meta.idempotencyKey` on the `order.undeliverable` console
// line, but the payload carries `idempotencyKey` at its top level and
// nothing on the page sets `meta`. The order request's key is that
// top-level `idempotencyKey`, the one prepare() sets from the draft
// and posts to /api/orders.
//
// How it reads the line: it calls OrderForm's fail() on a form
// stubbed to the few members fail() reaches (summaryText,
// contactLinks, finish, and a draft whose key is the request's), with
// a fake window, document, navigator and location, and keeps every
// console.error. The line is the one that parses as JSON with
// `event: "order.undeliverable"`; the key is read from its
// `idempotencyKey` field, the name the line has today
// (docs/refactors/order-form.md, "Observability").
//
// On next the first test fails (the field is undefined) and the second
// passes: it is a guard, so the fix carries the key and not the
// payload it sits in (#258).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

// What fail() clones and fills: any element it asks for.
const element = () => ({
  textContent: "",
  addEventListener: () => {},
});
const template = {
  content: {
    cloneNode: () => ({ querySelector: () => element() }),
  },
};

// Enough of a window and document for order-form.js's imports to load
// (Bootstrap's Tooltip reads both as it loads) and for fail() to find
// its template.
const fakeDocument = {
  readyState: "complete",
  documentElement: { dir: "ltr" },
  body: { hasAttribute: () => false },
  addEventListener: () => {},
  getElementById: () => template,
  querySelector: () => null,
  querySelectorAll: () => [],
};

const set = (name, value) => Object.defineProperty(globalThis, name, {
  value, configurable: true, writable: true,
});
const GLOBALS = ["window", "document", "navigator", "location"];
const own = () => GLOBALS.map((name) => [name,
  Object.getOwnPropertyDescriptor(globalThis, name)]);
const restore = (saved) => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
};

const before = own();

set("window", {});
set("document", fakeDocument);

const { OrderForm } = await import("../assets/scripts/order/order-form.js");

restore(before);

const KEY = "3f2b9c1e-7a4d-4e8b-9c0a-5d6e7f8a9b0c";

// A delivery order as collect() builds it, after prepare() has set
// its key and attempt. Made-up details, none a real customer's.
const payload = () => ({
  formVersion: "1",
  customer: {
    firstName: "Sam",
    lastName: "Tester",
    email: "sam.tester@example.com",
    phone: "(781) 555-0142",
    contact: "email",
    marketing: false,
  },
  lines: [{ sku: "eggs-dozen", qty: 2 }],
  fulfilment: {
    method: "delivery",
    date: "2026-12-10",
    onfarm: { window: "" },
    delivery: {
      address1: "123 Hollow Brook Road",
      address2: "Unit 4",
      town: "Scituate",
      zip: "02066",
      cooler: "",
      notes: "",
    },
  },
  code: null,
  idempotencyKey: KEY,
  attempt: 1,
});

// The form fail() runs on: only what it reaches, the rest unset.
const form = () => ({
  summaryText: () => "Sam Tester <sam.tester@example.com>",
  contactLinks: () => {},
  finish: () => {},
  draft: { key: () => KEY, attempt: () => 1 },
});

describe("the order.undeliverable console line (#814)", () => {
  const consoleError = console.error;
  let saved;
  let errors;

  beforeEach(() => {
    saved = own();
    set("document", fakeDocument);
    set("navigator", { sendBeacon: () => true, clipboard: {} });
    set("location", { pathname: "/order/" });
    errors = [];
    console.error = (...args) => errors.push(args.map(String).join(" "));
  });

  afterEach(() => {
    console.error = consoleError;
    restore(saved);
  });

  // The line fail() writes, raw and parsed.
  const line = () => {
    OrderForm.prototype.fail.call(form(), payload(),
      "We couldn't reach our payment system.");

    const found = errors.flatMap((raw) => {
      try {
        const parsed = JSON.parse(raw);

        return parsed && parsed.event === "order.undeliverable"
          ? [{ raw, parsed }] : [];
      } catch {
        return [];
      }
    });

    assert.equal(found.length, 1,
      `one order.undeliverable line, got: ${JSON.stringify(errors)}`);

    return found[0];
  };

  it("The order.undeliverable line carries the order request's " +
    "idempotency key", () => {
    assert.equal(line().parsed.idempotencyKey, KEY);
  });

  it("No full email address, phone number or street address is in " +
    "that line", () => {
    const { raw } = line();
    const { customer, fulfilment: { delivery } } = payload();
    const digits = customer.phone.replace(/\D/g, "");

    for (const detail of [customer.email, customer.phone,
      delivery.address1,`${delivery.address1}, ${delivery.address2}`]) {
      assert.ok(!raw.includes(detail), `the line holds ${detail}: ${raw}`);
    }
    assert.ok(!raw.replace(/\D/g, "").includes(digits),
      `the line holds the phone number's digits: ${raw}`);
  });
});
