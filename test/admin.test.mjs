import assert from "node:assert/strict";
import { describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import {
  cancelOrder, decideAddress, fulfilOrder, listOrders,
  markAttempted, moveDelivery,
  refundOrder, removeCustomer, removeOrder, resolveReturn, setCustomer,
  showCustomer, stockList, stockSet,
} from "../netlify/functions/lib/admin.mjs";
import { requestReturn } from "../netlify/functions/lib/account.mjs";
import {
  getCustomer, getOrder, keptFee, openOrders, saveCustomer, saveOrder,
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
        updateFulfilment: async (id, o) => {
          calls.push(["updateFulfilment", id, o.fulfilment.date]);
        },
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

  // The fixture is a pickup: it cancels like a delivery (T2d).
  it("cancel gives the customer the farm's reason (T2a)", async () => {
    const stores = testStores();
    const { sent, opts } = harness();

    await saveOrder(stores, order("A"), now);
    await cancelOrder(stores, "A", { ...opts, reason: "sold-out" });
    await saveOrder(stores, order("B"), now);
    await cancelOrder(stores, "B", {
      ...opts, reasonText: "The truck broke down.",
    });

    assert.match(sent[0].text, /October 7\.\nSomething in your order sold /);
    assert.match(sent[0].text, /\*\*A refund of \$14 is on its way\.\*\*/);
    assert.match(sent[1].text, /October 7\.\nThe truck broke down\.\n/);
  });

  it("cancel --no-refund: stock back, Square closed, customer told " +
    "of no refund", async () => {
    const stores = testStores();
    const { sent, calls, opts } = harness();

    await setCount(stores, "NFF-CHK-EGG-LG", 3);
    await saveOrder(stores, order("A"), now);
    const c = await cancelOrder(stores, "A", { ...opts, refund: false });

    assert.equal(c.status, "cancelled");
    assert.equal(c.refund, undefined);
    assert.equal((await getCounts(stores))["NFF-CHK-EGG-LG"], 5);
    assert.deepEqual(calls, [["fulfilment", "SQO"]]);
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /cancelled/);
    assert.doesNotMatch(sent[0].text, /refund|charged/i);
    assert.equal((await openOrders(stores)).length, 0);

    // Cancelling again changes nothing and sends nothing.
    await cancelOrder(stores, "A", opts);
    assert.equal(sent.length, 1);
    assert.equal(calls.length, 1);
  });

  it("cancel refunds by default: the money goes back first, then the " +
    "wording says so", async () => {
    const stores = testStores();
    const { sent, calls, opts } = harness();

    await setCount(stores, "NFF-CHK-EGG-LG", 3);
    await saveOrder(stores, order("A"), now);
    const c = await cancelOrder(stores, "A", opts);

    assert.equal(c.status, "cancelled");
    assert.equal(c.refunds.at(-1).amount, 1400);
    assert.equal(c.refunds.at(-1).total, true);
    assert.deepEqual(calls, [
      ["square.refund", "PAY-A", 1400], ["fulfilment", "SQO"],
    ]);
    assert.equal((await getCounts(stores))["NFF-CHK-EGG-LG"], 5);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /A refund of \$14 is on its way/);
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
    assert.match(sent[1].text, /A refund of \$7 is on its way/);

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
    assert.match(sent.at(-1).text, /A refund of \$10 is on its way/);

    // Refunded in full already: nothing more goes back, and the email
    // does not promise it.
    await saveOrder(stores, order("B"), now);
    await refundOrder(stores, "B", opts);
    await cancelOrder(stores, "B", { ...opts, refund: true });

    assert.deepEqual(calls.at(-1), ["fulfilment", "SQO"]);
    assert.doesNotMatch(sent.at(-1).text, /on its way/);
    assert.match(sent.at(-1).text, /We refunded \$14 on /);
  });
});

