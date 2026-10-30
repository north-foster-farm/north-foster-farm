// Friends and family and family pricing (#514): Square's Friends and
// Fam whole-dollar amounts per item, the larger of it, the bulk tier,
// a code or the member price, never stacked; family is 100% off with
// nothing charged; free delivery goes with either; totals stay whole
// dollars; Square records each as a real discount.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import terms from "../data/delivery.json" with { type: "json" };
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { computeTotals } from "../assets/scripts/order/lib/totals.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { handle } from "../netlify/functions/orders.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import { addPerk } from "../netlify/functions/lib/perks.mjs";
import { getOrder } from "../netlify/functions/lib/records.mjs";
import {
  FRIENDS_SQUARE_NAME, buildOrder, settings,
} from "../netlify/functions/lib/square.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { paymentPhrase } from "../netlify/functions/lib/templates.mjs";

const index = indexCatalog(catalog);
const money = terms.money;
const now = instant("2026-10-06", 9, 0, "America/New_York");
const KEY = "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918";
const PAT = "pat@example.com";
const cfg = settings({
  SQUARE_ACCESS_TOKEN: "tok", SQUARE_LOCATION_ID: "LOC", SQUARE_ENV: "sandbox",
});

const totals = (lines, perks, extra = {}) => computeTotals({
  lines, method: "delivery", index, money, zipStatus: "approved", perks,
  ...extra,
});

describe("the Friends and Fam amounts", () => {
  it("are whole dollars from $1 to $6, each under its item's price, for " +
    "items the catalog has", () => {
    const off = money.friendsAndFam.off;

    for (const [sku, dollars] of Object.entries(off)) {
      assert.ok(index.has(sku), `${sku} is in the catalog`);
      assert.ok(Number.isInteger(dollars) && dollars >= 1 && dollars <= 6,
        `${sku}: $${dollars}`);
      assert.ok(dollars < index.get(sku).price, `${sku} costs more`);
    }
    assert.equal(FRIENDS_SQUARE_NAME, "Friends and Fam");
  });
});

describe("computeTotals for friends and family", () => {
  it("takes each item's amount off, with free delivery", () => {
    // Two chickens at $30, $3 off each: $6 beats the $5 tier.
    const t = totals([{ sku: "NFF-CHK-WHL-35-39", qty: 2 }], ["friends"]);

    assert.equal(t.discountAmount, 600);
    assert.equal(t.discountPerk, "friends");
    assert.equal(t.discountLabel, "Friends and family");
    assert.equal(t.discountTier, null);
    assert.deepEqual(t.perkLines, [
      { sku: "NFF-CHK-WHL-35-39", off: 300, qty: 2, amount: 600 },
    ]);
    assert.equal(t.deliveryFee, 0);
    assert.equal(t.feeWaived, true);
    assert.equal(t.total, 5400);
  });

  it("gives the bulk tier when it is larger, never both", () => {
    // Nine breasts at $24, $2 off each: $18 against the $20 tier.
    const t = totals([{ sku: "NFF-CHK-BRSBL-15-16", qty: 9 }], ["friends"]);

    assert.equal(t.discountAmount, 2000);
    assert.equal(t.discountTier, 200);
    assert.equal(t.discountPerk, undefined);
    assert.equal(t.perkLines, undefined);
    // Free delivery still goes with it: it is not a discount.
    assert.equal(t.deliveryFee, 0);
    assert.equal(t.total, 19600);
  });

  it("gives a tie with the tier to Friends and Fam", () => {
    // Five chickens at $40, $4 off each: $20, as the $200 tier.
    const t = totals([{ sku: "NFF-CHK-WHL-45-49", qty: 5 }], ["friends"]);

    assert.equal(t.discountAmount, 2000);
    assert.equal(t.discountPerk, "friends");
  });

  it("gives the member price when it is larger", () => {
    const lock = { prices: { "NFF-CHK-WHL-35-39": 20 } };
    const t = totals([{ sku: "NFF-CHK-WHL-35-39", qty: 2 }], ["friends"],
      { lock });

    assert.equal(t.discountAmount, 2000);
    assert.equal(t.discountLock, true);
    assert.equal(t.discountPerk, undefined);
  });

  it("beats the 10% group when its amounts are larger", () => {
    // Three large eggs at $7: $1 off each is $3, the group's 10% $2.
    const t = totals([{ sku: "NFF-CHK-EGG-LG", qty: 3 }], ["friends"],
      { group: "friends" });

    assert.equal(t.discountAmount, 300);
    assert.equal(t.discountPerk, "friends");
    assert.equal(t.discountGroup, null);
    assert.equal(t.total, 1800);
  });

  it("gives the 10% group when it is larger, never both", () => {
    // Four breasts at $24: $2 off each is $8, the group's 10% of $96
    // $10, the tier $5.
    const t = totals([{ sku: "NFF-CHK-BRSBL-15-16", qty: 4 }], ["friends"],
      { group: "friends" });

    assert.equal(t.discountAmount, 1000);
    assert.equal(t.discountGroup, "friends");
    assert.equal(t.discountPerk, undefined);
    assert.equal(t.perkLines, undefined);
    assert.equal(t.deliveryFee, 0, "free delivery goes with it");
    assert.equal(t.total, 8600);
  });

  it("beats a smaller code", () => {
    // Two chickens at $30, $3 off each: $6 against a $5 code.
    const t = totals([{ sku: "NFF-CHK-WHL-35-39", qty: 2 }], ["friends"],
      { code: { code: "FIVE", off: 5 } });

    assert.equal(t.discountAmount, 600);
    assert.equal(t.discountPerk, "friends");
    assert.equal(t.discountCode, null);
    assert.equal(t.total, 5400);
  });

  it("gives a larger code, never both", () => {
    const t = totals([{ sku: "NFF-CHK-WHL-35-39", qty: 2 }], ["friends"],
      { code: { code: "TEN", off: 10 } });

    assert.equal(t.discountAmount, 1000);
    assert.equal(t.discountCode, "TEN");
    assert.equal(t.discountPerk, undefined);
    assert.equal(t.deliveryFee, 0, "free delivery goes with it");
    assert.equal(t.total, 5000);
  });

  it("gives nothing off an item with no amount", () => {
    const t = totals([{ sku: "NFF-CHK-EGG-SM", qty: 3 }], ["friends"]);

    assert.equal(t.discountAmount, 0);
    assert.equal(t.discountPerk, undefined);
  });

  it("keeps every total a whole dollar", () => {
    const perks = [["friends"], ["family"], ["friends", "free-delivery"]];

    for (const item of index.values()) {
      for (const qty of [1, 3, 7]) {
        for (const p of perks) {
          const t = totals([{ sku: item.sku, qty }], p);

          assert.equal(t.total % 100, 0, `${item.sku} x${qty} ${p}`);
          assert.equal(t.discountAmount % 100, 0);
        }
      }
    }
  });
});

