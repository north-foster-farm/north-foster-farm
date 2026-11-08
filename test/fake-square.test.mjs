// The Square fake keeps to Square's rules (#471, R1): it refuses what
// Square refused when it was recorded (test/fixtures/square/), by
// throwing that recorded refusal, and it honors amounts and
// idempotency keys. Every answer it gives is a recording with the
// request's values put in.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { sampleOrder } from "../bin/fixtures/request.mjs";
import {
  forgetFake, squareTotal,
} from "../netlify/functions/lib/fake-square.mjs";
import * as square from "../netlify/functions/lib/square.mjs";
import { recorded } from "./recorded.mjs";

const DEV = { SITE_CONTEXT: "dev", SQUARE_ENV: "fake" };
const CARD = { sourceId: "cnon:card-nonce-ok" };

const order = (over = {}) => ({
  ...sampleOrder({ kind: "pickup", email: "pat@example.com" }), ...over,
});
const code = (name) => recorded("square", name).response.errors[0].code;
const status = (name) => recorded("square", name).status;

// A refusal is the recorded one: its status and its first code.
const refused = (name) => (error) => {
  assert.ok(error instanceof square.SquareError, String(error));
  assert.equal(error.status, status(name));
  assert.equal(error.code, code(name));

  return true;
};

const placed = async (key, what = order()) => {
  const made = await square.createOrder(what, key, { env: DEV });

  return made.squareOrderId;
};

const pay = (squareOrderId, key, amount, source = CARD, what = order()) =>
  square.createPayment({
    order: what, squareOrderId, customerId: "C1", key, source, amount,
  }, { env: DEV });

beforeEach(forgetFake);

describe("the fake's idea of an order's total", () => {
  it("is Square's: discounts come off line items, never off a fee", () => {
    // James's C1 order, recorded from the sandbox with his
    // get-square-c1-order.sh on 2026-10-26: a $7.00 line, a $5.00
    // delivery fee and $12.00 of credit. Square totalled it $5.00.
    const built = {
      line_items: [{ quantity: "1", base_price_money: { amount: 700 } }],
      service_charges: [{ amount_money: { amount: 500 } }],
      discounts: [{ amount_money: { amount: 1200 } }],
    };

    assert.equal(squareTotal(built), 500);
  });
});

describe("a payment the fake takes", () => {
  it("reads as the recorded payment, with this request's values", async () => {
    const id = await placed("k-take");
    const result = await pay(id, "k-take", 5500);
    const sent = recorded("square", "payment-card-ok").response.payment;

    assert.match(result.squarePaymentId, /^FAKE-PAYMENT-/);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.brand, sent.card_details.card.card_brand);
    assert.equal(result.last4, sent.card_details.card.last_4);
  });

  it("is the same payment when the same key comes again", async () => {
    const id = await placed("k-same");
    const first = await pay(id, "k-same", 5500);
    const again = await pay(id, "k-same", 5500);

    assert.deepEqual(again, first);
  });

  // Square takes no part payment (payment-under-total.json is a 400).
  it("refuses part of the total", async () => {
    const id = await placed("k-part");

    await assert.rejects(pay(id, "k-part-a", 5000),
      refused("payment-under-total"));
    assert.equal((await pay(id, "k-part-b", 5500)).status, "COMPLETED");
    await assert.rejects(pay(id, "k-part-c", 100),
      refused("payment-already-paid"));
  });

  it("takes a Venmo tender and the farm's cash as it does a card",
    async () => {
      const venmo = await placed("k-venmo");
      const cash = await placed("k-cash");
      const read = (name) => square.paymentRecord(
        recorded("square", name).response.payment
      );
      const external = await pay(venmo, "k-venmo", 5500, {
        external: { source: "Venmo", sourceId: "V1", type: "SOCIAL" },
      });
      const taken = await pay(cash, "k-cash", 5500, { cash: true });

      assert.equal(external.brand, read("payment-external").brand);
      assert.equal(external.last4, read("payment-external").last4);
      assert.equal(taken.brand, read("payment-cash").brand);
    });
});

describe("a payment the fake refuses, as Square did", () => {
  it("refuses more than the order's total", async () => {
    const id = await placed("k-over");

    await assert.rejects(pay(id, "k-over", 5501),
      refused("payment-over-total"));
  });

  it("refuses a second payment on a paid order", async () => {
    const id = await placed("k-twice");

    await pay(id, "k-twice-a", 5500);
    await assert.rejects(pay(id, "k-twice-b", 5500),
      refused("payment-already-paid"));
  });

  it("refuses a payment on a cancelled order", async () => {
    const id = await placed("k-cancel");

    assert.deepEqual(await square.cancelOrder(id, { env: DEV }),
      { id, cancelled: true });
    assert.equal((await square.getOrder(id, { env: DEV })).state, "CANCELED");
    await assert.rejects(pay(id, "k-cancel", 5500),
      refused("payment-order-canceled"));
  });

  it("refuses nothing to pay", async () => {
    const id = await placed("k-zero");

    await assert.rejects(pay(id, "k-zero", 0),
      refused("payment-zero-amount"));
  });

  it("refuses a card payment on an order of $0", async () => {
    const free = order({ totals: { ...order().totals, total: 0 } });
    const made = await square.createChangeOrder(free, {
      added: [], difference: 0,
    }, "k-free", { env: DEV });

    await assert.rejects(pay(made.squareOrderId, "k-free", 0, CARD, free),
      refused("payment-zero-order"));
  });

  it("refuses the same key with another amount", async () => {
    const id = await placed("k-reuse");

    await pay(id, "k-reuse", 5500);
    await assert.rejects(pay(id, "k-reuse", 5100),
      refused("payment-key-reused"));
  });

  it("declines with the code of the recorded decline", async () => {
    const id = await placed("k-decl");

    await assert.rejects(pay(id, "k-decl", 5500,
      { sourceId: "cnon:card-nonce-declined" }), (error) => {
      assert.equal(error.declined, true);
      assert.equal(error.status, status("payment-card-declined"));
      assert.equal(error.code, code("payment-card-declined"));

      return true;
    });
    // The order is open still, and the next try pays it.
    assert.equal((await pay(id, "k-decl-2", 5500)).status, "COMPLETED");
  });
});

