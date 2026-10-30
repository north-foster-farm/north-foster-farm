// Our Square code run on Square's own answers (#471): each fixture in
// test/fixtures/square/ is a real sandbox response (bin/fixtures/record),
// served here to the real functions of lib/square.mjs. Two things are
// held at once. What the code reads from the recorded body is what the
// body holds; and what the code sends is what the recording was made
// from, so a change to a request fails here until it is recorded again.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";

import { sampleOrder } from "../bin/fixtures/request.mjs";
import {
  buildChangeOrder, buildOrder, cancelFulfillment, cancelOrder,
  completeOrder, createOrder, createPayment, customerOrders, deleteCustomer,
  findPaid, getPayment, getRefund, inventoryCounts, payZeroOrder,
  paymentRecord, refundPayment, searchOpenOrders, updateFulfillment,
} from "../netlify/functions/lib/square.mjs";
import { squareTotal } from "../netlify/functions/lib/fake-square.mjs";
import { differences, recorded, serve as serveFrom } from "./recorded.mjs";

const SANDBOX = {
  SQUARE_ENV: "sandbox", SQUARE_ACCESS_TOKEN: "tok",
  SQUARE_LOCATION_ID: "LOCATION_ID_1",
};
// Catalog lines and stock reads are production's; the stub keeps both
// off the wire.
const CATALOG = { ...SANDBOX, SQUARE_ENV: "production" };

const have = (name) => existsSync(new URL(
  `./fixtures/square/${name}.json`, import.meta.url
));
const rec = (name) => recorded("square", name);
const serve = (...names) => serveFrom("square", ...names);

// Runs `run` against the recordings and holds the requests to them.
const replay = async (names, run) => {
  const net = serve(...names);
  const result = await run({ env: SANDBOX, fetchImpl: net.impl });

  assert.deepEqual(net.problems, []);
  assert.deepEqual(net.left(), [], "every recording was asked for");

  return result;
};

const failed = async (names, run, env = SANDBOX) => {
  const net = serve(...names);
  let error;

  try {
    await run({ env, fetchImpl: net.impl });
  } catch (e) {
    error = e;
  }
  assert.ok(error, "it throws");
  assert.deepEqual(net.problems, []);

  return error;
};

const order = (over = {}) => sampleOrder({
  kind: "pickup", email: "customer@example.com", ...over,
});
const paymentArgs = (name, extra = {}) => {
  const body = rec(name).request.body;

  return {
    order: order(), squareOrderId: body.order_id, customerId: body.customer_id,
    key: "KEY", amount: body.amount_money.amount, ...extra,
  };
};
const pay = (name, source) => (o) => createPayment({
  ...paymentArgs(name), source,
}, o);

describe("what our code sends is what was recorded", () => {
  it("builds the pickup, delivery and zero orders recorded", async () => {
    for (const [name, kind] of [
      ["order-create-pickup", "pickup"], ["order-create-delivery", "delivery"],
      ["order-create-external", "pickup"], ["order-create-cash", "pickup"],
    ]) {
      const sent = rec(name).request.body.order;
      const built = buildOrder(order({ kind }), "CUSTOMER_ID_1", {
        locationId: "LOCATION_ID_1", catalog: false,
      });

      assert.deepEqual(differences(sent, JSON.parse(JSON.stringify(built))),
        [], name);
    }
    assert.deepEqual(differences(
      rec("order-create-zero").request.body.order,
      JSON.parse(JSON.stringify(buildChangeOrder(order(), {
        added: [], difference: 0,
      }, "CUSTOMER_ID_1", { locationId: "LOCATION_ID_1", catalog: false }))),
    ), []);
  });

  it("builds a catalog line the way the sandbox took it",
    { skip: !have("order-create-catalog") }, () => {
      const sent = rec("order-create-catalog").request.body.order;
      const built = buildOrder(order({
        kind: "catalog",
        variationId: sent.line_items[0].catalog_object_id,
      }), "CUSTOMER_ID_1", { locationId: "LOCATION_ID_1", catalog: true });

      assert.deepEqual(differences(sent, JSON.parse(JSON.stringify(built))),
        []);
    });
});