describe("computeTotals for family", () => {
  it("is 100% off with no fee, whatever else applies", () => {
    const t = totals([{ sku: "NFF-CHK-WHL-35-39", qty: 7 }],
      ["family", "friends"], { code: { code: "X", off: 500 } });

    assert.equal(t.discountAmount, 21000);
    assert.equal(t.discountPerk, "family");
    assert.equal(t.discountLabel, "Family");
    assert.equal(t.discountCode, null);
    assert.equal(t.deliveryFee, 0);
    assert.equal(t.total, 0);
  });

  it("spends no credit on an order with nothing due", () => {
    const t = totals([{ sku: "NFF-CHK-WHL-35-39", qty: 1 }], ["family"],
      { credit: 1500 });

    assert.equal(t.total, 0);
    assert.equal(t.credit, undefined);
  });
});

const record = (t) => ({
  id: "NFF-2610-PERK01",
  customer: {
    name: "Pat Example", email: PAT, phone: "401-555-0100", contact: "text",
  },
  fulfilment: {
    method: "delivery", date: "2026-10-08", onfarm: null,
    delivery: {
      address1: "1 Main St", address2: "", town: "Foster", state: "RI",
      zip: "02825", cooler: "Porch", notes: "", zipStatus: "approved",
    },
  },
  lines: [{
    sku: "NFF-CHK-WHL-35-39", label: "3.5 – 3.9 lbs",
    name: "Whole Chicken, 3.5 – 3.9 lbs", unitPrice: 30, qty: 2,
    lineTotal: 60, squareVariationId: null,
  }],
  totals: t,
  notes: "",
  flags: {},
});

/* eslint-disable camelcase -- Square names order fields its way */

