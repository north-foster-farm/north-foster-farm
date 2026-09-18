import assert from "node:assert/strict";
import { describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import {
  cancelOrder, decideAddress, fulfilOrder, listOrders, payOrder,
  removeCustomer, removeOrder, resolveReturn, setCustomer, showCustomer,
  stockList, stockSet,
} from "../netlify/functions/lib/admin.mjs";
import { requestReturn } from "../netlify/functions/lib/account.mjs";
import { markPaid } from "../netlify/functions/lib/payments.mjs";
import {
  getCustomer, getOrder, openOrders, saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { getCounts, setCount } from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-10-05T13:00:00Z");

const order = (id, status = "submitted") => ({
  id,
  status,
  submittedAt: now.toISOString(),
  customer: { name: "Pat Example", email: "pat@example.com", phone: "" },
  lines: [{ sku: "NFF-CHK-EGG-LG", label: "Eggs (per dozen), Large", qty: 2,
    unitPrice: 7, lineTotal: 14 }],
  totals: { subtotal: 1400, discountAmount: 0, deliveryFee: 0, total: 1400 },
  fulfilment: { method: "onfarm", date: "2026-10-07",
    onfarm: { window: "morning", phone: "4015550100" } },
  square: { squareOrderId: "SQO", invoiceId: `INV-${id}` },
});

const customer = {
  email: "pat@example.com", name: "Pat", phone: "", avatar: null,
  discountGroup: null,
  address: { address1: "5 Far Rd", town: "Nowhere", zip: "01234",
    status: "pending" },
};

const harness = () => {
  const sent = [];
  const calls = [];

  return {
    sent,
    calls,
    opts: {
      now,
      env: {},
      mail: async (m) => {
        sent.push(m);

        return { id: `m${sent.length}`, driver: "test" };
      },
      square: {
        cancelInvoice: async (id) => { calls.push(["invoice", id]); },
        cancelFulfilment: async (id) => { calls.push(["fulfilment", id]); },
      },
    },
  };
};

describe("customers from the CLI", () => {
  it("set a group only from the known list", async () => {
    const stores = testStores();

    await saveCustomer(stores, customer);
    const set = await setCustomer(stores, "pat@example.com", {
      group: "friends", name: "Patricia",
    }, terms.money);

    assert.equal(set.discountGroup, "friends");
    assert.equal(set.name, "Patricia");
    await assert.rejects(setCustomer(stores, "pat@example.com", {
      group: "royalty",
    }, terms.money), /Unknown group/);
    assert.equal((await setCustomer(stores, "pat@example.com", {
      group: "none",
    }, terms.money)).discountGroup, null);
    await assert.rejects(setCustomer(stores, "nobody@x.com", {}, terms.money),
      /No such customer/);
  });

  it("approve or deny an address and tell the customer", async () => {
    const stores = testStores();
    const { sent, opts } = harness();

    await saveCustomer(stores, customer);
    const ok = await decideAddress(stores, "pat@example.com", "approved",
      opts);

    assert.equal(ok.address.status, "approved");
    assert.equal(ok.address.reviewedBy, "farm");
    assert.match(sent[0].subject, /can deliver/);

    const no = await decideAddress(stores, "pat@example.com", "denied", opts);

    assert.equal(no.address.status, "denied");
    assert.match(sent[1].subject, /can't deliver/);
    await assert.rejects(decideAddress(stores, "pat@example.com", "maybe",
      opts), /approved or denied/);
  });

  it("show and delete", async () => {
    const stores = testStores();

    await saveCustomer(stores, customer);
    await saveOrder(stores, order("A"), now);
    const shown = await showCustomer(stores, "pat@example.com");

    assert.equal(shown.orders.length, 1);
    assert.equal(await removeCustomer(stores, "pat@example.com"), true);
    assert.equal(await getCustomer(stores, "pat@example.com"), null);
  });
});

describe("orders from the CLI", () => {
  it("list with filters", async () => {
    const stores = testStores();

    await saveOrder(stores, order("A"), now);
    await saveOrder(stores, order("B", "fulfilled"), now);
    assert.equal((await listOrders(stores)).length, 2);
    assert.equal((await listOrders(stores, { open: true })).length, 1);
    assert.equal((await listOrders(stores, { status: "fulfilled" }))[0].id,
      "B");
    assert.equal((await listOrders(stores, { email: "x@y.com" })).length, 0);
  });

  it("pay by hand, fulfil, delete", async () => {
    const stores = testStores();
    const { opts } = harness();

    await saveOrder(stores, order("A"), now);
    assert.equal((await payOrder(stores, "A", opts)).status, "paid");
    assert.equal((await fulfilOrder(stores, "A", opts)).status, "fulfilled");
    assert.equal((await openOrders(stores)).length, 0);
    assert.equal(await removeOrder(stores, "A"), true);
    await assert.rejects(removeOrder(stores, "A"), /No such order/);
  });

  it("cancel an unpaid order: stock back, Square closed, customer told",
    async () => {
      const stores = testStores();
      const { sent, calls, opts } = harness();

      await setCount(stores, "NFF-CHK-EGG-LG", 3);
      await saveOrder(stores, order("A"), now);
      const c = await cancelOrder(stores, "A", opts);

      assert.equal(c.status, "cancelled");
      assert.equal((await getCounts(stores))["NFF-CHK-EGG-LG"], 5);
      assert.deepEqual(calls, [["invoice", "INV-A"], ["fulfilment", "SQO"]]);
      assert.match(sent[0].subject, /cancelled/);
      assert.match(sent[0].text, /nothing was charged/);
    });

  it("close a paid order the customer asked to cancel, without a second " +
    "email or a second stock release", async () => {
    const stores = testStores();
    const { sent, calls, opts } = harness();

    await setCount(stores, "NFF-CHK-EGG-LG", 3);
    await saveOrder(stores, order("A"), now);
    await markPaid(stores, "A", opts);
    // The customer's request already released stock and emailed them.
    await saveOrder(stores, {
      ...(await getOrder(stores, "A")), cancelRequested: true,
    }, now);
    sent.length = 0;
    const c = await cancelOrder(stores, "A", opts);

    assert.equal(c.status, "cancelled");
    assert.equal((await getCounts(stores))["NFF-CHK-EGG-LG"], 3);
    assert.deepEqual(calls, [], "a paid invoice is not cancelled");
    assert.equal(sent.length, 0);
  });

  it("cancel a paid order the farm chose to: refund wording", async () => {
    const stores = testStores();
    const { sent, opts } = harness();

    await saveOrder(stores, order("A"), now);
    await markPaid(stores, "A", opts);
    sent.length = 0;
    await cancelOrder(stores, "A", opts);
    assert.match(sent[0].text, /refund is on its way/);
  });
});

describe("returns and stock from the CLI", () => {
  it("resolve a return with a note and tell the customer", async () => {
    const stores = testStores();
    const { sent, opts } = harness();

    await saveOrder(stores, order("A"), now);
    await markPaid(stores, "A", opts);
    const r = await requestReturn(stores, { email: "pat@example.com",
      name: "Pat" }, "A", { reason: "Thawed" }, opts);

    sent.length = 0;
    const done = await resolveReturn(stores, "A", r.request.id, {
      ...opts, note: "We've credited $7 to your card.",
    });

    assert.equal(done.returns[0].status, "resolved");
    assert.equal(done.returns[0].note, "We've credited $7 to your card.");
    assert.match(sent[0].text, /credited \$7/);
    await assert.rejects(resolveReturn(stores, "A", "nope", opts),
      /No such return/);
  });

  it("set and list counts", async () => {
    const stores = testStores();

    await stockSet(stores, "NFF-CHK-EGG-LG", "12");
    assert.deepEqual(await stockList(stores), { "NFF-CHK-EGG-LG": 12 });
    await stockSet(stores, "NFF-CHK-EGG-LG", "none");
    assert.deepEqual(await stockList(stores), {});
  });
});
