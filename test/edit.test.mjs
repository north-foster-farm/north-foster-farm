import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { handle as placeOrder } from "../netlify/functions/orders.mjs";
import { rescueCheckout } from "../netlify/functions/lib/checkout.mjs";
import {
  diffLines, editOrder, farmEdit, finishEditVenmo,
} from "../netlify/functions/lib/edit.mjs";
import {
  cancelOrder, changeOrder, planChange,
} from "../netlify/functions/lib/account.mjs";
import {
  amendOrder, getCheckout, getOrder, paymentsOf,
} from "../netlify/functions/lib/records.mjs";
import { buildChangeOrder } from "../netlify/functions/lib/square.mjs";
import { SquareError } from "../netlify/functions/lib/square.mjs";
import { getCounts, setCount } from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import { validateOrder } from "../assets/scripts/order/lib/validate.mjs";
import {
  notifyFarm, sendForOrder, withholdCustomerEmail,
} from "../netlify/functions/lib/payments.mjs";
import { summaryLine } from "../netlify/functions/lib/templates.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { AFTERNOON, MORNING, SCHEDULE } from "./schedule-fixture.mjs";

const MAILS = {
  FARM_NOTIFICATIONS_EMAIL: "farm@example.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@example.com",
};

// Tuesday 6 October 2026, 09:00 ET; on-farm pickup Wednesday the 7th.
const now = instant("2026-10-06", 9, 0, "America/New_York");
const SKU = "NFF-CHK-WHL-35-39";
const env = {
  ...MAILS, URL: "https://x", PICKUP_SCHEDULE: SCHEDULE,
};
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
    method: "onfarm", date: "2026-10-07", onfarm: { window: MORNING },
  },
  claimedTotal: 5500,
  payment: { method: "card", sourceId: "cnon:tok" },
};

