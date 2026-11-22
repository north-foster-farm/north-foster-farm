// Criteria for #905 (Hotfix: Large eggs are sold as always in stock;
// count them like every other item), one test per (test) box of its
// "Done when" list, word for word. Large eggs lose `alwaysInStock`, so
// Square's count decides them as it does every other item. Held out
// of runs until the fix lands: node --test test/eggs-counted.criteria.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import {
  indexCatalog, uncounted,
} from "../assets/scripts/order/lib/catalog.mjs";
import { Stock } from "../assets/scripts/order/stock.js";
import { handle } from "../netlify/functions/orders.mjs";
import { availability, setCount } from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { MORNING } from "./schedule-fixture.mjs";

const EGGS = "NFF-CHK-EGG-LG";
const CHICKEN = "NFF-CHK-WHL-35-39";
const eggs = indexCatalog(catalog).get(EGGS);

// The words the restock label partial gives a type, as the build puts
// them in the row's data-restock-label (as test/catalog-visibility).
const PARTIAL = readFileSync(new URL(
  "../layouts/partials/order/restock-label.html", import.meta.url
), "utf8");
const WORDS = Object.fromEntries([...PARTIAL.matchAll(
  /eq \. "(\w+)" \}\}\s*\{\{ \$label = ([^\n]*?) \}\}/g
)].map(([, type, value]) => [type, value]));
const restockNote = JSON.parse(WORDS[eggs.restock]);

// An order of two whole chickens, as test/orders.test.mjs sends one,
// with Large eggs beside them.
const now = instant("2026-10-06", 9, 0, "America/New_York");
const order = (qty, claimedTotal = 0) => ({
  idempotencyKey: "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
  attempt: 1,
  customer: {
    firstName: "Pat",
    lastName: "Example",
    email: "pat@example.com",
    phone: "401-555-0100",
    contact: "call",
  },
  lines: [{ sku: CHICKEN, qty: 2 }, { sku: EGGS, qty }],
  fulfilment: {
    method: "onfarm",
    date: "2026-10-07",
    onfarm: { window: MORNING },
  },
  claimedTotal,
  payment: { method: "card", sourceId: "cnon:tok" },
});

// A Square that answers well (as test/orders.test.mjs's fake).
const square = {
  createOrder: async () => ({ squareOrderId: "SQO", customerId: "CUST" }),
  createPayment: async () => ({
    squarePaymentId: "PAY", status: "COMPLETED",
    receiptUrl: "https://sq/receipt", brand: "VISA", last4: "4242",
    wallet: null,
  }),
  cancelOrder: async (id) => ({ id, cancelled: true }),
  findPaid: async () => null,
};

const submit = (stores, payload) => handle(new Request(
  "http://x/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }
), { stores, square, now, sleep: async () => {} });

// Submits `qty` Large eggs at the total the server computes, so only
// stock can refuse it: a first try at 0 is answered with the totals.
const orderEggs = async (stores, qty) => {
  const first = await submit(stores, order(qty));
  const data = await first.json();

  if (!data.totals) return { res: first, data };

  const res = await submit(stores, order(qty, data.totals.total));

  return { res, data: await res.json() };
};

// The least of an order page row that order/stock.js marks: one Large
// eggs row as order/row.html writes it, under Full catalog.
const pageRow = () => {
  const attrs = new Set();
  const note = { textContent: "" };
  const add = { disabled: false };
  const row = {
    dataset: { restockLabel: restockNote },
    hidden: false,
    hasAttribute: (name) => attrs.has(name),
    toggleAttribute: (name, on) => {
      if (on) attrs.add(name);
      else attrs.delete(name);
    },
    querySelector: (s) => (s === "label" ? { textContent: "Large" }
      : s === "[data-stock-note]" ? note : null),
    querySelectorAll: (s) => (s === "[data-step]" ? [add] : []),
  };
  const input = {
    dataset: { qty: EGGS }, value: "2", disabled: false,
    closest: () => row,
  };
  const form = {
    querySelectorAll: (s) => (s === "[data-qty]" ? [input]
      : s === ".order-item" ? [row] : []),
  };

  return { form, row, input, add };
};

describe("#905 Large eggs counted like every other item", () => {
  const saved = {};

  beforeEach(() => {
    saved.document = globalThis.document;
    globalThis.document = {
      getElementById: () => null,
      querySelector: () => null,
    };
  });

  afterEach(() => {
    globalThis.document = saved.document;
  });

  it("No item in data/catalog.json is marked alwaysInStock", () => {
    const marked = [...indexCatalog(catalog).values()]
      .filter(uncounted)
      .map((item) => item.sku);

    assert.deepEqual(marked, []);
  });

  it("With Square's count for Eggs, Large at 0, the order page shows " +
    "them out of stock with their restock note, and they cannot be " +
    "added to the cart", async () => {
    const stores = testStores();

    await setCount(stores, EGGS, 0);

    const { form, row, input, add } = pageRow();
    const stock = new Stock(form, {
      onChange() {}, inStockOnly: () => false,
    });

    stock.items = await availability(stores);
    stock.apply();

    assert.ok(restockNote, "the restock type has a note");
    assert.equal(row.hasAttribute("data-out"), true, "marked out");
    assert.equal(row.dataset.stock, "out", "its restock note in Add's place");
    assert.equal(row.hidden, false, "shown under Full catalog");
    assert.equal(add.disabled, true, "Add is disabled");
    assert.equal(input.disabled, true, "the quantity is disabled");
    assert.equal(input.value, "0", "a cart's eggs are taken out");
  });

  it("With the count at 0, POST /api/orders refuses an order that " +
    "holds Eggs, Large, as it does for any other item that is out",
  async () => {
    const stores = testStores();

    await setCount(stores, EGGS, 0);

    const { res, data } = await orderEggs(stores, 1);

    assert.equal(res.status, 422);
    assert.equal(data.errors[`lines.${EGGS}`],
      `${eggs.lineName}: out of stock.`);
    assert.deepEqual(data.stock[EGGS], { inStock: false, available: 0 });
  });

  it("With a count above 0, Eggs, Large can be ordered up to that " +
    "count and no further", async () => {
    const over = testStores();

    await setCount(over, EGGS, 3);

    const refused = await orderEggs(over, 4);

    assert.equal(refused.res.status, 422);
    assert.equal(refused.data.errors[`lines.${EGGS}`],
      `${eggs.lineName}: only 3 left in stock.`);

    const within = testStores();

    await setCount(within, EGGS, 3);

    const placed = await orderEggs(within, 3);

    assert.equal(placed.res.status, 200, JSON.stringify(placed.data));
  });
});
