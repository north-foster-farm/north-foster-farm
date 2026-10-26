// Spending a member's credit (#471): it comes off after every
// discount and fee, only when signed in; the money due is charged as
// usual, or nothing is when the credit covers the order; the record
// carries the credit tender after the money, so a refund returns the
// credit first; Square carries it as its own discount.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import terms from "../data/delivery.json" with { type: "json" };
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { computeTotals } from "../assets/scripts/order/lib/totals.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { handle as placeOrder } from "../netlify/functions/orders.mjs";
import { refundOrder } from "../netlify/functions/lib/admin.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import { METHODS } from "../netlify/functions/lib/checkout.mjs";
import {
  creditBalance, getLedger, grantCredit, heldBy, spendCredit,
} from "../netlify/functions/lib/credit.mjs";
import { joinGroup, setGroupCode } from "../netlify/functions/lib/groups.mjs";
import { creditPaid } from "../netlify/functions/lib/rounds.mjs";
import {
  getOrder, openOrders, paymentsOf, refundedTotal,
} from "../netlify/functions/lib/records.mjs";
import {
  buildOrder, settings,
} from "../netlify/functions/lib/square.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

const ny = (iso, h = 9, m = 0) => instant(iso, h, m, "America/New_York");
const now = ny("2026-11-02");
const index = indexCatalog(catalog);
const { money } = terms;
const SKU = "NFF-CHK-WHL-35-39";
const EMAIL = "pat@example.com";
const env = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  URL: "https://x",
  PICKUP_SCHEDULE: SCHEDULE,
};
const from = { group: "vff", round: "2026-10-25", kind: "host" };

describe("credit in the totals", () => {
  const at = (credit, extra = {}) => computeTotals({
    lines: [{ sku: SKU, qty: 2 }], method: "onfarm", index, money, credit,
    ...extra,
  });

  it("comes off after the discounts and the fee, as far as it goes", () => {
    // $60 less the $5 tier: $55 due.
    assert.equal(at(0).total, 5500);
    assert.equal(at(0).credit, undefined);
    assert.equal(at(2000).total, 3500);
    assert.equal(at(2000).credit, 2000);
    assert.equal(at(2000).discountAmount, 500);
    // More credit than the order: the order's worth, no more.
    assert.equal(at(9000).total, 0);
    assert.equal(at(9000).credit, 5500);
    // On a delivery the credit covers the items, never the fee (fakes
    // audit, 6426321360, C1): Square applies the credit discount to
    // the items alone, so the fee is always money.
    const delivered = at(10_000, { method: "delivery",
      zipStatus: "approved" });

    assert.equal(delivered.deliveryFee, 500);
    assert.equal(delivered.credit, 5500);
    assert.equal(delivered.total, 500);
    // Never negative, never a fraction.
    assert.equal(at(-500).credit, undefined);
    assert.equal(at(1250.7).credit, 1250);
  });
});

