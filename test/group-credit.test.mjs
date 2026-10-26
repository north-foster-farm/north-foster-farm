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
  creditBalance, getLedger, grantCredit,
} from "../netlify/functions/lib/credit.mjs";
import { joinGroup, setGroupCode } from "../netlify/functions/lib/groups.mjs";
import { creditPaid } from "../netlify/functions/lib/rounds.mjs";
import {
  getOrder, paymentsOf, refundedTotal,
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
    // On a delivery, the fee is in before the credit comes off.
    const delivered = at(10_000, { method: "delivery",
      zipStatus: "approved" });

    assert.equal(delivered.deliveryFee, 500);
    assert.equal(delivered.credit, 6000);
    assert.equal(delivered.total, 0);
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
