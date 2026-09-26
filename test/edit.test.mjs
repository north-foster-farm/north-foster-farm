import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle as placeOrder } from "../netlify/functions/orders.mjs";
import { rescueCheckout } from "../netlify/functions/lib/checkout.mjs";
import {
  diffLines, editOrder, finishEditVenmo,
} from "../netlify/functions/lib/edit.mjs";
import { getCheckout, getOrder } from "../netlify/functions/lib/records.mjs";
import { buildChangeOrder } from "../netlify/functions/lib/square.mjs";
import { SquareError } from "../netlify/functions/lib/square.mjs";
import { getCounts, setCount } from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

// Tuesday 6 October 2026, 09:00 ET; on-farm pickup Wednesday the 7th.
const now = instant("2026-10-06", 9, 0, "America/New_York");
const SKU = "NFF-CHK-WHL-0350-0400";
const env = { ADMIN_EMAILS: "farm@example.com", URL: "https://x" };
const customer = { email: "pat@example.com", name: "Pat Example" };
const quiet = { sleep: async () => {} };

const fakeSquare = ({ pay } = {}) => {
  const calls = [];
  let n = 0;
  const square = {
    createOrder: async () => ({ squareOrderId: "SQO", customerId: "CUST" }),
    createChangeOrder: async (order, change, key) => {
      calls.push(["changeOrder", key, change.difference, !!change.carries,
        order.fulfilment.method]);

      return { squareOrderId: `SQC${++n}`, customerId: "CUST" };
    },
    createPayment: async (args) => {
      calls.push(["payment", args.key, args.order.totals.total,
        args.squareOrderId]);
      if (pay) return pay(args);

      return {
        squarePaymentId: args.squareOrderId === "SQO" ? "PAY1"
          : `PAY-${args.squareOrderId}`,
        status: "COMPLETED", receiptUrl: null, brand: "VISA", last4: "4242",
        wallet: null,
      };
    },
    payZeroOrder: async (id) => {
      calls.push(["payZero", id]);

      return { squareOrderId: id };
    },
    cancelOrder: async (id) => calls.push(["cancelOrder", id]),
    cancelFulfilment: async (id) => calls.push(["cancelFulfilment", id]),
    updateFulfilment: async (id, o) => {
      calls.push(["updateFulfilment", id, o.fulfilment.date]);
    },
    refundPayment: async ({ squarePaymentId, amount, key }) => {
      calls.push(["refund", squarePaymentId, amount, key]);

      return { squareRefundId: `R-${key}`, status: "PENDING", amount };
    },
  };

  return { square, calls };
};

const fakePaypal = () => {
  const calls = [];
  let n = 0;
  const paypal = {
    createOrder: async (order) => {
      calls.push(["create", order.totals.total]);

      return { paypalOrderId: `PPO-${++n}` };
    },
    captureOrder: async (paypalOrderId) => {
      calls.push(["capture", paypalOrderId]);

      return {
        paypalOrderId, paypalCaptureId: `CAP-${paypalOrderId}`,
        status: "COMPLETED", amount: null,
        payer: { email: "pat@venmo", name: "Pat" },
      };
    },
    getOrder: async () => ({ status: "APPROVED", updatedAt: null }),
  };

  return { paypal, calls };
};

const newOrder = {
  idempotencyKey: "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
  customer: {
    firstName: "Pat", lastName: "Example", email: "pat@example.com",
    phone: "401-555-0100", contact: "call",
  },
  lines: [{ sku: SKU, qty: 2 }],
  fulfilment: {
    method: "onfarm", date: "2026-10-07", onfarm: { window: "morning" },
  },
  claimedTotal: 5500,
  payment: { method: "card", sourceId: "cnon:tok" },
};

// A paid order, placed the way the page places one. -> { stores, id }
const placed = async () => {
  const stores = testStores();
  const res = await placeOrder(new Request("http://x/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(newOrder),
  }), { stores, square: fakeSquare().square, now, env, mail: async () => ({}),
    ...quiet });

  assert.equal(res.status, 200);

  return { stores, id: (await res.json()).orderId };
};

let keys = 0;
const editKey = () => `edit-key-000000-${++keys}`;