describe("spending credit on an order", () => {
  const fakeSquare = () => {
    const calls = [];
    const square = {
      createOrder: async (order, key) => {
        calls.push(["order", key, order.totals.total, order.totals.credit]);

        return { squareOrderId: "SQO", customerId: "CUST" };
      },
      createPayment: async (args) => {
        calls.push(["payment", args.amount || args.order.totals.total]);

        return {
          squarePaymentId: "PAY", status: "COMPLETED", receiptUrl: null,
          brand: "VISA", last4: "4242", wallet: null,
        };
      },
      payZeroOrder: async (id, key) => {
        calls.push(["zero", id, key]);

        return { squareOrderId: id };
      },
      refundPayment: async ({ amount }) => {
        calls.push(["refund", amount]);

        return { squareRefundId: "REF", status: "COMPLETED" };
      },
      findPaid: async () => null,
    };

    return { square, calls };
  };
  const body = (overrides = {}) => ({
    idempotencyKey: "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
    customer: {
      firstName: "Pat", lastName: "Example", email: EMAIL,
      phone: "401-555-0100", contact: "call",
    },
    lines: [{ sku: SKU, qty: 2 }],
    fulfilment: { method: "scheduled", occurrence: "36TS-261108" },
    claimedTotal: 5500,
    payment: { method: "card", sourceId: "cnon:tok" },
    ...overrides,
  });
  const member = async (credit) => {
    const stores = testStores();

    await setGroupCode(stores, "vff", { code: "GYM-2026", now });

    const session = await createSession(stores, EMAIL, { now });

    await joinGroup(stores, EMAIL, "vff", { now });
    if (credit) {
      await grantCredit(stores, EMAIL, { amount: credit, from, now,
        timeZone: terms.timeZone });
    }

    return { stores, cookie: { cookie: `nff_session=${session.id}` } };
  };
  const send = (stores, square, payload, headers = {}) => placeOrder(
    new Request("http://x/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    }),
    { stores, square, now, env, mail: async () => ({}),
      sleep: async () => {} }
  );

  it("is a payment method only for a covered order", () => {
    assert.equal(METHODS.credit.via, "credit");
  });

  it("covers part: the rest is charged, the tender recorded after",
    async () => {
      const { stores, cookie } = await member(2000);
      const { square, calls } = fakeSquare();
      const res = await send(stores, square, body({ claimedTotal: 3500 }),
        cookie);
      const data = await res.json();

      assert.equal(res.status, 200, JSON.stringify(data));
      assert.equal(data.totals.credit, 2000);
      assert.equal(data.totals.total, 3500);
      // Square's order carries the credit, and the charge is the rest.
      assert.deepEqual(calls[0], ["order", calls[0][1], 3500, 2000]);
      assert.deepEqual(calls[1], ["payment", 3500]);

      const order = await getOrder(stores, data.orderId);
      const payments = paymentsOf(order);

      assert.deepEqual(payments.map((p) => [p.via, p.amount]),
        [["square", 3500], ["credit", 2000]]);
      assert.equal(creditPaid(order), 2000);
      assert.equal(await creditBalance(stores, EMAIL, now), 0);

      // A refund returns the credit first, then the money.
      const refunded = await refundOrder(stores, data.orderId, {
        now, env, amount: 2500, square,
      });

      assert.equal(refundedTotal(refunded), 2500);
      assert.deepEqual(refunded.refunds.map((r) => [r.via || "square",
        r.amount]), [["credit", 2000], ["square", 500]]);
      assert.equal(await creditBalance(stores, EMAIL, now), 2000);
      assert.equal(creditPaid(refunded), 0);
      assert.ok(calls.some((c) => c[0] === "refund" && c[1] === 500));
    });

  it("covers all: nothing is charged, Square's order is paid as zero",
    async () => {
      const { stores, cookie } = await member(10_000);
      const { square, calls } = fakeSquare();
      const res = await send(stores, square, body({
        claimedTotal: 0, payment: { method: "credit" },
      }), cookie);
      const data = await res.json();

      assert.equal(res.status, 200, JSON.stringify(data));
      assert.equal(data.totals.credit, 5500);
      assert.equal(data.totals.total, 0);
      assert.equal(data.payment.via, "credit");
      assert.deepEqual(calls.map((c) => c[0]), ["order", "zero"]);

      const order = await getOrder(stores, data.orderId);

      assert.deepEqual(paymentsOf(order).map((p) => [p.via, p.amount]),
        [["credit", 5500]]);
      assert.equal(await creditBalance(stores, EMAIL, now), 4500);

      const ledger = await getLedger(stores, EMAIL);

      assert.deepEqual(ledger.entries[0].spent.map((s) => [s.orderId,
        s.amount]), [[data.orderId, 5500]]);
    });

  it("never pays an order with money due, and never spends signed out",
    async () => {
      const { stores, cookie } = await member(2000);
      const { square } = fakeSquare();
      // Credit alone on a $35 balance: refused, nothing charged.
      const short = await send(stores, square, body({
        claimedTotal: 3500, payment: { method: "credit" },
      }), cookie);

      assert.equal(short.status, 422);
      assert.deepEqual((await short.json()).errors,
        { payment: "Choose how to pay." });
      assert.equal(await creditBalance(stores, EMAIL, now), 2000);

      // The code without the account: the member's prices and pickup,
      // not their credit.
      const guest = await send(stores, square, body({
        groupCode: "GYM-2026",
      }));
      const data = await guest.json();

      assert.equal(guest.status, 200, JSON.stringify(data));
      assert.equal(data.totals.credit, undefined);
      assert.equal(data.totals.total, 5500);
      assert.equal(await creditBalance(stores, EMAIL, now), 2000);
    });
});

describe("credit in Square's order", () => {
  it("is a discount of its own beside the others", () => {
    const cfg = settings({
      SQUARE_ACCESS_TOKEN: "tok", SQUARE_LOCATION_ID: "LOC",
      SQUARE_ENV: "sandbox",
    });
    const order = {
      id: "NFF-2611-CRED", customer: { name: "Pat Example", email: EMAIL,
        phone: "", contact: "text" },
      fulfilment: { method: "onfarm", date: "2026-11-03",
        onfarm: { window: "09:00-12:00", from: "09:00", to: "12:00" },
        delivery: null },
      lines: [{ sku: SKU, label: "Whole", name: "Whole", unitPrice: 30,
        qty: 2, lineTotal: 60, squareVariationId: null }],
      totals: { subtotal: 6000, discountTier: 50, discountAmount: 500,
        discountLabel: "Bulk discount ($50+)", deliveryFee: 0,
        credit: 2000, total: 3500 },
      notes: "", source: "",
      flags: { zipUnlisted: false, totalMismatch: false },
    };
    const built = buildOrder(order, "CUST", cfg);

    assert.deepEqual(built.discounts.map((d) => [d.name,
      d.amount_money.amount, d.scope]), [
      ["Bulk discount ($50+)", 500, "ORDER"], ["Group credit", 2000, "ORDER"],
    ]);
  });
});

// The security review's change 1 (6425904452): the credit spent is
// the signed-in account's, spent before any money moves, once, and
// given back when the payment certainly took none.
describe("whose credit, and when", () => {
  const OTHER = "other@example.com";
  const fakeSquare = ({ decline = false } = {}) => {
    const calls = [];
    const square = {
      createOrder: async (order, key) => {
        calls.push(["order", key]);

        return { squareOrderId: "SQO", customerId: "CUST" };
      },
      createPayment: async (args) => {
        calls.push(["payment", args.amount || args.order.totals.total]);
        if (decline) {
          const error = new Error("Declined");

          error.declined = true;
          error.code = "CARD_DECLINED";
          throw error;
        }

        return {
          squarePaymentId: "PAY", status: "COMPLETED", receiptUrl: null,
          brand: "VISA", last4: "4242", wallet: null,
        };
      },
      payZeroOrder: async (id) => {
        calls.push(["zero", id]);

        return { squareOrderId: id };
      },
      cancelOrder: async (id) => ({ id, cancelled: true }),
      findPaid: async () => null,
    };

    return { square, calls };
  };
  const body = (overrides = {}) => ({
    idempotencyKey: "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
    customer: {
      firstName: "Pat", lastName: "Example", email: EMAIL,
      phone: "401-555-0100", contact: "call",
    },
    lines: [{ sku: SKU, qty: 2 }],
    fulfilment: { method: "scheduled", occurrence: "36TS-261108" },
    claimedTotal: 3500,
    payment: { method: "card", sourceId: "cnon:tok" },
    ...overrides,
  });
  const member = async (credit, email = EMAIL) => {
    const stores = testStores();

    await setGroupCode(stores, "vff", { code: "GYM-2026", now });

    const session = await createSession(stores, email, { now });

    await joinGroup(stores, email, "vff", { now });
    if (credit) {
      await grantCredit(stores, email, { amount: credit, from, now,
        timeZone: terms.timeZone });
    }

    return { stores, cookie: { cookie: `nff_session=${session.id}` } };
  };
  const send = (stores, square, payload, headers = {}) => placeOrder(
    new Request("http://x/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    }),
    { stores, square, now, env, mail: async () => ({}),
      sleep: async () => {} }
  );

  it("spends the signed-in account's, never the typed address's",
    async () => {
      // Member A signs in and types member B's email address.
      const { stores, cookie } = await member(2000);
      const { square } = fakeSquare();

      await joinGroup(stores, OTHER, "vff", { now });
      await grantCredit(stores, OTHER, { amount: 9000, from, now,
        timeZone: terms.timeZone });

      const res = await send(stores, square, body({
        customer: { firstName: "Oth", lastName: "Er", email: OTHER,
          phone: "401-555-0100", contact: "call" },
      }), cookie);
      const data = await res.json();

      assert.equal(res.status, 200, JSON.stringify(data));
      assert.equal(data.totals.credit, 2000);

      const order = await getOrder(stores, data.orderId);

      assert.equal(order.creditFrom, EMAIL);
      assert.equal(order.customer.email, OTHER);
      assert.equal(await creditBalance(stores, EMAIL, now), 0);
      assert.equal(await creditBalance(stores, OTHER, now), 9000);

      // A refund goes back to A, whose credit it was.
      await refundOrder(stores, data.orderId, { now, env, amount: 2000,
        square });
      assert.equal(await creditBalance(stores, EMAIL, now), 2000);
      assert.equal(await creditBalance(stores, OTHER, now), 9000);
    });

  it("runs out: a second covered order is refused, nothing charged",
    async () => {
      const { stores, cookie } = await member(5500);
      const { square, calls } = fakeSquare();
      const first = await send(stores, square, body({
        claimedTotal: 0, payment: { method: "credit" },
      }), cookie);

      assert.equal(first.status, 200);
      assert.equal(await creditBalance(stores, EMAIL, now), 0);

      // The page still believes in the balance it saw.
      const second = await send(stores, square, body({
        idempotencyKey: "1f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
        claimedTotal: 0, payment: { method: "credit" },
      }), cookie);
      const data = await second.json();

      assert.equal(second.status, 422);
      assert.match(data.errors.total, /total changed/);
      assert.equal(data.totals.credit, undefined);
      assert.equal(data.totals.total, 5500);
      assert.deepEqual(calls.map((c) => c[0]), ["order", "zero"]);
    });

  it("spends a balance once across two checkouts at once", async () => {
    const { stores, cookie } = await member(2000);
    const { square, calls } = fakeSquare();
    // Both pages read $20 of credit before either paid.
    const [a, b] = await Promise.all([
      send(stores, square, body(), cookie),
      send(stores, square, body({
        idempotencyKey: "2f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
      }), cookie),
    ]);
    const statuses = [a.status, b.status].sort();

    assert.deepEqual(statuses, [200, 422]);
    assert.equal(calls.filter((c) => c[0] === "payment").length, 1);
    assert.equal(await creditBalance(stores, EMAIL, now), 0);
  });

  it("gives the credit back on a declined card", async () => {
    const { stores, cookie } = await member(2000);
    const { square } = fakeSquare({ decline: true });
    const res = await send(stores, square, body(), cookie);

    assert.equal(res.status, 402);
    assert.equal(await creditBalance(stores, EMAIL, now), 2000);

    // And spends it again on the next try.
    const again = await send(stores, square, body({
      idempotencyKey: "3f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
    }), cookie);

    assert.equal(again.status, 402);
    assert.equal(await creditBalance(stores, EMAIL, now), 2000);

    const ok = fakeSquare();
    const paid = await send(stores, ok.square, body({
      idempotencyKey: "4f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
    }), cookie);

    assert.equal(paid.status, 200);
    assert.equal(await creditBalance(stores, EMAIL, now), 0);
  });
});

// The fakes audit's C1 (6426321360): Square applies the credit
// discount to the items alone, so credit never covers the delivery
// fee, and a zero-pay Square refuses fails the order.
describe("credit and the delivery fee", () => {
  const cfg = settings({
    SQUARE_ACCESS_TOKEN: "tok", SQUARE_LOCATION_ID: "LOC",
    SQUARE_ENV: "sandbox",
  });
  const fakeSquare = ({ zeroFails = false } = {}) => {
    const calls = [];
    const square = {
      createOrder: async (order, key) => {
        calls.push(["order", key, order.totals.total, order.totals.credit]);

        return { squareOrderId: "SQO", customerId: "CUST" };
      },
      createPayment: async (args) => {
        calls.push(["payment", args.amount || args.order.totals.total]);

        return {
          squarePaymentId: "PAY", status: "COMPLETED", receiptUrl: null,
          brand: "VISA", last4: "4242", wallet: null,
        };
      },
      payZeroOrder: async (id) => {
        calls.push(["zero", id]);
        if (zeroFails) {
          const error = new Error("Square 400 on /v2/orders/SQO/pay");

          error.retryable = false;
          error.detail = [{ code: "BAD_REQUEST" }];
          throw error;
        }

        return { squareOrderId: id };
      },
      cancelOrder: async (id) => {
        calls.push(["cancel", id]);

        return { id, cancelled: true };
      },
      findPaid: async () => null,
    };

    return { square, calls };
  };
  const delivery = (overrides = {}) => ({
    idempotencyKey: "5f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
    customer: {
      firstName: "Pat", lastName: "Example", email: EMAIL,
      phone: "401-555-0100", contact: "call",
    },
    lines: [{ sku: SKU, qty: 2 }],
    fulfilment: {
      method: "delivery", date: "2026-11-05",
      delivery: { address1: "1 Main St", town: "Foster", zip: "02825",
        cooler: "Porch" },
    },
    claimedTotal: 500,
    payment: { method: "card", sourceId: "cnon:tok" },
    ...overrides,
  });
  const member = async (credit) => {
    const stores = testStores();

    await setGroupCode(stores, "vff", { code: "GYM-2026", now });

    const session = await createSession(stores, EMAIL, { now });

    await joinGroup(stores, EMAIL, "vff", { now });
    await grantCredit(stores, EMAIL, { amount: credit, from, now,
      timeZone: terms.timeZone });

    return { stores, cookie: { cookie: `nff_session=${session.id}` } };
  };
  const send = (stores, square, payload, headers = {}) => placeOrder(
    new Request("http://x/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    }),
    { stores, square, now, env, mail: async () => ({}),
      sleep: async () => {} }
  );

  it("keeps Square's credit discount within the items' net", () => {
    const lines = [{ sku: SKU, label: "Whole", name: "Whole", unitPrice: 30,
      qty: 2, lineTotal: 60, squareVariationId: null }];
    const built = (totals) => buildOrder({
      id: "NFF-2611-FEE1",
      customer: { name: "Pat Example", email: EMAIL, phone: "", contact: "" },
      fulfilment: { method: "delivery", date: "2026-11-05", onfarm: null,
        delivery: { address1: "1 Main St", town: "Foster", zip: "02825",
          cooler: "Porch" } },
      lines, totals, notes: "", source: "",
      flags: { zipUnlisted: false, totalMismatch: false },
    }, "CUST", cfg);
    // $60 of items, the $5 tier, the $5 fee: credit of $100 covers the
    // items' net, $55, and the fee is the money due.
    const t = computeTotals({
      lines: [{ sku: SKU, qty: 2 }], method: "delivery", index, money,
      zipStatus: "approved", credit: 10_000,
    });
    const o = built(t);
    const itemsNet = lines.reduce((s, l) => s + l.lineTotal * 100, 0)
      - t.discountAmount;
    const creditLine = o.discounts.find((d) => d.name === "Group credit");

    assert.equal(t.credit, 5500);
    assert.equal(t.total, 500);
    assert.ok(creditLine.amount_money.amount <= itemsNet);
    assert.equal(creditLine.amount_money.amount, 5500);
    assert.deepEqual(o.service_charges.map((c) => [c.name,
      c.amount_money.amount]), [["Delivery fee", 500]]);
    // Square's total: items less every discount, plus the fee.
    const discounts = o.discounts.reduce((s, d) => s + d.amount_money.amount,
      0);

    assert.equal(6000 - discounts + 500, t.total);
  });

  it("charges the fee by card on a delivery the credit covers", async () => {
    const { stores, cookie } = await member(10_000);
    const { square, calls } = fakeSquare();
    const res = await send(stores, square, delivery(), cookie);
    const data = await res.json();

    assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.totals.credit, 5500);
    assert.equal(data.totals.total, 500);
    assert.deepEqual(calls.map((c) => c[0]), ["order", "payment"]);
    assert.deepEqual(calls[1], ["payment", 500]);
    assert.equal(await creditBalance(stores, EMAIL, now), 4500);
  });

  it("fails the order, with nothing recorded, when the zero-pay fails",
    async () => {
      const { stores, cookie } = await member(10_000);
      const { square, calls } = fakeSquare({ zeroFails: true });
      const res = await send(stores, square, delivery({
        fulfilment: { method: "scheduled", occurrence: "36TS-261108" },
        claimedTotal: 0, payment: { method: "credit" },
      }), cookie);

      assert.equal(res.status, 502);
      assert.deepEqual(calls.map((c) => c[0]), ["order", "zero", "cancel"]);
      assert.deepEqual(await openOrders(stores), []);
      // A failure that will not be retried gives the credit back.
      assert.equal(await creditBalance(stores, EMAIL, now), 10_000);
    });
});

// The security re-re-review's change 1 (6427102482): a retry of a
// submission whose first try timed out holds credit against the id
// it reserved; that hold counts as available, and the order ends
// with exactly that credit, on the record and on the ledger.
describe("credit on a retried checkout", () => {
  // Square times out on every payment while `failing`, however often
  // one request retries it; the test heals it between requests.
  const fakeSquare = ({ failing = false } = {}) => {
    const calls = [];
    const state = { failing };
    const square = {
      createOrder: async (order, key) => {
        calls.push(["order", key, order.totals.total, order.totals.credit]);

        return { squareOrderId: "SQO", customerId: "CUST" };
      },
      createPayment: async (args) => {
        if (state.failing) {
          calls.push(["timeout"]);

          const error = new Error("/v2/payments did not finish answering");

          error.retryable = true;
          error.code = "timeout";
          throw error;
        }
        calls.push(["payment", args.amount || args.order.totals.total]);

        return {
          squarePaymentId: "PAY", status: "COMPLETED", receiptUrl: null,
          brand: "VISA", last4: "4242", wallet: null,
        };
      },
      cancelOrder: async (id) => ({ id, cancelled: true }),
      findPaid: async () => null,
    };

    return { square, calls, state };
  };
  const body = (overrides = {}) => ({
    idempotencyKey: "6f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
    attempt: 1,
    customer: {
      firstName: "Pat", lastName: "Example", email: EMAIL,
      phone: "401-555-0100", contact: "call",
    },
    lines: [{ sku: SKU, qty: 2 }],
    fulfilment: { method: "scheduled", occurrence: "36TS-261108" },
    claimedTotal: 3500,
    payment: { method: "card", sourceId: "cnon:tok" },
    ...overrides,
  });
  const member = async (credit) => {
    const stores = testStores();

    await setGroupCode(stores, "vff", { code: "GYM-2026", now });

    const session = await createSession(stores, EMAIL, { now });

    await joinGroup(stores, EMAIL, "vff", { now });
    await grantCredit(stores, EMAIL, { amount: credit, from, now,
      timeZone: terms.timeZone });

    return { stores, cookie: { cookie: `nff_session=${session.id}` } };
  };
  const send = (stores, square, payload, headers = {}) => placeOrder(
    new Request("http://x/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    }),
    { stores, square, now, env, mail: async () => ({}),
      sleep: async () => {} }
  );

  it("keeps its hold through a timeout and pays with it", async () => {
    const { stores, cookie } = await member(2000);
    const { square, calls, state } = fakeSquare({ failing: true });
    const first = await send(stores, square, body(), cookie);

    assert.equal(first.status, 503);
    assert.equal((await first.json()).retryable, true);
    // The spend stands for the retry.
    assert.equal(await creditBalance(stores, EMAIL, now), 0);

    state.failing = false;

    const again = await send(stores, square, body({ attempt: 2 }), cookie);
    const data = await again.json();

    assert.equal(again.status, 200, JSON.stringify(data));
    assert.equal(data.totals.credit, 2000);
    assert.equal(data.totals.total, 3500);
    assert.deepEqual(calls.filter((c) => c[0] === "payment"),
      [["payment", 3500]]);

    const order = await getOrder(stores, data.orderId);
    const ledger = await getLedger(stores, EMAIL);

    assert.equal(order.creditFrom, EMAIL);
    assert.deepEqual(paymentsOf(order).map((p) => [p.via, p.amount]),
      [["square", 3500], ["credit", 2000]]);
    assert.equal(heldBy(ledger, data.orderId), 2000);
    assert.equal(await creditBalance(stores, EMAIL, now), 0);
  });

  it("brings a hold up or down to the order's credit, once", async () => {
    const stores = testStores();
    const t = ny("2026-11-23");

    await grantCredit(stores, "m@x.com", { amount: 3_000, from, now: t,
      timeZone: terms.timeZone });
    await spendCredit(stores, "m@x.com", { orderId: "O1", amount: 1_000,
      now: t });
    assert.equal(heldBy(await getLedger(stores, "m@x.com"), "O1"), 1_000);
    // More: the difference is spent.
    await spendCredit(stores, "m@x.com", { orderId: "O1", amount: 2_500,
      now: t });
    assert.equal(heldBy(await getLedger(stores, "m@x.com"), "O1"), 2_500);
    assert.equal(await creditBalance(stores, "m@x.com", t), 500);
    // Less: the difference goes back.
    await spendCredit(stores, "m@x.com", { orderId: "O1", amount: 800,
      now: t });
    assert.equal(heldBy(await getLedger(stores, "m@x.com"), "O1"), 800);
    assert.equal(await creditBalance(stores, "m@x.com", t), 2_200);
    // The same: nothing.
    const same = await spendCredit(stores, "m@x.com", { orderId: "O1",
      amount: 800, now: t });

    assert.equal(heldBy(same, "O1"), 800);
    // Short of the difference: refused, the hold as it was.
    await assert.rejects(spendCredit(stores, "m@x.com", { orderId: "O1",
      amount: 3_500, now: t }), /less credit than 2700/);
    assert.equal(heldBy(await getLedger(stores, "m@x.com"), "O1"), 800);
  });
});