describe("an attempted delivery keeps its fee", () => {
  // $14 of eggs and a $5 delivery fee, paid by card.
  const delivered = (id) => {
    const base = order(id);

    return {
      ...base,
      totals: { ...base.totals, deliveryFee: 500, total: 1900 },
      fulfilment: { method: "delivery", date: "2026-10-08",
        delivery: { address1: "5 Far Rd", zip: "01234" } },
    };
  };

  it("marks a delivery once, and nothing else", async () => {
    const stores = testStores();

    const cause = "no-cooler";

    await saveOrder(stores, delivered("A"), now);
    const a = await markAttempted(stores, "A", { cause, now });

    assert.deepEqual(a.attempted, {
      at: now.toISOString(), date: "2026-10-08", cause, fee: 500,
      waived: false, note: "", detail: "",
    });

    const later = new Date(now.getTime() + 7 * 86_400_000);
    const again = await markAttempted(stores, "A",
      { cause: "farm", now: later });

    assert.deepEqual(again.attempted, a.attempted);

    await saveOrder(stores, order("B"), now);
    await assert.rejects(markAttempted(stores, "B", { cause, now }),
      /Only a delivery/);
    await saveOrder(stores, delivered("C"), now);
    await fulfilOrder(stores, "C", { now });
    await assert.rejects(markAttempted(stores, "C", { cause, now }),
      /This order is fulfilled/);
    await assert.rejects(markAttempted(stores, "Z", { cause, now }),
      /No such order/);
    await saveOrder(stores, delivered("D"), now);
    await assert.rejects(markAttempted(stores, "D", { now }),
      /One of: no-cooler, no-access, no-address, weather, farm/);
    await assert.rejects(markAttempted(stores, "D",
      { now, cause: "customer" }), /Why did the delivery fail/,
    "the cause before C6 is no longer taken");
    await assert.rejects(markAttempted(stores, "D", { cause: "dog", now }),
      /Why did the delivery fail/);
    assert.equal((await getOrder(stores, "D")).attempted, undefined);
  });

  it("keeps the fee for each of the customer's causes, and a detail " +
    "for the email (C6a, C6b)", async () => {
    const stores = testStores();

    for (const [id, cause] of [
      ["A", "no-cooler"], ["B", "no-access"], ["C", "no-address"],
    ]) {
      await saveOrder(stores, delivered(id), now);

      const a = await markAttempted(stores, id, {
        cause, now, detail: id === "B" ? "  the gate was locked " : "",
      });

      assert.equal(a.attempted.fee, 500, cause);
      assert.equal(a.attempted.waived, false, cause);
    }
    assert.equal((await getOrder(stores, "B")).attempted.detail,
      "the gate was locked");
  });

  it("waives the fee for the farm, the weather, or when told", async () => {
    const stores = testStores();
    const { calls, opts } = harness();

    for (const id of ["A", "B", "C"]) {
      await saveOrder(stores, delivered(id), now);
    }

    const farm = await markAttempted(stores, "A", { ...opts, cause: "farm" });
    const weather = await markAttempted(stores, "B",
      { ...opts, cause: "weather" });
    const told = await markAttempted(stores, "C",
      { ...opts, cause: "no-address", waive: "  our map was wrong  " });

    assert.deepEqual(farm.attempted, {
      at: now.toISOString(), date: "2026-10-08", cause: "farm", fee: 0,
      waived: true, note: "", detail: "",
    });
    assert.equal(weather.attempted.fee, 0);
    assert.deepEqual(told.attempted, {
      at: now.toISOString(), date: "2026-10-08", cause: "no-address",
      fee: 0, waived: true, note: "our map was wrong", detail: "",
    });
    assert.equal(keptFee(told), 0);

    // An address outside the usual area keeps its $3 too (James, C9).
    const far = delivered("D");

    far.totals = { ...far.totals, deliveryFee: 800, areaFee: 300,
      total: 2200 };
    await saveOrder(stores, far, now);
    assert.equal(keptFee(await markAttempted(stores, "D",
      { cause: "no-cooler", now })), 800);

    // A waived fee goes back with the rest.
    calls.length = 0;
    await refundOrder(stores, "C", opts);
    assert.deepEqual(calls, [["square.refund", "PAY-C", 1900]]);
  });

  it("asks the customer after their miss, waived or not, by email and " +
    "with a question held seven days (#193)", async () => {
    const stores = testStores();
    const { sent, opts } = harness();
    const env = { ACCOUNTS_ENABLED: "true", URL: "https://x" };

    for (const id of ["A", "B", "C"]) {
      await saveOrder(stores, delivered(id), now);
    }

    const kept = await markAttempted(stores, "A",
      { ...opts, env, cause: "no-cooler" });
    const waived = await markAttempted(stores, "B",
      { ...opts, env, cause: "no-access", waive: "new gate" });

    assert.deepEqual(kept.question, {
      kind: "missed", reason: "", openedAt: now.toISOString(),
      until: "2026-10-15", answeredAt: null, answer: null, by: null,
    });
    assert.equal(waived.question.kind, "missed");
    assert.equal(sent.length, 2);
    assert.equal(sent[0].subject, "We couldn't deliver your order");
    assert.match(sent[0].text, /isn't refunded, whichever you choose/);
    assert.match(sent[0].text, /https:\/\/x\/account\/orders\/A\//);
    assert.doesNotMatch(sent[1].text, /isn't refunded/);
    assert.ok(kept.emails.missedDelivery);

    // Marking again sends nothing more.
    await markAttempted(stores, "A", { ...opts, env, cause: "no-cooler" });
    assert.equal(sent.length, 2);
  });

  it("moves the farm's or the weather's miss a week on, and says so (C7)",
    async () => {
      const stores = testStores();
      const { sent, calls, opts } = harness();

      await saveOrder(stores, delivered("A"), now);

      const moved = await markAttempted(stores, "A",
        { ...opts, cause: "weather" });

      assert.equal(moved.fulfilment.date, "2026-10-15");
      assert.equal(moved.attempted.date, "2026-10-08");
      assert.equal(moved.question, null);
      assert.deepEqual(calls, [["updateFulfilment", "SQO", "2026-10-15"]]);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].subject, "Your delivery is moved to next Thursday");
      assert.ok(moved.emails["movedDelivery-2026-10-15"]);

      // A cancel now refunds it all, fee and all.
      await cancelOrder(stores, "A", { ...opts, reason: "weather" });
      assert.deepEqual(calls.find((c) => c[0] === "square.refund"),
        ["square.refund", "PAY-A", 1900]);
    });

  it("moves a delivery from the CLI, except after a kept fee", async () => {
    const stores = testStores();
    const { sent, calls, opts } = harness();

    for (const id of ["A", "B", "C"]) {
      await saveOrder(stores, delivered(id), now);
    }
    await markAttempted(stores, "A", { ...opts, cause: "no-cooler" });
    await markAttempted(stores, "B",
      { ...opts, cause: "no-cooler", waive: "first time" });
    sent.length = 0;

    await assert.rejects(moveDelivery(stores, "A", "2026-10-15", opts),
      /charges the fee of \$5 again/);
    await assert.rejects(moveDelivery(stores, "B", "2026-10-14", opts),
      /a delivery day after today/);
    await assert.rejects(moveDelivery(stores, "B", "2026-10-12", opts),
      /a delivery day after today/, "a holiday");
    await assert.rejects(moveDelivery(stores, "B", "2026-10-01", opts),
      /a delivery day after today/);

    const b = await moveDelivery(stores, "B", "2026-10-15", opts);

    assert.equal(b.fulfilment.date, "2026-10-15");
    assert.equal(b.question.answer, "reschedule");
    assert.equal(b.question.by, "farm");
    assert.deepEqual(calls.at(-1), ["updateFulfilment", "SQO", "2026-10-15"]);
    assert.equal(sent.at(-1).subject, "Your order is updated");

    // Not yet attempted: any delivery day ahead, past the cutoff.
    const c = await moveDelivery(stores, "C", "2026-10-22", opts);

    assert.equal(c.fulfilment.date, "2026-10-22");
    assert.equal(c.question, null);
  });

  it("refunds everything but the fee", async () => {
    const stores = testStores();
    const { calls, opts } = harness();

    await saveOrder(stores, delivered("A"), now);
    await markAttempted(stores, "A", { cause: "no-cooler", now });
    await assert.rejects(refundOrder(stores, "A", { ...opts, amount: 1500 }),
      /between \$0\.01 and \$14\./);

    const r = await refundOrder(stores, "A", opts);

    assert.deepEqual(calls, [["square.refund", "PAY-A", 1400]]);
    assert.equal(r.refunds.at(-1).total, false);
    await assert.rejects(refundOrder(stores, "A", opts),
      /Only the delivery fee is left \(\$5\)/);

    // Before an attempt, the fee goes back with the rest.
    await saveOrder(stores, delivered("B"), now);
    await refundOrder(stores, "B", opts);
    assert.deepEqual(calls.at(-1), ["square.refund", "PAY-B", 1900]);
  });

  it("cancels with a refund of everything but the fee", async () => {
    const stores = testStores();
    const { sent, calls, opts } = harness();

    await saveOrder(stores, delivered("A"), now);
    await markAttempted(stores, "A", { cause: "no-cooler", now });

    const c = await cancelOrder(stores, "A", { ...opts, refund: true });

    assert.equal(c.status, "cancelled");
    assert.deepEqual(calls, [
      ["square.refund", "PAY-A", 1400], ["fulfilment", "SQO"],
    ]);

    // Only the fee left: the cancel goes through and refunds nothing.
    await saveOrder(stores, delivered("B"), now);
    await markAttempted(stores, "B", { cause: "no-cooler", now });
    await refundOrder(stores, "B", opts);
    await cancelOrder(stores, "B", { ...opts, refund: true });
    assert.deepEqual(calls.at(-1), ["fulfilment", "SQO"]);
    assert.doesNotMatch(sent.at(-1).text, /on its way/);
  });
});