describe("buildOrder for a perk's discount", () => {
  it("records Friends and Fam per item, under Square's own name, and the " +
    "fee at $0", () => {
    const t = totals([{ sku: "NFF-CHK-WHL-35-39", qty: 2 }], ["friends"]);
    const o = buildOrder(record(t), "CUST", cfg);

    assert.deepEqual(o.discounts, [{
      uid: "friends-NFF-CHK-WHL-35-39", name: "Friends and Fam",
      amount_money: { amount: 600, currency: "USD" }, scope: "LINE_ITEM",
    }]);
    assert.deepEqual(o.line_items[0].applied_discounts,
      [{ discount_uid: "friends-NFF-CHK-WHL-35-39" }]);
    assert.equal(o.metadata.perk, "friends");
    assert.deepEqual(o.service_charges.map((c) => [c.name,
      c.amount_money.amount]), [["Delivery fee", 0]]);
  });

  it("records family as a discount of the whole order, not a lower " +
    "price", () => {
    const t = totals([{ sku: "NFF-CHK-WHL-35-39", qty: 2 }], ["family"]);
    const o = buildOrder(record(t), "CUST", cfg);

    assert.deepEqual(o.discounts, [{
      name: "Family", amount_money: { amount: 6000, currency: "USD" },
      scope: "ORDER",
    }]);
    assert.equal(o.line_items[0].base_price_money.amount, 3000);
    assert.equal(o.metadata.perk, "family");
  });

  it("adds no perk to any other order's metadata", () => {
    const t = totals([{ sku: "NFF-CHK-WHL-35-39", qty: 2 }], []);

    assert.equal(buildOrder(record(t), "CUST", cfg).metadata.perk, undefined);
  });
});

/* eslint-enable camelcase */

const quietLog = (t) => {
  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, () => {});
  }
};

const square = () => {
  const calls = [];

  return {
    calls,
    square: {
      createOrder: async (order) => {
        calls.push(["order", order.totals]);

        return { squareOrderId: "SQO", customerId: "CUST" };
      },
      payZeroOrder: async (id) => {
        calls.push(["zero", id]);

        return { squareOrderId: id };
      },
      createPayment: async (args) => {
        calls.push(["payment", args.amount ?? args.order.totals.total]);

        return {
          squarePaymentId: "PAY", status: "COMPLETED", receiptUrl: null,
          brand: "VISA", last4: "4242", wallet: null,
        };
      },
      cancelOrder: async (id) => ({ id, cancelled: true }),
      findPaid: async () => null,
    },
  };
};

const payload = (claimedTotal, payment) => ({
  idempotencyKey: KEY,
  attempt: 1,
  customer: {
    firstName: "Pat", lastName: "Example", email: PAT,
    phone: "401-555-0100", contact: "call",
  },
  lines: [{ sku: "NFF-CHK-WHL-35-39", qty: 1 }],
  fulfilment: {
    method: "delivery", date: "2026-10-08",
    delivery: {
      address1: "1 Main St", town: "Foster", zip: "02825", cooler: "Porch",
    },
  },
  claimedTotal,
  payment,
});

const signedIn = async (type) => {
  const stores = testStores();
  const session = await createSession(stores, PAT, { now });

  await addPerk(stores, PAT, type, { by: "james", now,
    owner: type === "family" });

  return { stores, session };
};

const post = (body, session) => new Request("http://x/api/orders", {
  method: "POST",
  headers: {
    "Content-Type": "application/json", cookie: `nff_session=${session.id}`,
  },
  body: JSON.stringify(body),
});

describe("POST /api/orders for friends and family", () => {
  it("charges the price less the amounts, under the minimum, with no fee",
    async (t) => {
      quietLog(t);

      const { stores, session } = await signedIn("friends");
      const sq = square();
      // One $30 chicken, $3 off, no fee: $27, under the $40 minimum.
      const res = await handle(post(payload(2700,
        { method: "card", sourceId: "cnon:tok" }), session), {
        stores, square: sq.square, now, sleep: async () => {},
      });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.totals.total, 2700);
      assert.equal(data.totals.discountPerk, "friends");
      assert.deepEqual(sq.calls.find((c) => c[0] === "payment"),
        ["payment", 2700]);
    });
});

describe("POST /api/orders for family", () => {
  it("records the order paid with nothing charged", async (t) => {
    quietLog(t);

    const { stores, session } = await signedIn("family");
    const sq = square();
    const res = await handle(post(payload(0, { method: "credit" }), session),
      { stores, square: sq.square, now, sleep: async () => {} });
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.totals.total, 0);
    assert.deepEqual(sq.calls.map((c) => c[0]), ["order", "zero"]);

    const order = await getOrder(stores, data.orderId);

    assert.equal(order.status, "paid");
    assert.deepEqual(order.payments, []);
    assert.equal(order.totals.discountPerk, "family");
    assert.equal(paymentPhrase(order), "$0, nothing to pay");
  });

  it("charges nothing even when the page sends a card", async (t) => {
    quietLog(t);

    const { stores, session } = await signedIn("family");
    const sq = square();
    const res = await handle(post(payload(0,
      { method: "card", sourceId: "cnon:tok" }), session), {
      stores, square: sq.square, now, sleep: async () => {},
    });

    assert.equal(res.status, 200);
    assert.ok(!sq.calls.some((c) => c[0] === "payment"));
  });
});
