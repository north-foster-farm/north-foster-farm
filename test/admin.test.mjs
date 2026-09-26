import assert from "node:assert/strict";
import { describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import {
  cancelOrder, confirmPickup, decideAddress, denyPickup, fulfilOrder,
  listOrders, pickupRange, pickupsNeedingConfirmation, refundOrder,
  removeCustomer, removeOrder, resolveReturn, setCustomer, showCustomer,
  stockList, stockSet,
} from "../netlify/functions/lib/admin.mjs";
import { verifyToken } from "../netlify/functions/lib/auth.mjs";
import { requestReturn } from "../netlify/functions/lib/account.mjs";
import { announcePaid } from "../netlify/functions/lib/payments.mjs";
import {
  getCustomer, getOrder, openOrders, saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { getCounts, setCount } from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-10-05T13:00:00Z");

// Every order is born paid: a card through Square unless told.
const order = (id, status = "paid", via = "square") => ({
  id,
  status,
  submittedAt: now.toISOString(),
  paidAt: now.toISOString(),
  customer: { name: "Pat Example", email: "pat@example.com", phone: "" },
  lines: [{ sku: "NFF-CHK-EGG-LG", label: "Eggs (per dozen), Large", qty: 2,
    unitPrice: 7, lineTotal: 14 }],
  totals: { subtotal: 1400, discountAmount: 0, deliveryFee: 0, total: 1400 },
  fulfilment: { method: "onfarm", date: "2026-10-07",
    onfarm: { window: "morning", phone: "4015550100" } },
  square: { squareOrderId: "SQO", customerId: "CUST" },
  payment: via === "venmo"
    ? {
      via: "venmo", method: "venmo", at: now.toISOString(),
      squarePaymentId: `PAY-${id}`, receiptUrl: null,
      paypalOrderId: `PPO-${id}`, paypalCaptureId: `CAP-${id}`,
    }
    : {
      via: "square", method: "card", at: now.toISOString(),
      squarePaymentId: `PAY-${id}`, receiptUrl: "https://r/x",
      brand: "VISA", last4: "4242",
    },
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
        refundPayment: async ({ squarePaymentId, amount, key, reason }) => {
          calls.push(["square.refund", squarePaymentId, amount]);
          assert.match(key, /^refund-/);
          assert.equal(typeof reason, "string");

          return { squareRefundId: "SQR-1", status: "PENDING", amount };
        },
        cancelFulfilment: async (id) => { calls.push(["fulfilment", id]); },
      },
      paypal: {
        refundCapture: async ({ paypalCaptureId, amount, key, note }) => {
          calls.push(["paypal.refund", paypalCaptureId, amount]);
          assert.match(key, /^refund-/);
          assert.ok(note);

          return { paypalRefundId: "PPR-1", status: "COMPLETED", amount };
        },
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
    await saveOrder(stores, order("C", "cancelled"), now);
    assert.equal((await listOrders(stores)).length, 3);
    assert.deepEqual((await listOrders(stores, { open: true }))
      .map((o) => o.id), ["A"]);
    assert.equal((await listOrders(stores, { status: "fulfilled" }))[0].id,
      "B");
    assert.equal((await listOrders(stores, {
      email: "pat@example.com",
    })).length, 3);
    assert.equal((await listOrders(stores, { email: "x@y.com" })).length, 0);
  });

  it("fulfil, delete", async () => {
    const stores = testStores();
    const { opts } = harness();

    await saveOrder(stores, order("A"), now);
    assert.equal((await fulfilOrder(stores, "A", opts)).status, "fulfilled");
    assert.equal((await openOrders(stores)).length, 0);
    assert.equal(await removeOrder(stores, "A"), true);
    await assert.rejects(removeOrder(stores, "A"), /No such order/);
    await assert.rejects(fulfilOrder(stores, "A", opts), /No such order/);
  });

  it("refund a card order through Square, whole or part, once", async () => {
    const stores = testStores();
    const { calls, opts } = harness();

    await saveOrder(stores, order("A"), now);
    await assert.rejects(refundOrder(stores, "A", { ...opts, amount: 1500 }),
      /between \$0\.01 and \$14/);
    await assert.rejects(refundOrder(stores, "A", { ...opts, amount: 0 }),
      /between/);
    await assert.rejects(refundOrder(stores, "A", { ...opts, amount: 7.5 }),
      /between/);
    assert.deepEqual(calls, [], "nothing moved");

    const part = await refundOrder(stores, "A", {
      ...opts, amount: 700, reason: "One dozen short",
    });

    assert.deepEqual(calls, [["square.refund", "PAY-A", 700]]);
    assert.equal(part.refunds.at(-1).amount, 700);
    assert.equal(part.refunds.at(-1).total, false);
    assert.equal(part.refunds.at(-1).source, "farm");
    assert.equal(part.refunds.at(-1).squareRefundId, "SQR-1");
    assert.equal(part.refunds.at(-1).paypalRefundId, null);
    assert.equal(part.refunds.at(-1).status, "PENDING");
    assert.equal(part.refunds.at(-1).at, now.toISOString());
    assert.equal(part.refunds.at(-1).payment, "PAY-A");
    assert.equal(part.history.at(-1).event, "refund.recorded");
    assert.equal(part.status, "paid", "a refund alone does not cancel");

    // The rest can follow; then there is nothing left to send back.
    const rest = await refundOrder(stores, "A", opts);

    assert.deepEqual(calls.at(-1), ["square.refund", "PAY-A", 700]);
    assert.equal(rest.refunds.length, 2);
    assert.equal(rest.refunds.at(-1).total, true);
    await assert.rejects(refundOrder(stores, "A", opts),
      /Already refunded in full \(\$14\)/);
    assert.equal(calls.length, 2);

    // The whole total by default, marked as such.
    await saveOrder(stores, order("B"), now);
    const whole = await refundOrder(stores, "B", opts);

    assert.deepEqual(calls.at(-1), ["square.refund", "PAY-B", 1400]);
    assert.equal(whole.refunds.at(-1).total, true);
  });

  it("refund a Venmo order through PayPal and note it on the Square copy",
    async () => {
      const stores = testStores();
      const { calls, opts } = harness();

      await saveOrder(stores, order("A", "paid", "venmo"), now);
      const r = await refundOrder(stores, "A", opts);

      assert.deepEqual(calls, [
        ["paypal.refund", "CAP-A", 1400], ["square.refund", "PAY-A", 1400],
      ]);
      assert.equal(r.refunds.at(-1).paypalRefundId, "PPR-1");
      assert.equal(r.refunds.at(-1).squareRefundId, "SQR-1");
      assert.equal(r.refunds.at(-1).status, "COMPLETED");

      // Square refusing to note it does not undo the refund.
      await saveOrder(stores, order("B", "paid", "venmo"), now);
      const noted = await refundOrder(stores, "B", {
        ...opts,
        square: {
          ...opts.square,
          refundPayment: async () => { throw new Error("Square 500"); },
        },
      });

      assert.equal(noted.refunds.at(-1).paypalRefundId, "PPR-1");
      assert.equal(noted.refunds.at(-1).squareRefundId, null);
      assert.equal(noted.refunds.at(-1).total, true);

      // A Venmo order that never got its Square copy still refunds.
      const bare = order("C", "paid", "venmo");

      bare.square = null;
      bare.payment.squarePaymentId = null;
      await saveOrder(stores, bare, now);
      const c = await refundOrder(stores, "C", opts);

      assert.equal(c.refunds.at(-1).paypalRefundId, "PPR-1");
      assert.deepEqual(calls.at(-1), ["paypal.refund", "CAP-C", 1400]);
    });

  it("refuses to refund what has no payment or the wrong status",
    async () => {
      const stores = testStores();
      const { calls, opts } = harness();
      const none = order("A");

      none.payment = null;
      await saveOrder(stores, none, now);
      await assert.rejects(refundOrder(stores, "A", opts),
        /no payment to refund/);
      await assert.rejects(refundOrder(stores, "Z", opts), /No such order/);

      const legacy = { ...order("B"), status: "submitted", payment: null };

      await saveOrder(stores, legacy, now);
      await assert.rejects(refundOrder(stores, "B", opts),
        /This order is submitted/);
      assert.deepEqual(calls, []);
    });

  it("cancel without a refund: stock back, Square closed, customer told " +
    "nothing more is charged", async () => {
    const stores = testStores();
    const { sent, calls, opts } = harness();

    await setCount(stores, "NFF-CHK-EGG-LG", 3);
    await saveOrder(stores, order("A"), now);
    const c = await cancelOrder(stores, "A", opts);

    assert.equal(c.status, "cancelled");
    assert.equal(c.refund, undefined);
    assert.equal((await getCounts(stores))["NFF-CHK-EGG-LG"], 5);
    assert.deepEqual(calls, [["fulfilment", "SQO"]]);
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /cancelled/);
    assert.match(sent[0].text, /Nothing more will be charged/);
    assert.doesNotMatch(sent[0].text, /refund/i);
    assert.equal((await openOrders(stores)).length, 0);

    // Cancelling again changes nothing and sends nothing.
    await cancelOrder(stores, "A", opts);
    assert.equal(sent.length, 1);
    assert.equal(calls.length, 1);
  });

  it("cancel with --refund: the money goes back first, then the wording " +
    "says so", async () => {
    const stores = testStores();
    const { sent, calls, opts } = harness();

    await setCount(stores, "NFF-CHK-EGG-LG", 3);
    await saveOrder(stores, order("A"), now);
    const c = await cancelOrder(stores, "A", { ...opts, refund: true });

    assert.equal(c.status, "cancelled");
    assert.equal(c.refunds.at(-1).amount, 1400);
    assert.equal(c.refunds.at(-1).total, true);
    assert.deepEqual(calls, [
      ["square.refund", "PAY-A", 1400], ["fulfilment", "SQO"],
    ]);
    assert.equal((await getCounts(stores))["NFF-CHK-EGG-LG"], 5);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /refund is on its way/);
    assert.match(sent[0].text, /on-farm pickup on Wednesday, October 7/);

    // A partial refund with a reason rides along.
    await saveOrder(stores, order("B", "paid", "venmo"), now);
    const b = await cancelOrder(stores, "B", {
      ...opts, refund: true, amount: 700, reason: "Half the order",
    });

    assert.equal(b.refunds.at(-1).amount, 700);
    assert.equal(b.refunds.at(-1).total, false);
    assert.deepEqual(calls.slice(2), [
      ["paypal.refund", "CAP-B", 700], ["square.refund", "PAY-B", 700],
      ["fulfilment", "SQO"],
    ]);
    assert.match(sent[1].text, /refund is on its way/);

    // A processor failure stops the cancel before anything changes.
    await saveOrder(stores, order("C"), now);
    await assert.rejects(cancelOrder(stores, "C", {
      ...opts, refund: true,
      square: {
        ...opts.square,
        refundPayment: async () => { throw new Error("Square 503"); },
      },
    }), /Square 503/);
    assert.equal((await getOrder(stores, "C")).status, "paid");
    assert.equal(sent.length, 2);
  });

  it("close an order the customer asked to cancel, without a second " +
    "email or a second stock release", async () => {
    const stores = testStores();
    const { sent, calls, opts } = harness();

    await setCount(stores, "NFF-CHK-EGG-LG", 3);
    // The customer's request already released stock and emailed them.
    await saveOrder(stores, { ...order("A"), cancelRequested: true }, now);
    const c = await cancelOrder(stores, "A", { ...opts, refund: true });

    assert.equal(c.status, "cancelled");
    assert.equal(c.refunds.at(-1).total, true);
    assert.equal((await getCounts(stores))["NFF-CHK-EGG-LG"], 3);
    assert.deepEqual(calls, [
      ["square.refund", "PAY-A", 1400], ["fulfilment", "SQO"],
    ]);
    assert.equal(sent.length, 0);
  });
});