// Asks once without a total to learn it, as the page learns it from
// the same code, then sends the edit.
const edit = async (stores, id, body, square, extra = {}) => {
  const opts = { now, env, mail: async () => ({}), square, ...quiet, ...extra };
  const first = await editOrder(stores, customer, id, body, opts);

  if (first.ok || !first.errors.total) return first;

  return editOrder(stores, customer, id, {
    ...body, claimedTotal: first.totals.total,
  }, opts);
};

describe("diffLines", () => {
  it("splits a change into what was added, what was taken off", () => {
    const d = diffLines(
      [{ sku: "A", qty: 2 }, { sku: "B", qty: 1 }],
      [{ sku: "A", qty: 3 }, { sku: "C", qty: 1 }],
    );

    assert.deepEqual(d.delta, [
      { sku: "A", qty: 1 }, { sku: "B", qty: -1 }, { sku: "C", qty: 1 },
    ]);
    assert.deepEqual(d.added.map((l) => [l.sku, l.qty]), [["A", 1], ["C", 1]]);
    assert.deepEqual(d.removed.map((l) => [l.sku, l.qty]), [["B", 1]]);
  });
});

describe("buildChangeOrder", () => {
  const cfg = { locationId: "L", catalog: false };
  const order = { id: "NFF-1", fulfilment: { method: "onfarm" } };
  const line = { name: "Chicken", unitPrice: 30, qty: 1 };
  const total = (o) => o.line_items.reduce((s, l) =>
    s + l.base_price_money.amount * Number(l.quantity), 0)
    - ((o.discounts || [])[0] ? o.discounts[0].amount_money.amount : 0);

  it("totals the difference, whatever the change", () => {
    for (const [added, difference] of [
      [[line], 3000], [[line], 2500], [[line], 4000], [[], 200], [[], -700],
      [[line], -500],
    ]) {
      const out = buildChangeOrder(order, { added, difference }, "C", cfg);

      assert.equal(total(out), Math.max(0, difference), `${difference}`);
      assert.equal(out.reference_id, "NFF-1");
      assert.equal(out.fulfillments, undefined);
    }
  });
});