describe("the totals Square works out", () => {
  const made = [
    "order-create-pickup", "order-create-delivery", "order-create-external",
    "order-create-cash", "order-create-short", "order-create-zero",
  ];

  for (const name of made) {
    it(`${name}: Square's total is the one the fake works out`, () => {
      const { request, response } = rec(name);

      assert.equal(response.order.total_money.amount,
        squareTotal(request.body.order), name);
    });
  }

  it("a change order with nothing to pay totals nothing", () => {
    assert.equal(rec("order-create-zero").response.order.total_money.amount,
      0);
  });

  it("Square refuses a $0 card payment, alone and on a $0 order", () => {
    for (const name of ["payment-zero-amount", "payment-zero-order"]) {
      assert.ok(rec(name).status >= 400, `${name} was refused`);
    }
  });
});

describe("createOrder", () => {
  it("finds no customer, makes one, and makes the order", async () => {
    const result = await replay(
      ["customers-search-none", "customer-create", "order-create-pickup"],
      (o) => createOrder(order(), "fx-cust-pickup", o)
    );

    assert.equal(result.squareOrderId,
      rec("order-create-pickup").response.order.id);
    assert.equal(result.customerId,
      rec("customer-create").response.customer.id);
    assert.equal(result.customerMade, true);
  });

  it("uses the profile it finds, made for this order by a try before",
    async () => {
      const result = await replay(
        ["customers-search-found", "order-create-pickup"],
        (o) => createOrder(order(), "fx-cust-pickup", o)
      );

      assert.equal(result.customerId,
        rec("customers-search-found").response.customers[0].id);
      // The profile carries this order's id as its reference, as one a
      // retry finds does (#236).
      assert.equal(result.customerMade, true);
    });

  // FINDING (recorded 2026-10-29): Square does not refuse an order key
  // used again with another body. It answers 200 with the first order.
  it("takes a reused key as the first order, as Square does", async () => {
    const reused = rec("order-create-key-reused");
    const result = await replay(
      ["customers-search-found", "order-create-key-reused"],
      (o) => createOrder({ ...order(), id: "NFF-2610-DIFF" },
        "fx-cust-pickup", o)
    );

    assert.equal(reused.status, 200);
    assert.equal(result.squareOrderId, reused.response.order.id);
  });
});

describe("createPayment", () => {
  it("reads the payment Square took for a card", async () => {
    const payment = rec("payment-card-ok").response.payment;
    const result = await replay(["payment-card-ok"],
      pay("payment-card-ok", { sourceId: "cnon:card-nonce-ok" }));

    assert.deepEqual(result, paymentRecord(payment));
    assert.equal(result.squarePaymentId, payment.id);
    assert.ok(["COMPLETED", "APPROVED"].includes(result.status));
    assert.equal(result.brand, payment.card_details.card.card_brand);
    assert.equal(result.last4, payment.card_details.card.last_4);
    assert.equal(payment.amount_money.amount,
      rec("payment-card-ok").request.body.amount_money.amount);
  });

  it("reads a Venmo payment recorded as an external tender", async () => {
    const result = await replay(["payment-external"], pay("payment-external",
      { external: { source: "Venmo", sourceId: "FIXTURE-VENMO-1",
        type: "SOCIAL" } }));

    assert.deepEqual(result,
      paymentRecord(rec("payment-external").response.payment));
  });

  it("reads the farm's cash payment", async () => {
    const result = await replay(["payment-cash"],
      pay("payment-cash", { cash: true }));

    assert.equal(result.squarePaymentId,
      rec("payment-cash").response.payment.id);
  });

  for (const name of [
    "payment-card-declined", "payment-card-rejected-cvv",
    "payment-card-rejected-postalcode", "payment-card-rejected-expiration",
  ]) {
    it(`${name}: is a decline the customer is told about`, async () => {
      const { request, status, response } = rec(name);
      const error = await failed([name], pay(name, {
        sourceId: request.body.source_id,
      }));

      assert.equal(error.status, status);
      assert.equal(error.code, response.errors[0].code);
      assert.equal(error.declined, true,
        `${response.errors[0].code} needs a line in DECLINE_MESSAGES`);
      assert.equal(error.retryable, false);
    });
  }

  for (const name of [
    "payment-key-reused", "payment-already-paid", "payment-order-canceled",
    "payment-zero-amount", "payment-zero-order", "payment-over-total",
  ]) {
    it(`${name}: is our problem, not the card's`, async () => {
      const { request, status, response } = rec(name);
      const error = await failed([name], pay(name, {
        sourceId: request.body.source_id,
      }));

      assert.equal(error.status, status);
      assert.equal(error.code, response.errors[0].code);
      assert.equal(error.declined, false);
      assert.equal(error.retryable, false);
    });
  }

  // FINDING (recorded 2026-10-29): Square takes no part payment. One
  // under the order's total is refused like one over it.
  it("refuses part of an order's total", async () => {
    const { status, response } = rec("payment-under-total");
    const error = await failed(["payment-under-total"],
      pay("payment-under-total", { sourceId: "cnon:card-nonce-ok" }));

    assert.equal(status, 400);
    assert.equal(error.code, response.errors[0].code);
    assert.equal(error.code, "ORDER_TOTAL_MISMATCH");
    assert.equal(error.declined, false);
  });
});