describe("an on-farm pickup window from the CLI", () => {
  const requested = (id) => {
    const o = order(id);

    o.fulfilment.state = "requested";

    return o;
  };

  it("confirm: agreed, and confirmed by whichever of paid and agreed " +
    "comes second", async () => {
    const stores = testStores();
    const { sent, opts } = harness();

    // Every order is paid when recorded, so agreeing confirms it.
    await saveOrder(stores, requested("A"), now);
    const agreed = await confirmPickup(stores, "A", opts);

    assert.equal(agreed.fulfilment.state, "agreed");
    assert.equal(agreed.fulfilment.agreedAt, now.toISOString());
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, "Your order is confirmed");
    assert.match(sent[0].text, /your pickup time is set/);

    // The order's own announcement first: "Payment received", then
    // confirmed on agreement.
    await saveOrder(stores, requested("B"), now);
    await announcePaid(stores, "B", opts);
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

  it("confirm records the hours the farm will be there, inside the " +
    "window", async () => {
    const stores = testStores();
    const { sent, opts } = harness();

    assert.deepEqual(pickupRange("morning"), { from: 9, to: 11 });
    assert.deepEqual(pickupRange("morning", { at: "9" }), { from: 9, to: 11 });
    assert.deepEqual(pickupRange("afternoon", { at: 13, until: 17 }),
      { from: 13, to: 17 });
    assert.throws(() => pickupRange("morning", { at: 11 }), /9:00 to 12:00/);
    assert.throws(() => pickupRange("morning", { at: 9, until: 10 }),
      /at least 2 hours/);
    assert.throws(() => pickupRange("morning", { at: "9.5" }), /whole/);
    assert.throws(() => pickupRange("evening"), /Unknown pickup window/);

    await saveOrder(stores, requested("A"), now);
    const agreed = await confirmPickup(stores, "A", { ...opts, at: 10 });

    assert.deepEqual(agreed.fulfilment.onfarm.confirmed, { from: 10, to: 12 });
    assert.match(sent.at(-1).text,
      /- When: Wednesday, October 7, 10 AM – 12 PM \(morning\)/);
  });

  it("lists the pickups waiting on the farm, oldest first", async () => {
    const stores = testStores();
    const { opts } = harness();
    const older = { ...requested("B"), submittedAt: "2026-10-04T13:00:00Z" };
    const asked = requested("C");

    asked.question = { kind: "window", openedAt: "x", answeredAt: null };
    await saveOrder(stores, requested("A"), now);
    await saveOrder(stores, older, now);
    await saveOrder(stores, asked, now);
    await saveOrder(stores, order("D"), now); // Legacy: born agreed.

    assert.deepEqual((await pickupsNeedingConfirmation(stores))
      .map((o) => o.id), ["B", "A"]);
    await confirmPickup(stores, "B", opts);
    assert.deepEqual((await pickupsNeedingConfirmation(stores))
      .map((o) => o.id), ["A"]);
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
    assert.equal(sent[0].subject,
      "Requested pickup time unavailable, please pick again");
    assert.doesNotMatch(sent[0].text, /at the market/,
      "the reason stays in the record");
    assert.ok(sent[0].text.includes("you can cancel your order for a " +
      "full refund"), "the refund is offered");

    const link = sent[0].text.match(/Reschedule or cancel: (\S+)/)[1];
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

  it("deny without accounts has no button, and each deny is its own " +
    "email", async () => {
    const stores = testStores();
    const { sent, opts } = harness();

    await saveOrder(stores, requested("A"), now);
    await denyPickup(stores, "A", opts);
    assert.doesNotMatch(sent[0].text, /Reschedule or cancel:/);
    assert.match(sent[0].text, /Please pick another day or window/);

    const later = new Date(now.getTime() + 60_000);

    await denyPickup(stores, "A", { ...opts, now: later, reason: "Rain." });
    assert.equal(sent.length, 2);
  });
});

describe("returns and stock from the CLI", () => {
  it("resolve a return with a note; James tells the customer", async () => {
    const stores = testStores();
    const { sent, opts } = harness();

    await saveOrder(stores, order("A"), now);
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

describe("refunds over several payments", () => {
  // An order changed after paying: $14 by card, then $6 more by Venmo.
  const changed = (id) => {
    const base = order(id);

    return {
      ...base,
      payment: undefined,
      totals: { ...base.totals, subtotal: 2000, total: 2000 },
      payments: [
        { ...base.payment, amount: 1400 },
        {
          via: "venmo", method: "venmo", at: now.toISOString(), amount: 600,
          squarePaymentId: `PAY-${id}-2`, receiptUrl: null,
          paypalOrderId: `PPO-${id}-2`, paypalCaptureId: `CAP-${id}-2`,
        },
      ],
      refunds: [],
    };
  };

  it("takes a refund out of the newest payment first", async () => {
    const stores = testStores();
    const { calls, opts } = harness();

    await saveOrder(stores, changed("A"), now);

    const part = await refundOrder(stores, "A", { ...opts, amount: 1000 });

    assert.deepEqual(calls, [
      ["paypal.refund", "CAP-A-2", 600], ["square.refund", "PAY-A-2", 600],
      ["square.refund", "PAY-A", 400],
    ]);
    assert.deepEqual(part.refunds.map((r) => [r.payment, r.amount]),
      [["CAP-A-2", 600], ["PAY-A", 400]]);
    assert.equal(part.refunds.at(-1).total, false);

    const rest = await refundOrder(stores, "A", opts);

    assert.deepEqual(calls.at(-1), ["square.refund", "PAY-A", 1000]);
    assert.equal(rest.refunds.at(-1).total, true);
    await assert.rejects(refundOrder(stores, "A", opts),
      /Already refunded in full \(\$20\)/);
  });

  it("cancel with --refund after a partial refund sends back the rest, " +
    "and says so", async () => {
    const stores = testStores();
    const { sent, calls, opts } = harness();

    await saveOrder(stores, order("A"), now);
    await refundOrder(stores, "A", { ...opts, amount: 400 });

    const c = await cancelOrder(stores, "A", { ...opts, refund: true });

    assert.deepEqual(calls, [
      ["square.refund", "PAY-A", 400], ["square.refund", "PAY-A", 1000],
      ["fulfilment", "SQO"],
    ]);
    assert.deepEqual(c.refunds.map((r) => r.amount), [400, 1000]);
    assert.match(sent.at(-1).text, /refund is on its way/);

    // Refunded in full already: nothing more goes back, and the email
    // does not promise it.
    await saveOrder(stores, order("B"), now);
    await refundOrder(stores, "B", opts);
    await cancelOrder(stores, "B", { ...opts, refund: true });

    assert.deepEqual(calls.at(-1), ["fulfilment", "SQO"]);
    assert.doesNotMatch(sent.at(-1).text, /refund is on its way/);
  });
});
