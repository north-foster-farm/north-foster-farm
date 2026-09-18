import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allOrders, amendOrder, deleteOrder, getCustomer, getOrder, openOrders,
  ordersFor, saveOrder, setStatus, touchCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-10-06T13:00:00Z");
const later = new Date("2026-10-06T14:00:00Z");

const order = (id, email = "pat@example.com", at = "2026-10-06T13:00:00Z") => ({
  id,
  status: "submitted",
  submittedAt: at,
  customer: { name: "Pat Example", email, phone: "" },
  lines: [{ sku: "X", qty: 1 }],
  totals: { total: 100 },
  fulfilment: { method: "onfarm", date: "2026-10-07" },
});

describe("order records", () => {
  it("save with a history line and the indexes", async () => {
    const stores = testStores();

    await saveOrder(stores, order("NFF-1"), now);

    const saved = await getOrder(stores, "NFF-1");

    assert.equal(saved.history[0].event, "submitted");
    assert.deepEqual(
      (await ordersFor(stores, "Pat@Example.com")).map((o) => o.id), ["NFF-1"]
    );
    assert.deepEqual((await openOrders(stores)).map((o) => o.id), ["NFF-1"]);
  });

  it("save twice as one record", async () => {
    const stores = testStores();

    await saveOrder(stores, order("NFF-1"), now);
    await saveOrder(stores, order("NFF-1"), now);
    assert.equal((await allOrders(stores)).length, 1);
    assert.equal((await ordersFor(stores, "pat@example.com")).length, 1);
  });

  it("list a customer's orders newest first", async () => {
    const stores = testStores();

    await saveOrder(stores, order("NFF-A", undefined, "2026-10-01T00:00:00Z"));
    await saveOrder(stores, order("NFF-B", undefined, "2026-10-03T00:00:00Z"));
    await saveOrder(stores, order("NFF-C", "other@example.com"));
    assert.deepEqual(
      (await ordersFor(stores, "pat@example.com")).map((o) => o.id),
      ["NFF-B", "NFF-A"]
    );
  });

  it("change status, stamp the time and leave the open index", async () => {
    const stores = testStores();

    await saveOrder(stores, order("NFF-1"), now);

    const paid = await setStatus(stores, "NFF-1", "paid", later);

    assert.equal(paid.status, "paid");
    assert.equal(paid.paidAt, later.toISOString());
    assert.equal(paid.history.at(-1).event, "paid");
    assert.equal((await openOrders(stores)).length, 1, "paid stays open");

    await setStatus(stores, "NFF-1", "fulfilled", later);
    assert.equal((await openOrders(stores)).length, 0);

    const again = await setStatus(stores, "NFF-1", "fulfilled", later);

    assert.equal(again.history.length, 3, "a repeat is not a new line");
    assert.equal(await setStatus(stores, "NFF-9", "paid", later), null);
  });

  it("cancelled and abandoned orders leave the open index too", async () => {
    const stores = testStores();

    await saveOrder(stores, order("NFF-1"), now);
    await saveOrder(stores, order("NFF-2"), now);
    await setStatus(stores, "NFF-1", "cancelled", later);
    await setStatus(stores, "NFF-2", "abandoned", later);
    assert.equal((await openOrders(stores)).length, 0);
    assert.equal((await ordersFor(stores, "pat@example.com")).length, 2);
  });

  it("amend with an event", async () => {
    const stores = testStores();

    await saveOrder(stores, order("NFF-1"), now);

    const amended = await amendOrder(
      stores, "NFF-1", { notes: "gate code 1234" }, "notes.changed", later
    );

    assert.equal(amended.notes, "gate code 1234");
    assert.equal(amended.history.at(-1).event, "notes.changed");
  });

  it("delete cleanly", async () => {
    const stores = testStores();

    await saveOrder(stores, order("NFF-1"), now);
    assert.equal(await deleteOrder(stores, "NFF-1"), true);
    assert.equal(await getOrder(stores, "NFF-1"), null);
    assert.equal((await ordersFor(stores, "pat@example.com")).length, 0);
    assert.equal((await openOrders(stores)).length, 0);
    assert.equal(await deleteOrder(stores, "NFF-1"), false);
  });
});

describe("customer records", () => {
  it("are created from a first order and only filled in after", async () => {
    const stores = testStores();
    const first = await touchCustomer(stores, {
      name: "Pat Example", email: "Pat@Example.com", phone: "",
    }, now);

    assert.equal(first.email, "pat@example.com");
    assert.equal(first.discountGroup, null);
    assert.equal(first.createdAt, now.toISOString());

    const second = await touchCustomer(stores, {
      name: "Patricia Example", email: "pat@example.com", phone: "4015550100",
    }, later);

    assert.equal(second.name, "Pat Example", "a chosen name is kept");
    assert.equal(second.phone, "4015550100", "a blank phone is filled");
    assert.equal(second.lastOrderAt, later.toISOString());
    assert.equal((await getCustomer(stores, "PAT@example.com")).createdAt,
      now.toISOString());
  });
});