describe("an order the fake takes", () => {
  // Square answered 200 with the first order (order-create-key-reused).
  it("answers the same key with another order as the first", async () => {
    const first = await placed("k-ord");
    const again = await placed("k-ord", order({
      lines: order().lines.map((line) => ({ ...line, qty: 3 })),
    }));

    assert.equal(again, first);
    assert.equal((await square.getOrder(first, { env: DEV }))
      .line_items[0].quantity, "2");
  });

  it("is the same order when the same key comes again", async () => {
    assert.equal(await placed("k-ord2"), await placed("k-ord2"));
  });

  it("pays an order of $0 and refuses to PayOrder one with a balance",
    async () => {
      const free = order({ totals: { ...order().totals, total: 0 } });
      const made = await square.createChangeOrder(free, {
        added: [], difference: 0,
      }, "k-pz", { env: DEV });
      const owed = await placed("k-pz-owed");

      assert.deepEqual(await square.payZeroOrder(made.squareOrderId, "k-pz",
        { env: DEV }), { squareOrderId: made.squareOrderId });
      await assert.rejects(square.payZeroOrder(owed, "k-pz-owed",
        { env: DEV }), refused("payment-over-total"));
    });

  it("is read back with its lines, its total and what was paid",
    async () => {
      const id = await placed("k-read");
      const open = await square.getOrder(id, { env: DEV });

      assert.equal(open.state, "OPEN");
      assert.equal(open.total_money.amount, 5500);
      assert.equal(open.line_items.length, 1);
      assert.equal(open.line_items[0].name, order().lines[0].name);
      assert.equal("tenders" in open, false, "none until paid");

      const paid = await pay(id, "k-read", 5500);
      const after = await square.getOrder(id, { env: DEV });

      assert.deepEqual(after.tenders.map((t) => t.payment_id),
        [paid.squarePaymentId]);
      assert.equal((await square.completeOrder(id, { env: DEV })).completed,
        true);
      assert.equal((await square.getOrder(id, { env: DEV })).state,
        "COMPLETED");
      assert.equal((await square.completeOrder(id, { env: DEV })).completed,
        false, "a closed order stays closed");
    });

  it("leaves a paid order open when asked to cancel only unpaid ones",
    async () => {
      const id = await placed("k-keep");

      await pay(id, "k-keep", 5500);
      assert.deepEqual(await square.cancelOrder(id,
        { env: DEV, unpaid: true }), { id, cancelled: false, paid: true });
    });
});

describe("a refund the fake makes", () => {
  const refund = (paymentId, amount, key) => square.refundPayment({
    squarePaymentId: paymentId, amount, key, reason: "test",
  }, { env: DEV });

  it("has the status Square gave the recorded refund", async () => {
    const id = await placed("k-ref");
    const paid = await pay(id, "k-ref", 5500);
    const made = await refund(paid.squarePaymentId, 1000, "k-ref");

    assert.equal(made.status,
      recorded("square", "refund-create").response.refund.status);
    assert.equal(made.amount, 1000);
  });

  it("settles when asked, with its amount and status as recorded",
    async () => {
      const id = await placed("k-set");
      const paid = await pay(id, "k-set", 5500);
      const made = await refund(paid.squarePaymentId, 1000, "k-set");
      const read = await square.getRefund(made.squareRefundId, { env: DEV });

      assert.equal(read.squareRefundId, made.squareRefundId);
      assert.equal(read.amount, 1000);
      assert.equal(read.status,
        recorded("square", "refund-get").response.refund.status);
    });

  it("shows on the payment, so the guards against too much can fire",
    async () => {
      const id = await placed("k-sum");
      const paid = await pay(id, "k-sum", 5500);

      assert.equal((await square.getPayment(paid.squarePaymentId,
        { env: DEV })).refunded, 0);
      await refund(paid.squarePaymentId, 1000, "k-sum-a");
      await refund(paid.squarePaymentId, 2000, "k-sum-b");
      assert.equal((await square.getPayment(paid.squarePaymentId,
        { env: DEV })).refunded, 3000);
    });

  it("is refused over what is left of the payment", async () => {
    const id = await placed("k-big");
    const paid = await pay(id, "k-big", 5500);

    await refund(paid.squarePaymentId, 5000, "k-big-a");
    await assert.rejects(refund(paid.squarePaymentId, 501, "k-big-b"),
      refused("refund-too-large"));
    assert.equal((await refund(paid.squarePaymentId, 500, "k-big-c")).amount,
      500);
  });

  it("is the same refund when the same key comes again", async () => {
    const id = await placed("k-rep");
    const paid = await pay(id, "k-rep", 5500);
    const first = await refund(paid.squarePaymentId, 1000, "k-rep");
    const again = await refund(paid.squarePaymentId, 1000, "k-rep");

    assert.deepEqual(again, first);
    assert.equal((await square.getPayment(paid.squarePaymentId,
      { env: DEV })).refunded, 1000, "counted once");
  });
});