describe("payments and refunds read back", () => {
  it("getPayment reads what has been refunded", async () => {
    const before = await replay(["payment-get"],
      (o) => getPayment("PAYMENT_ID_1", o));
    const after = await replay(["payment-get-refunded"],
      (o) => getPayment("PAYMENT_ID_1", o));

    assert.equal(before.refunded, 0);
    assert.equal(after.refunded,
      rec("refund-create").request.body.amount_money.amount);
  });

  it("refundPayment reads the refund Square made", async () => {
    const { request, response } = rec("refund-create");
    const result = await replay(["refund-create"], (o) => refundPayment({
      squarePaymentId: request.body.payment_id,
      amount: request.body.amount_money.amount,
      key: "KEY",
      reason: request.body.reason,
    }, o));

    assert.deepEqual(result, {
      squareRefundId: response.refund.id,
      status: response.refund.status,
      amount: request.body.amount_money.amount,
    });
  });

  it("getRefund reads the refund once it has settled", async () => {
    const { response } = rec("refund-get");
    const result = await replay(["refund-get"],
      (o) => getRefund("REFUND_ID_1", o));

    assert.equal(result.squareRefundId, response.refund.id);
    assert.equal(result.status, response.refund.status);
    assert.equal(result.amount, response.refund.amount_money.amount);
  });

  it("refuses a refund over what is left", async () => {
    const { request, status, response } = rec("refund-too-large");
    const error = await failed(["refund-too-large"], (o) => refundPayment({
      squarePaymentId: request.body.payment_id,
      amount: request.body.amount_money.amount,
      key: "KEY",
      reason: request.body.reason,
    }, o));

    assert.equal(error.status, status);
    assert.equal(error.code, response.errors[0].code);
    assert.equal(error.retryable, false);
  });
});