// A paid order, placed the way the page places one. -> { stores, id }
const placed = async (fulfilment = newOrder.fulfilment) => {
  const stores = testStores();
  const res = await placeOrder(new Request("http://x/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...newOrder, fulfilment }),
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
  it("changes a delivery address alone, and finishes a pending retry",
    async () => {
      const { stores, id } = await placed();
      const { square } = fakeSquare();
      const home = {
        method: "delivery", date: "2026-10-08",
        delivery: {
          address1: "1 Main St", town: "Foster", zip: "02825",
          cooler: "Porch",
        },
      };

      await edit(stores, id, {
        idempotencyKey: editKey(), fulfilment: home,
        payment: { method: "card", sourceId: "cnon:tok" },
      }, square);

      const key = editKey();
      const body = { idempotencyKey: key, fulfilment: { delivery: {
        ...home.delivery, address1: "2 Oak Rd" } } };
      const result = await edit(stores, id, body, square);

      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.equal(result.difference, 0);
      assert.equal((await getOrder(stores, id)).fulfilment.delivery.address1,
        "2 Oak Rd");

      const saved = await getOrder(stores, id);

      await amendOrder(stores, id, { edits: saved.edits.map((e) =>
        e.key === key ? { ...e, state: "pending" } : e) }, "test.crash", now);

      const again = await edit(stores, id, body, square);

      assert.equal(again.ok, true, JSON.stringify(again.errors));
      assert.equal((await getOrder(stores, id)).edits
        .find((e) => e.key === key).state, "done");
    });

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

  it("never charges a pending edit's difference twice", async () => {
    const { stores, id } = await placed();
    const { square, calls } = fakeSquare();
    const key = editKey();
    const body = { idempotencyKey: key, lines: [{ sku: SKU, qty: 3 }] };
    const first = await edit(stores, id, {
      ...body, payment: { method: "card", sourceId: "cnon:tok2" },
    }, square);

    assert.equal(first.ok, true, JSON.stringify(first.errors));

    const saved = await getOrder(stores, id);

    await amendOrder(stores, id, { edits: saved.edits.map((e) =>
      e.key === key ? { ...e, state: "pending" } : e) }, "test.crash", now);

    const tries = [
      { ...body, payment: { method: "card", sourceId: "cnon:tok3" } },
      { ...body, attempt: 2,
        payment: { method: "card", sourceId: "cnon:tok3" } },
      body,
    ];

    for (const retry of tries) {
      const again = await edit(stores, id, retry, square);

      assert.equal(again.ok, true, JSON.stringify(again.errors));
      assert.equal((await getOrder(stores, id)).edits
        .find((e) => e.key === key).state, "done");
      await amendOrder(stores, id, { edits: (await getOrder(stores, id))
        .edits.map((e) => (e.key === key ? { ...e, state: "pending" }
          : e)) }, "test.crash", now);
    }

    assert.equal(calls.filter((c) => c[0] === "payment").length, 1);
    assert.equal(calls.filter((c) => c[0] === "changeOrder").length, 1);
    assert.equal((await getOrder(stores, id)).payments
      .filter((p) => p.edit === key).length, 1);
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

  it("tells the customer and the farm once, with the money", async () => {
    const { stores, id } = await placed();
    const sent = [];
    const mail = async (m) => {
      sent.push(m);

      return { id: `m${sent.length}`, driver: "test" };
    };
    const body = { idempotencyKey: editKey(), lines: [{ sku: SKU, qty: 1 }] };
    const square = fakeSquare().square;
    const first = await edit(stores, id, body, square, { mail });

    await editOrder(stores, customer, id, {
      ...body, claimedTotal: first.order.totals.total,
    }, { now, env, square, mail, ...quiet });

    const back = 5500 - first.order.totals.total;
    const [toCustomer, toFarm] = sent;

    assert.equal(sent.length, 2);
    assert.equal(toCustomer.to, "pat@example.com");
    assert.equal(toCustomer.subject, "Your order is updated");
    assert.match(toCustomer.text, new RegExp(`refunded \\$${back / 100}`));
    assert.deepEqual(toFarm.to, ["farm@example.com"]);
    assert.match(toFarm.subject, new RegExp(`^Order changed: ${id}`));
    assert.match(toFarm.text, /Before/);
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

  it("counts nothing of a fee a missed delivery kept (#193)", async () => {
    const { stores, id } = await placed();
    const { square, calls } = fakeSquare();
    const home = {
      method: "delivery", date: "2026-10-08",
      delivery: {
        address1: "1 Main St", town: "Foster", zip: "02825", cooler: "Porch",
      },
    };

    await edit(stores, id, {
      idempotencyKey: editKey(), fulfilment: home,
      payment: { method: "card", sourceId: "cnon:tok" },
    }, square);

    const delivered = await getOrder(stores, id);
    const fee = delivered.totals.deliveryFee;

    assert.ok(fee > 0);
    await amendOrder(stores, id, {
      attempted: { at: now.toISOString(), cause: "no-cooler", fee,
        waived: false, note: "", detail: "" },
      question: { kind: "missed", reason: "", until: "2026-10-15",
        openedAt: now.toISOString(), answeredAt: null, answer: null,
        by: null },
    }, "delivery.attempted", now);

    // Another day's delivery: the fee again, and nothing else.
    const again = await edit(stores, id, {
      idempotencyKey: editKey(), fulfilment: { ...home, date: "2026-10-15" },
      payment: { method: "card", sourceId: "cnon:tok2" },
    }, square);

    assert.equal(again.ok, true, JSON.stringify(again.errors));
    assert.equal(again.difference, fee);
    assert.equal(again.order.question.answer, "reschedule");

    // To pickup: the second fee comes back, the kept one never.
    const pickup = await edit(stores, id, {
      idempotencyKey: editKey(),
      fulfilment: { method: "onfarm", date: "2026-10-07",
        onfarm: { window: MORNING } },
    }, square);

    assert.equal(pickup.ok, true, JSON.stringify(pickup.errors));
    assert.equal(pickup.difference, -fee);
    assert.deepEqual(calls.filter((c) => c[0] === "refund")
      .map((c) => c[2]), [fee]);
    assert.equal(pickup.order.keptFee, fee);
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

// An archived variation stays in the catalog, and a paid order that
// holds one keeps it through a change or a cancel (6305650920).
describe("a paid order holding an archived line", () => {
  const HEN = "NFF-CHK-CRN-0000-0300";

  // A placed order whose record also holds a Cornish hen, as one
  // bought before the hens were archived would.
  const withHen = async () => {
    const { stores, id } = await placed();
    const order = await getOrder(stores, id);

    await amendOrder(stores, id, {
      lines: [...order.lines, {
        sku: HEN, label: "Cornish Hens, under 3.0 lbs", qty: 1,
        unitPrice: 20, lineTotal: 20,
      }],
    }, "test.held", now);

    return { stores, id };
  };

  it("keeps the line when the rest changes", async () => {
    const { stores, id } = await withHen();
    const result = await edit(stores, id, {
      idempotencyKey: editKey(),
      lines: [{ sku: SKU, qty: 1 }, { sku: HEN, qty: 1 }],
    }, fakeSquare().square);

    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual((await getOrder(stores, id)).lines
      .map((l) => [l.sku, l.qty]), [[SKU, 1], [HEN, 1]]);
  });

  it("lets it fall but never rise", async () => {
    const { stores, id } = await withHen();
    const more = await edit(stores, id, {
      idempotencyKey: editKey(),
      lines: [{ sku: SKU, qty: 2 }, { sku: HEN, qty: 2 }],
    }, fakeSquare().square);

    assert.equal(more.ok, false);
    assert.equal(more.errors[`lines.${HEN}`],
      "Cornish Hens, under 3.0 lbs is not available.");

    const fewer = await edit(stores, id, {
      idempotencyKey: editKey(), lines: [{ sku: SKU, qty: 2 }],
    }, fakeSquare().square);

    assert.equal(fewer.ok, true, JSON.stringify(fewer.errors));
    assert.deepEqual((await getOrder(stores, id)).lines.map((l) => l.sku),
      [SKU]);
  });

  it("cancels", async () => {
    const { stores, id } = await withHen();
    const r = await cancelOrder(stores, customer, id, {
      now, env, mail: async () => ({}), square: fakeSquare().square,
    });

    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal((await getOrder(stores, id)).status, "cancelled");
  });
});

// An order holding a SKU the catalog no longer knows (placed before
// the rename, #267) can't be changed: saving would drop that line and
// refund it. It can still be cancelled.
describe("a paid order holding an unknown SKU", () => {
  it("refuses a change", async () => {
    const { stores, id } = await placed();

    await amendOrder(stores, id, {
      lines: [{ sku: "NFF-CHK-WHL-0350-0400", label: "Whole Chicken, " +
        "3.5 – 3.9 lbs", qty: 2, unitPrice: 30, lineTotal: 60 }],
    }, "test.renamed", now);

    const result = await edit(stores, id, {
      idempotencyKey: editKey(), lines: [{ sku: SKU, qty: 1 }],
    }, fakeSquare().square);

    assert.equal(result.status, 409);
    assert.equal((await getOrder(stores, id)).lines[0].sku,
      "NFF-CHK-WHL-0350-0400");
  });
});

// The farm changes an order for the customer (#306).
describe("farmEdit", () => {
  const outbox = () => {
    const sent = [];

    return { sent, mail: async (m) => {
      sent.push(m);

      return { id: `m${sent.length}`, driver: "test" };
    } };
  };
  const opts = (square, mail, extra = {}) => ({
    now, env, square, mail, ...quiet, ...extra,
  });

  it("moves an on-farm pickup to the drop site, as the farm", async () => {
    const { stores, id } = await placed();
    const { square, calls } = fakeSquare();
    const { sent, mail } = outbox();
    const result = await farmEdit(stores, id, {
      fulfilment: { method: "scituate", date: "2026-10-17" },
    }, opts(square, mail));

    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const saved = await getOrder(stores, id);
    const events = saved.history.map((h) => h.event);

    assert.equal(saved.fulfilment.method, "scheduled");
    assert.equal(saved.fulfilment.occurrence, "VFVQ-261017");
    assert.equal(saved.fulfilment.date, "2026-10-17");
    assert.ok(events.includes("farm.changed"));
    assert.ok(!events.includes("edit.done"));
    assert.equal(saved.edits[0].by, "farm");
    assert.ok(calls.some((c) => c[0] === "cancelFulfilment" && c[1] === "SQO"));
    // The customer is told; the farm is not told of its own change.
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "pat@example.com");
    assert.equal(sent[0].subject, "Your order is updated");
  });

  it("changes the date and pickup time as the quick change does",
    async () => {
      const { stores, id } = await placed();
      const { square, calls } = fakeSquare();
      const { sent, mail } = outbox();
      const result = await farmEdit(stores, id, {
        fulfilment: { date: "2026-10-08", onfarm: { window: AFTERNOON } },
      }, opts(square, mail));

      assert.equal(result.ok, true, JSON.stringify(result.errors));

      const saved = await getOrder(stores, id);

      assert.equal(saved.fulfilment.date, "2026-10-08");
      assert.equal(saved.fulfilment.onfarm.window, AFTERNOON);
      assert.ok(saved.history.some((h) => h.event === "farm.changed"));
      assert.ok(calls.some((c) => c[0] === "updateFulfilment"
        && c[2] === "2026-10-08"));
      assert.deepEqual(sent.map((m) => m.subject), ["Your order is updated"]);
    });

  it("moves a pickup to a market site, and Square follows", async () => {
    const { stores, id } = await placed();
    const { square, calls } = fakeSquare();
    const { sent, mail } = outbox();
    const result = await farmEdit(stores, id, {
      fulfilment: { method: "market", site: "foster", date: "2026-10-25" },
    }, opts(square, mail));

    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const saved = await getOrder(stores, id);

    assert.equal(saved.fulfilment.method, "scheduled");
    assert.equal(saved.fulfilment.occurrence, "WAC5-261025");
    assert.equal(saved.fulfilment.date, "2026-10-25");
    assert.ok(calls.some((c) => c[0] === "cancelFulfilment"));
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Foster Farmers Market/);
    assert.match(summaryLine(saved), /paid \$55 Foster Farmers Market 2026/);
  });

  it("refuses a market the schedule or the data lacks", async () => {
    const { stores, id } = await placed();
    const { square } = fakeSquare();
    const { sent, mail } = outbox();
    const monday = await farmEdit(stores, id, {
      fulfilment: { method: "market", site: "foster", date: "2026-10-26" },
    }, opts(square, mail));
    const nowhere = await farmEdit(stores, id, {
      fulfilment: { method: "market", site: "nope", date: "2026-10-25" },
    }, opts(square, mail));

    assert.equal(monday.ok, false);
    assert.equal(monday.errors["fulfilment.occurrence"],
      "That pickup is no longer available.");
    assert.equal(nowhere.ok, false);
    assert.ok(nowhere.errors["fulfilment.occurrence"]);
    assert.equal((await getOrder(stores, id)).fulfilment.method, "onfarm");
    assert.equal(sent.length, 0);
  });

  it("keeps where the order was, and shows it in the email", async () => {
    const { stores, id } = await placed({
      method: "scituate", date: "2026-10-17",
    });
    const { square } = fakeSquare();
    const { sent, mail } = outbox();
    const result = await farmEdit(stores, id, {
      fulfilment: { method: "market", site: "foster", date: "2026-10-25" },
    }, opts(square, mail));

    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const { before } = (await getOrder(stores, id)).edits[0];

    assert.equal(before.date, "2026-10-17", "the day it was");
    assert.ok(before.site || before.occurrence, "the place it was");
    assert.ok(sent.some((m) => /Before:/.test(m.text || m.html || "")),
      "the email names the old place");
  });

  it("sends the customer nothing when withheld, and says so", async () => {
    const { stores, id } = await placed();
    const { square, calls } = fakeSquare();
    const { sent, mail } = outbox();

    withholdCustomerEmail();
    after(() => withholdCustomerEmail(false));

    const result = await farmEdit(stores, id, {
      fulfilment: { method: "market", site: "foster", date: "2026-10-25" },
    }, opts(square, mail));

    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const saved = await getOrder(stores, id);

    assert.equal(sent.length, 0);
    assert.ok(saved.history.some((h) => h.event.startsWith(
      "mail.suppressed.orderChanged-")));
    assert.equal(saved.emails[`orderChanged-${saved.edits[0].key}`]
      .suppressed, true);
    assert.ok(calls.some((c) => c[0] === "cancelFulfilment"));

    const later = await farmEdit(stores, id, {
      fulfilment: { date: "2026-10-18" },
    }, opts(square, mail));
    const final = await getOrder(stores, id);

    assert.equal(later.ok, true, JSON.stringify(later.errors));
    assert.equal(final.fulfilment.date, "2026-10-18");
    assert.equal(sent.length, 0);
    assert.equal(final.history.filter((h) => h.event.startsWith(
      "mail.suppressed.")).length, 2);
    withholdCustomerEmail(false);
  });

  it("still tells the farm of a customer's own change", async () => {
    const { stores, id } = await placed();
    const order = await getOrder(stores, id);
    const { sent, mail } = outbox();

    withholdCustomerEmail();
    after(() => withholdCustomerEmail(false));
    await notifyFarm(stores, order, "farmTest", { subject: "x", text: "x" },
      { mail, env, now });
    await sendForOrder(stores, order, "orderTest",
      { subject: "x", text: "x" }, { mail, env, now });
    withholdCustomerEmail(false);

    assert.deepEqual(sent.map((m) => m.to), [["farm@example.com"]]);
  });

  it("keeps the note of a send already made when one is withheld",
    async () => {
      const { stores, id } = await placed();
      const { mail } = outbox();
      const order = await getOrder(stores, id);

      await sendForOrder(stores, order, "orderTest",
        { subject: "x", text: "x" }, { mail, env, now });

      const first = (await getOrder(stores, id)).emails.orderTest;

      withholdCustomerEmail();
      try {
        await sendForOrder(stores, order, "orderTest",
          { subject: "x", text: "x" }, { mail, env, now });
      } finally {
        withholdCustomerEmail(false);
      }

      const saved = await getOrder(stores, id);

      assert.deepEqual(saved.emails.orderTest, first);
      assert.equal(saved.emails.orderTest.suppressed, undefined);
    });

  it("plans a quiet change without saving", async () => {
    const { stores, id } = await placed();
    const { square } = fakeSquare();
    const { sent, mail } = outbox();
    const result = await farmEdit(stores, id, {
      fulfilment: { method: "market", site: "foster", date: "2026-10-25" },
    }, opts(square, mail, { dryRun: true }));

    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.dryRun, true);
    assert.equal((await getOrder(stores, id)).fulfilment.method, "onfarm");
    assert.equal(sent.length, 0);
  });

  it("refuses a pickup the schedule hasn't opened", async () => {
    const payload = validateOrder({
      customer: { firstName: "A", lastName: "B", email: "a@b.co",
        contact: "text" },
      fulfilment: { method: "market", site: "foster", date: "2026-10-25" },
      lines: [],
    }, { index: new Map(), terms, now });

    assert.equal(payload.ok, false);
    assert.ok(payload.errors["fulfilment.occurrence"]);
  });

  describe("a market order the farm booked", () => {
    const booked = async () => {
      const { stores, id } = await placed();
      const { square } = fakeSquare();
      const { mail } = outbox();
      const r = await farmEdit(stores, id, {
        fulfilment: { method: "market", site: "foster", date: "2026-10-25" },
      }, opts(square, mail));

      assert.equal(r.ok, true, JSON.stringify(r.errors));

      return { stores, id, square };
    };

    it("lets the customer change a note", async () => {
      const { stores, id } = await booked();
      const r = await changeOrder(stores, customer, id,
        { notes: "Leave the eggs for last" },
        { now, env, mail: async () => ({}), square: {
          updateFulfilment: async () => ({}) } });

      assert.equal(r.ok, true, JSON.stringify(r.errors));

      const saved = await getOrder(stores, id);

      assert.equal(saved.fulfilment.method, "scheduled");
      assert.equal(saved.fulfilment.occurrence, "WAC5-261025");
      assert.equal(saved.notes, "Leave the eggs for last");
    });

    it("lets the customer lower a quantity", async () => {
      const { stores, id, square } = await booked();
      const r = await edit(stores, id, {
        idempotencyKey: editKey(), lines: [{ sku: SKU, qty: 1 }],
      }, square);

      assert.equal(r.ok, true, JSON.stringify(r.errors));

      const saved = await getOrder(stores, id);

      assert.equal(saved.lines[0].qty, 1);
      assert.equal(saved.fulfilment.occurrence, "WAC5-261025");
    });

    it("lets the customer move to another market day", async () => {
      const { stores, id, square } = await booked();
      // The schedule opens Foster on the 18th, inside the horizon.
      const r = await edit(stores, id, {
        idempotencyKey: editKey(), fulfilment: { occurrence: "WAC5-261018" },
      }, square, {
        now: instant("2026-10-12", 9, 0, "America/New_York"),
      });

      assert.equal(r.ok, true, JSON.stringify(r.errors));
      assert.equal((await getOrder(stores, id)).fulfilment.date,
        "2026-10-18");
    });

    it("does not let a customer book the site on another order",
      async () => {
        const { stores, id } = await placed();
        const { square } = fakeSquare();
        const r = await edit(stores, id, {
          idempotencyKey: editKey(),
          fulfilment: { method: "market", site: "foster",
            date: "2026-10-25" },
        }, square);

        assert.equal(r.ok, false);
        assert.ok(r.errors["fulfilment.occurrence"]);
      });

    it("offers the customer only the usual days", async () => {
      const { stores, id } = await booked();
      const order = await getOrder(stores, id);
      const other = { ...order, fulfilment: {
        ...order.fulfilment, occurrence: "WAC5-261018",
        date: "2026-10-18" } };
      const mine = planChange(other, { occurrence: "WAC5-261025" },
        { now, env });
      const farm = planChange(other, { occurrence: "WAC5-261025" },
        { now, env, by: "farm" });

      assert.equal(mine.errors.occurrence, "That pickup isn't available.");
      assert.equal(farm.errors, undefined);
    });
  });

  it("refuses a delivery moved to a market: the fee is money back",
    async () => {
      const { stores, id } = await placed();
      const { square } = fakeSquare();
      const { sent, mail } = outbox();

      await edit(stores, id, {
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

      const r = await farmEdit(stores, id, {
        fulfilment: { method: "market", site: "foster",
          date: "2026-10-25" },
      }, opts(square, mail));

      assert.equal(r.ok, false);
      assert.match(r.errors.payment, /takes \$\d+ off the order/);
      assert.equal((await getOrder(stores, id)).fulfilment.method,
        "delivery");
      assert.equal(sent.length, 0);
    });

  it("refuses with the customer's messages", async () => {
    const { stores, id } = await placed();
    const { square } = fakeSquare();
    const { sent, mail } = outbox();
    const late = await farmEdit(stores, id, { fulfilment: {
      date: "2026-12-31" } }, opts(square, mail));
    const drop = await farmEdit(stores, id, { fulfilment: {
      method: "scituate", date: "2026-10-14" } }, opts(square, mail));

    assert.equal(late.ok, false);
    assert.equal(late.errors.date, "That date isn't available.");
    assert.equal(drop.ok, false);
    assert.equal(drop.errors["fulfilment.occurrence"],
      "That pickup is no longer available.");
    assert.equal((await getOrder(stores, id)).fulfilment.method, "onfarm");
    assert.equal(sent.length, 0);
  });

  it("refuses a change that moves money", async () => {
    const { stores, id } = await placed();
    const { square, calls } = fakeSquare();
    const { sent, mail } = outbox();
    const result = await farmEdit(stores, id, {
      fulfilment: {
        method: "delivery", date: "2026-10-08",
        delivery: {
          address1: "1 Main St", town: "Foster", zip: "02825",
          cooler: "Porch",
        },
      },
    }, opts(square, mail));

    assert.equal(result.ok, false);
    assert.match(result.errors.payment, /only the customer can pay/);
    assert.equal((await getOrder(stores, id)).fulfilment.method, "onfarm");
    assert.deepEqual(calls, []);
    assert.equal(sent.length, 0);
  });

  it("changes a delivery address, and says its key", async () => {
    const { stores, id } = await placed();
    const { square } = fakeSquare();
    const { sent, mail } = outbox();
    const keys = [];
    const home = {
      method: "delivery", date: "2026-10-08",
      delivery: {
        address1: "1 Main St", town: "Foster", zip: "02825", cooler: "Porch",
      },
    };

    await edit(stores, id, {
      idempotencyKey: editKey(), fulfilment: home,
      payment: { method: "card", sourceId: "cnon:tok" },
    }, square);

    const result = await farmEdit(stores, id, {
      fulfilment: { delivery: { address1: "2 Oak Rd" } },
    }, opts(square, mail, { onKey: (k) => keys.push(k) }));

    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const saved = await getOrder(stores, id);

    assert.equal(saved.fulfilment.delivery.address1, "2 Oak Rd");
    assert.equal(saved.fulfilment.delivery.town, "Foster");
    assert.equal(saved.edits.at(-1).by, "farm");
    assert.deepEqual(keys, [result.key]);
    assert.equal(result.outOfSync, false);
    assert.equal(sent.at(-1).subject, "Your order is updated");

    // The same key again applies nothing new.
    const again = await farmEdit(stores, id, {
      fulfilment: { delivery: { address1: "3 Elm St" } },
    }, opts(square, mail, { key: result.key }));

    assert.equal(again.ok, true, JSON.stringify(again.errors));
    assert.equal((await getOrder(stores, id)).fulfilment.delivery.address1,
      "2 Oak Rd");
  });

  it("finishes a pending edit by its key, and answers a done one", async () => {
    const { stores, id } = await placed();
    const { square } = fakeSquare();
    const { mail } = outbox();
    const home = {
      method: "delivery", date: "2026-10-08",
      delivery: {
        address1: "1 Main St", town: "Foster", zip: "02825", cooler: "Porch",
      },
    };

    await edit(stores, id, {
      idempotencyKey: editKey(), fulfilment: home,
      payment: { method: "card", sourceId: "cnon:tok" },
    }, square);

    const body = { fulfilment: { delivery: { address1: "2 Oak Rd" } } };
    const key = "farm-pending-key-0001";
    const first = await farmEdit(stores, id, body,
      opts(square, mail, { key }));

    assert.equal(first.ok, true, JSON.stringify(first.errors));

    // A crash after the record was saved, before it was finished.
    const saved = await getOrder(stores, id);

    await amendOrder(stores, id, { edits: saved.edits.map((e) => e.key === key
      ? { ...e, state: "pending" } : e) }, "test.crash", now);

    const again = await farmEdit(stores, id, body,
      opts(square, mail, { key }));

    assert.equal(again.ok, true, JSON.stringify(again.errors));
    assert.equal(again.order.edits.find((e) => e.key === key).state, "done");

    const third = await farmEdit(stores, id, body,
      opts(square, mail, { key }));

    assert.equal(third.ok, true, JSON.stringify(third.errors));
    assert.equal((await getOrder(stores, id)).edits
      .filter((e) => e.key === key).length, 1);
  });

  it("changes the phone alone, and refuses a bad one", async () => {
    const { stores, id } = await placed();
    const { square, calls } = fakeSquare();
    const { sent, mail } = outbox();
    const bad = await farmEdit(stores, id, {
      customer: { phone: "nope" },
    }, opts(square, mail));
    const result = await farmEdit(stores, id, {
      customer: { phone: "401-555-0199", contact: "text" },
    }, opts(square, mail));

    assert.equal(bad.ok, false);
    assert.equal(bad.errors["customer.phone"],
      "That phone number doesn't look right.");
    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const saved = await getOrder(stores, id);

    assert.equal(saved.customer.phone, "401-555-0199");
    assert.equal(saved.customer.contact, "text");
    assert.equal(saved.customer.email, "pat@example.com");
    assert.ok(saved.history.some((h) => h.event === "farm.changed"));
    assert.equal(calls.filter((c) => c[0] !== "updateFulfilment").length, 0);
    assert.equal(sent.length, 1);
  });

  it("refuses notes beside a method change", async () => {
    const { stores, id } = await placed();
    const { square } = fakeSquare();
    const result = await farmEdit(stores, id, {
      fulfilment: { method: "scituate", date: "2026-10-17" }, notes: "Hi",
    }, opts(square, async () => ({})));

    assert.equal(result.ok, false);
    assert.match(result.errors.notes, /command of their own/);
  });

  it("says Square is out of sync when its change set the flag",
    async () => {
      const { stores, id } = await placed();
      const { square } = fakeSquare();

      square.updateFulfilment = async () => {
        throw new SquareError("down");
      };

      const result = await farmEdit(stores, id, {
        fulfilment: { date: "2026-10-08" },
      }, opts(square, async () => ({})));

      assert.equal(result.outOfSync, true);
    });

  it("keeps the prices the order was placed at", async () => {
    const { stores, id } = await placed();
    const { square } = fakeSquare();
    const was = await getOrder(stores, id);
    const bump = 2;
    const lines = was.lines.map((l, i) => (i ? l : {
      ...l, unitPrice: l.unitPrice + bump,
      lineTotal: l.lineTotal + bump * l.qty,
    }));
    const totals = { ...was.totals,
      subtotal: was.totals.subtotal + bump * 100 * was.lines[0].qty,
      total: was.totals.total + bump * 100 * was.lines[0].qty };
    const payments = [{ ...paymentsOf(was)[0],
      amount: totals.total }];

    // As if the catalog had since come down by the bump.
    await amendOrder(stores, id, { lines, totals, payments }, "test", now);

    const result = await farmEdit(stores, id, {
      fulfilment: { method: "scituate", date: "2026-10-17" },
    }, opts(square, async () => ({})));

    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal((await getOrder(stores, id)).totals.total, totals.total);
  });

  it("saves and sends nothing on a dry run", async () => {
    const { stores, id } = await placed();
    const { square, calls } = fakeSquare();
    const { sent, mail } = outbox();
    const before = await getOrder(stores, id);
    const move = await farmEdit(stores, id, {
      fulfilment: { method: "scituate", date: "2026-10-17" },
    }, opts(square, mail, { dryRun: true }));
    const quick = await farmEdit(stores, id, {
      fulfilment: { date: "2026-10-08" },
    }, opts(square, mail, { dryRun: true }));

    assert.equal(move.ok, true, JSON.stringify(move.errors));
    assert.equal(move.dryRun, true);
    assert.equal(move.order.fulfilment.method, "scheduled");
    assert.equal(move.email.subject, "Your order is updated");
    assert.equal(quick.order.fulfilment.date, "2026-10-08");
    assert.deepEqual(await getOrder(stores, id), before);
    assert.deepEqual(calls, []);
    assert.equal(sent.length, 0);
  });

  it("flags Square out of sync and goes on when Square fails",
    async () => {
      const { stores, id } = await placed();
      const { square } = fakeSquare();
      const { sent, mail } = outbox();

      square.updateFulfilment = async () => {
        throw new SquareError("down");
      };

      const result = await farmEdit(stores, id, {
        fulfilment: { date: "2026-10-08" },
      }, opts(square, mail));

      assert.equal(result.ok, true);
      assert.equal((await getOrder(stores, id)).flags.squareOutOfSync, true);
      assert.ok(sent.some((m) => m.subject === "Your order is updated"));
    });

  it("refuses an order that is not paid", async () => {
    const { stores, id } = await placed();

    await amendOrder(stores, id, { status: "cancelled" }, "test", now);

    const result = await farmEdit(stores, id, { fulfilment: {
      date: "2026-10-08" } }, opts(fakeSquare().square, async () => ({})));

    assert.equal(result.status, 409);
  });
});