describe("editOrder", () => {
  it("charges the difference on a Square order of its own", async () => {
    const { stores, id } = await placed();
    const { square, calls } = fakeSquare();
    const key = editKey();
    const result = await edit(stores, id, {
      idempotencyKey: key, lines: [{ sku: SKU, qty: 3 }],
      payment: { method: "card", sourceId: "cnon:tok2" },
    }, square);

    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const saved = await getOrder(stores, id);
    const diff = saved.totals.total - 5500;

    assert.ok(diff > 0);
    assert.equal(result.difference, diff);
    assert.deepEqual(saved.payments.map((p) => p.amount), [5500, diff]);
    assert.equal(saved.payments[1].edit, key);
    assert.equal(saved.lines[0].qty, 3);
    assert.deepEqual(saved.square.changes.map((c) => c.squareOrderId),
      ["SQC1"]);
    assert.deepEqual(calls.find((c) => c[0] === "payment").slice(2),
      [diff, "SQC1"]);
    assert.ok(calls.some((c) => c[0] === "updateFulfilment" && c[1] === "SQO"));
    assert.equal(saved.edits[0].state, "done");

    // A retry of the same edit charges nothing more.
    const again = await editOrder(stores, customer, id, {
      idempotencyKey: key, lines: [{ sku: SKU, qty: 3 }],
    }, { now, env, square, ...quiet });

    assert.equal(again.ok, true);
    assert.equal(calls.filter((c) => c[0] === "payment").length, 1);
  });

  it("refunds the difference to the payment that took it", async () => {
    const { stores, id } = await placed();
    const { square, calls } = fakeSquare();
    const key = editKey();
    const result = await edit(stores, id, {
      idempotencyKey: key, lines: [{ sku: SKU, qty: 1 }],
    }, square);

    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const saved = await getOrder(stores, id);
    const back = 5500 - saved.totals.total;
    const refund = calls.find((c) => c[0] === "refund");

    assert.ok(back > 0);
    assert.deepEqual(refund.slice(1, 3), ["PAY1", back]);
    assert.equal(saved.refunds.length, 1);
    assert.equal(saved.refunds[0].edit, key);
    assert.equal(saved.refunds[0].source, "customer");
    assert.equal(saved.refunds[0].amount, back);
    assert.ok(!calls.some((c) => c[0] === "changeOrder"));
  });

  it("leaves the order as it was when the card is declined", async () => {
    const { stores, id } = await placed();

    await setCount(stores, SKU, 10);

    const before = await getOrder(stores, id);
    const { square, calls } = fakeSquare({
      pay: () => {
        throw new SquareError("declined", {
          declined: true, code: "CARD_DECLINED",
        });
      },
    });
    const result = await edit(stores, id, {
      idempotencyKey: editKey(), lines: [{ sku: SKU, qty: 3 }],
      payment: { method: "card", sourceId: "cnon:bad" },
    }, square);

    assert.equal(result.status, 402);
    assert.match(result.errors.payment, /declined/);
    assert.deepEqual(await getOrder(stores, id), before);
    assert.equal((await getCounts(stores))[SKU], 10);
    assert.ok(calls.some((c) => c[0] === "cancelOrder" && c[1] === "SQC1"));
  });

  it("keeps a line that sold out since, and refuses more of it",
    async () => {
      const { stores, id } = await placed();
      const { square } = fakeSquare();

      await setCount(stores, SKU, 0);

      const moved = await edit(stores, id, {
        idempotencyKey: editKey(),
        fulfilment: { date: "2026-10-08" },
      }, square);

      assert.equal(moved.ok, true, JSON.stringify(moved.errors));
      assert.equal((await getCounts(stores))[SKU], 0);

      const more = await edit(stores, id, {
        idempotencyKey: editKey(), lines: [{ sku: SKU, qty: 3 }],
        payment: { method: "card", sourceId: "cnon:tok" },
      }, square);

      assert.equal(more.status, 422);
      assert.match(more.errors[`lines.${SKU}`], /sold out/);
    });

  it("moves stock by the change alone", async () => {
    const { stores, id } = await placed();

    await setCount(stores, SKU, 10);
    await edit(stores, id, {
      idempotencyKey: editKey(), lines: [{ sku: SKU, qty: 1 }],
    }, fakeSquare().square);

    assert.equal((await getCounts(stores))[SKU], 11);
  });

  it("moves the fulfilment to a new Square order on a switch", async () => {
    const { stores, id } = await placed();
    const { square, calls } = fakeSquare();
    const result = await edit(stores, id, {
      idempotencyKey: editKey(),
      fulfilment: {
        method: "delivery", date: "2026-10-08",
        delivery: {
          address1: "1 Main St", town: "Foster", zip: "02825",
          cooler: "Porch",
        },
      },
      payment: { method: "card", sourceId: "cnon:tok" },
    }, square);

    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const saved = await getOrder(stores, id);

    assert.equal(saved.fulfilment.method, "delivery");
    assert.equal(saved.fulfilment.state, "agreed");
    assert.equal(saved.square.fulfilmentOrderId, "SQC1");
    assert.deepEqual(calls.find((c) => c[0] === "changeOrder").slice(3),
      [true, "delivery"]);
    assert.ok(calls.some((c) => c[0] === "cancelFulfilment" && c[1] === "SQO"));
    assert.ok(!calls.some((c) => c[0] === "payZero"));
  });

  it("completes a $0 Square order for a switch with nothing to pay",
    async () => {
      const { stores, id } = await placed();
      const { square, calls } = fakeSquare();
      // To the drop site, which charges no fee: the same total.
      const result = await edit(stores, id, {
        idempotencyKey: editKey(),
        fulfilment: { method: "scituate", date: "2026-10-17" },
      }, square);

      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.deepEqual(calls.filter((c) => c[0] === "payZero"),
        [["payZero", "SQC1"]]);
      assert.equal((await getOrder(stores, id)).square.fulfilmentOrderId,
        "SQC1");
    });

  it("takes the difference by Venmo in two steps", async () => {
    const { stores, id } = await placed();
    const { square, calls } = fakeSquare();
    const paypal = fakePaypal();
    const key = editKey();
    const body = { idempotencyKey: key, lines: [{ sku: SKU, qty: 3 }] };
    const started = await edit(stores, id, {
      ...body, payment: { method: "venmo", stage: "create" },
    }, square, { paypal: paypal.paypal });

    assert.equal(started.ok, true, JSON.stringify(started.errors));
    assert.equal(started.paypalOrderId, "PPO-1");
    assert.equal(paypal.calls[0][1], started.difference);
    // Nothing changes until the money is in.
    assert.equal((await getOrder(stores, id)).lines[0].qty, 2);

    const opts = { now, env, square, paypal: paypal.paypal, ...quiet };
    const capture = { ...body, payment: {
      method: "venmo", stage: "capture", paypalOrderId: "PPO-1",
    } };
    const finished = await editOrder(stores, customer, id, capture, opts);

    assert.equal(finished.ok, true, JSON.stringify(finished.errors));

    const saved = await getOrder(stores, id);
    const p = saved.payments[1];

    assert.equal(saved.lines[0].qty, 3);
    assert.deepEqual([p.via, p.amount, p.paypalCaptureId, p.edit],
      ["venmo", started.difference, "CAP-PPO-1", key]);
    assert.equal(p.squarePaymentId, "PAY-SQC1");
    assert.deepEqual(calls.find((c) => c[0] === "payment").slice(2),
      [started.difference, "SQC1"]);

    // The page's retry after a lost answer finds the record.
    assert.equal((await editOrder(stores, customer, id, capture, opts)).ok,
      true);
    assert.equal(paypal.calls.filter((c) => c[0] === "capture").length, 1);
  });

  it("refuses a Venmo capture once the order has moved on", async () => {
    const { stores, id } = await placed();
    const { square } = fakeSquare();
    const paypal = fakePaypal();
    const key = editKey();

    await edit(stores, id, {
      idempotencyKey: key, lines: [{ sku: SKU, qty: 3 }],
      payment: { method: "venmo", stage: "create" },
    }, square, { paypal: paypal.paypal });
    // Meanwhile another change refunds part of the order.
    await edit(stores, id, {
      idempotencyKey: editKey(), lines: [{ sku: SKU, qty: 1 }],
    }, square);

    const late = await editOrder(stores, customer, id, {
      idempotencyKey: key, payment: {
        method: "venmo", stage: "capture", paypalOrderId: "PPO-1",
      },
    }, { now, env, square, paypal: paypal.paypal, ...quiet });

    assert.equal(late.status, 409);
    assert.ok(!paypal.calls.some((c) => c[0] === "capture"));
  });

  it("is finished by the jobs when the page never came back", async () => {
    const { stores, id } = await placed();
    const { square } = fakeSquare();
    const paypal = fakePaypal();
    const key = editKey();

    await edit(stores, id, {
      idempotencyKey: key, lines: [{ sku: SKU, qty: 3 }],
      payment: { method: "venmo", stage: "create" },
    }, square, { paypal: paypal.paypal });

    const checkout = await getCheckout(stores, key);
    const later = new Date(now.getTime() + 20 * 60_000);
    const saved = await rescueCheckout(stores, checkout, {
      paypal: paypal.paypal, square, env, now: later, ...quiet,
      mail: async () => ({}), finishEdit: finishEditVenmo,
    });

    assert.equal(saved.lines[0].qty, 3);
    assert.equal(saved.payments[1].paypalOrderId, "PPO-1");
    assert.equal(await getCheckout(stores, key), null);
  });

  it("refuses someone else's order and an order past its cutoff",
    async () => {
      const { stores, id } = await placed();
      const other = await editOrder(stores, { email: "x@example.com" }, id, {
        idempotencyKey: editKey(),
      }, { now, env });

      assert.equal(other.status, 404);

      const late = await editOrder(stores, customer, id, {
        idempotencyKey: editKey(), lines: [{ sku: SKU, qty: 1 }],
      }, { now: instant("2026-10-07", 12, 0, "America/New_York"), env });

      assert.equal(late.status, 409);
    });
});
