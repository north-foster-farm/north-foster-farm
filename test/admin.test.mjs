import assert from "node:assert/strict";
import { describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import {
  cancelOrder, confirmPickup, decideAddress, denyPickup, fulfilOrder,
  listOrders, payOrder, removeCustomer, removeOrder, resolveReturn,
  setCustomer, showCustomer, stockList, stockSet, unholdOrder,
} from "../netlify/functions/lib/admin.mjs";
import { verifyToken } from "../netlify/functions/lib/auth.mjs";
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
    const { calls, opts } = harness();

    await saveOrder(stores, order("A"), now);
    const paid = await payOrder(stores, "A", { ...opts, via: "venmo" });

    assert.equal(paid.status, "paid");
    assert.equal(paid.payment.via, "venmo");
    assert.deepEqual(calls, [["invoice", "INV-A"]], "the invoice is closed");
    assert.equal((await payOrder(stores, "A", opts)).payment.via, "venmo",
      "paying again changes nothing");
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
      assert.match(sent[0].text, /you were not charged/);
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

  it("lift the Venmo hold when nothing arrived", async () => {
    const stores = testStores();
    const { opts } = harness();

    await saveOrder(stores, {
      ...order("A"), paymentPending: { at: now.toISOString(), source: "venmo" },
    }, now);
    const back = await unholdOrder(stores, "A", opts);

    assert.equal(back.paymentPending, null);
    assert.equal(back.history.at(-1).event, "payment.unclaimed");
    await payOrder(stores, "A", opts);
    await assert.rejects(unholdOrder(stores, "A", opts), /is paid/);
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

describe("an on-farm pickup window from the CLI", () => {
  const requested = (id, status = "submitted") => {
    const o = order(id, status);

    o.fulfilment.state = "requested";

    return o;
  };

  it("confirm: agreed, and confirmed by whichever of paid and agreed " +
    "comes second", async () => {
    const stores = testStores();
    const { sent, opts } = harness();

    // Agreed first: nothing to say until the money arrives.
    await saveOrder(stores, requested("A"), now);
    const agreed = await confirmPickup(stores, "A", opts);

    assert.equal(agreed.fulfilment.state, "agreed");
    assert.equal(agreed.fulfilment.agreedAt, now.toISOString());
    assert.equal(sent.length, 0);
    await payOrder(stores, "A", opts);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, "Your order is confirmed");
    assert.match(sent[0].text, /your pickup time is set/);

    // Paid first: "Payment received", then confirmed on agreement.
    await saveOrder(stores, requested("B"), now);
    await payOrder(stores, "B", opts);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].subject, "Payment received");
    const b = await confirmPickup(stores, "B", opts);

    assert.equal(sent.length, 3);
    assert.equal(sent[2].subject, "Your order is confirmed");
    assert.equal(b.emails.orderConfirmed.id, "m3");

    // Again is a no-op; a delivery has nothing to confirm.
    await confirmPickup(stores, "B", opts);
    assert.equal(sent.length, 3);
    await saveOrder(stores, {
      ...order("C"), fulfilment: { method: "delivery", date: "2026-10-08" },
    }, now);
    await assert.rejects(confirmPickup(stores, "C", opts), /Only an on-farm/);
  });

  it("deny: opens a question, pauses nothing else, and mails a week-long " +
    "link to the order page", async () => {
    const stores = testStores();
    const { sent, opts } = harness();
    const env = { ACCOUNTS_ENABLED: "true", URL: "https://x" };

    await saveOrder(stores, requested("A"), now);
    const denied = await denyPickup(stores, "A", {
      ...opts, env, reason: "  We're at the market that morning.  ",
    });

    assert.equal(denied.fulfilment.state, "requested");
    assert.equal(denied.question.kind, "window");
    assert.equal(denied.question.reason, "We're at the market that morning.");
    assert.equal(denied.question.answeredAt, null);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, "One more step: pick a new pickup time");
    assert.match(sent[0].text, /_\*\*We're at the market that morning\.\*\*_/);

    const link = sent[0].text.match(/Pick a new time: (\S+)/)[1];
    const token = new URL(link).searchParams.get("token");
    const week = new Date(now.getTime() + 6 * 24 * 60 * 60_000);
    const v = await verifyToken(stores, token, { now: week });

    assert.equal(v.ok, true, "still good six days on");
    assert.equal(v.email, "pat@example.com");
    assert.equal(v.next, "/account/orders/A/");

    // Confirming after all closes the question, as the farm's answer.
    const agreed = await confirmPickup(stores, "A", { ...opts, env });

    assert.equal(agreed.fulfilment.state, "agreed");
    assert.equal(agreed.question.answer, "confirmed");
    assert.equal(agreed.question.by, "farm");
  });

  it("deny without accounts asks for a reply, and each deny is its own " +
    "email", async () => {
    const stores = testStores();
    const { sent, opts } = harness();

    await saveOrder(stores, requested("A"), now);
    await denyPickup(stores, "A", opts);
    assert.doesNotMatch(sent[0].text, /Pick a new time:/);
    assert.match(sent[0].text, /Please reply with another day or window/);

    const later = new Date(now.getTime() + 60_000);

    await denyPickup(stores, "A", { ...opts, now: later, reason: "Rain." });
    assert.equal(sent.length, 2);
    assert.match(sent[1].text, /_\*\*Rain\.\*\*_/);
  });
});

describe("returns and stock from the CLI", () => {
  it("resolve a return with a note; James tells the customer", async () => {
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
    assert.equal(sent.length, 0, "no template speaks for the farm here");
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