describe("orders read and changed", () => {
  const id = "ORDER_ID_1";

  it("completes an open order, fulfillment and all", async () => {
    const result = await replay(["order-get-after-refund", "order-complete"],
      (o) => completeOrder(id, o));

    assert.deepEqual(result, { id, completed: true });
  });

  it("leaves a completed order as it is", async () => {
    const result = await replay(["order-get-completed"],
      (o) => completeOrder(id, o));

    assert.deepEqual(result, { id, completed: false });
  });

  it("cancels a fulfillment", async () => {
    const result = await replay(
      ["order-get-paid-external", "fulfillment-cancel"],
      (o) => cancelFulfillment(id, o)
    );

    assert.deepEqual(result, { id, cancelled: true });
  });

  it("reads Square's refusal of a stale version", async () => {
    const error = await failed(
      ["order-get-paid-external", "order-update-stale-version"],
      (o) => cancelFulfillment(id, o)
    );
    const { status, response } = rec("order-update-stale-version");

    assert.equal(error.status, status);
    assert.equal(error.code, response.errors[0].code);
    assert.equal(error.retryable, false);
  });

  it("changes a fulfillment's details", async () => {
    const result = await replay(["order-get-open", "order-update-fulfillment"],
      (o) => updateFulfillment(id, order({ kind: "delivery" }), o));

    assert.equal(result.id, id);
    assert.equal(typeof result.version, "number");
  });

  // Square refuses to cancel an order while its fulfillment is open
  // (recorded 2026-10-29), so cancelOrder cancels the fulfillment first
  // and the order at the version that answer gives. The two recordings
  // below need `bin/fixtures/record` run again after the cancel fix.
  it("is refused cancelling an order with an open fulfillment",
    { skip: !have("order-cancel-refused") }, () => {
      const { status, response, request } = rec("order-cancel-refused");

      assert.equal(status, 400);
      assert.equal(response.errors[0].code, "INVALID_VALUE");
      assert.equal(request.body.order.state, "CANCELED");
      assert.equal(request.body.order.fulfillments, undefined);
    });

  it("cancels the fulfillment, then the order",
    { skip: !have("order-cancel-fulfillment") }, async () => {
      const result = await replay([
        "order-get-before-cancel", "order-cancel-fulfillment", "order-cancel",
      ], (o) => cancelOrder(id, o));

      assert.deepEqual(result, { id, cancelled: true });
      assert.equal(rec("order-cancel").response.order.state, "CANCELED");
    });

  it("leaves a paid order alone when told to cancel only unpaid ones",
    async () => {
      const result = await replay(["order-get-paid"],
        (o) => cancelOrder(id, { ...o, unpaid: true }));

      assert.deepEqual(result, { id, cancelled: false, paid: true });
    });

  it("leaves a completed order alone", async () => {
    const result = await replay(["order-get-completed"],
      (o) => cancelOrder(id, o));

    assert.deepEqual(result, { id, cancelled: false, paid: true });
  });

  it("pays an order of $0 with no payment ids", async () => {
    const result = await replay(["order-pay-zero"],
      (o) => payZeroOrder(id, "KEY", o));

    assert.deepEqual(result, { squareOrderId: id });
    assert.equal(rec("order-pay-zero").response.order.state, "COMPLETED");
  });
});

describe("searches", () => {
  it("findPaid finds the order we made and its payment", async () => {
    const result = await replay(["orders-search-recent", "payment-get"],
      (o) => findPaid(order(), o));

    assert.ok(result, "a paid order with our reference is found");
    assert.ok(["COMPLETED", "APPROVED"].includes(result.status));
    assert.equal(typeof result.squareOrderId, "string");
    assert.equal(typeof result.amount, "number");
  });

  it("searchOpenOrders reads each open order", async () => {
    const result = await replay(["orders-search-open"],
      (o) => searchOpenOrders({ before: new Date(), max: 100 }, o));
    const sent = rec("orders-search-open").response.orders || [];

    assert.equal(result.length, sent.length);
    for (const found of result) {
      assert.equal(typeof found.id, "string");
      assert.equal(typeof found.tenders, "number");
      assert.equal(typeof found.total, "number");
    }
  });

  it("customerOrders sees the customer paid", async () => {
    const result = await replay(["locations-list", "orders-search-customer"],
      (o) => customerOrders("CUSTOMER_ID_1", {
        since: new Date(Date.now() - 36e5),
      }, o));

    assert.equal(result.paid, true);
  });

  it("deleteCustomer reads a deletion and one already gone", async () => {
    assert.deepEqual(await replay(["customer-delete"],
      (o) => deleteCustomer("CUSTOMER_ID_1", o)), { deleted: true });
    assert.deepEqual(await replay(["customer-delete-gone"],
      (o) => deleteCustomer("CUSTOMER_ID_1", o)),
    { deleted: false, gone: true });
  });
});

describe("stock", () => {
  it("inventoryCounts reads the counts at our location", async () => {
    const ids = rec("inventory-counts").request.body.catalog_object_ids;
    const net = serve("inventory-counts");
    const result = await inventoryCounts(ids, {
      env: CATALOG, fetchImpl: net.impl,
    });

    assert.deepEqual(net.problems, []);
    for (const [variation, n] of Object.entries(result)) {
      assert.ok(ids.includes(variation) || variation.length > 0);
      assert.equal(Number.isInteger(n), true);
    }
  });
});
