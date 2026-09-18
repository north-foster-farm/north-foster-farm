import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import terms from "../data/delivery.json" with { type: "json" };
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import {
  computeTotals, discountFor, dollars, meetsMinimum, nextTier,
} from "../assets/scripts/order/lib/totals.mjs";

const index = indexCatalog(catalog);
const { money } = terms;

// A fake index so subtotals can land on any dollar amount.
const priced = (price) => new Map([["X", { price }]]);

const totalsAt = (price, method = "onfarm") => computeTotals({
  lines: [{ sku: "X", qty: 1 }], method, index: priced(price), money,
});

describe("bulk discount tiers", () => {
  it("apply at exactly the threshold and never stack", () => {
    assert.equal(discountFor(4900, money).amount, 0);
    assert.equal(discountFor(5000, money).amount, 500);
    assert.equal(discountFor(9900, money).amount, 500);
    assert.equal(discountFor(10000, money).amount, 1000);
    assert.equal(discountFor(14900, money).amount, 1000);
    assert.equal(discountFor(15000, money).amount, 1500);
    assert.equal(discountFor(19900, money).amount, 1500);
    assert.equal(discountFor(20000, money).amount, 2000);
    assert.equal(discountFor(99900, money).amount, 2000);
  });

  it("report the tier reached", () => {
    assert.equal(discountFor(4900, money).tier, null);
    assert.equal(discountFor(15000, money).tier, 150);
  });

  it("know how far the next tier is", () => {
    assert.deepEqual(
      nextTier(4200, money), { threshold: 5000, off: 500, gap: 800 }
    );
    assert.equal(nextTier(20000, money), null);
  });
});

describe("delivery fee", () => {
  it("is $5 on delivery under $150 and waived at $150", () => {
    assert.equal(totalsAt(149, "delivery").deliveryFee, 500);
    assert.equal(totalsAt(150, "delivery").deliveryFee, 0);
  });

  it("is never charged for pickup or drop sites", () => {
    assert.equal(totalsAt(20, "onfarm").deliveryFee, 0);
    assert.equal(totalsAt(20, "scituate").deliveryFee, 0);
  });

  it("is judged on the subtotal before the discount", () => {
    const t = totalsAt(150, "delivery");

    assert.equal(t.discountAmount, 1500);
    assert.equal(t.deliveryFee, 0);
    assert.equal(t.total, 13500);
  });
});

describe("discount groups", () => {
  const withGroup = (price, group, method = "onfarm") => computeTotals({
    lines: [{ sku: "X", qty: 1 }], method, index: priced(price), money, group,
  });

  it("take a percentage off the subtotal, labelled", () => {
    const t = withGroup(30, "friends");

    assert.equal(t.discountAmount, 300);
    assert.equal(t.discountGroup, "friends");
    assert.equal(t.discountTier, null);
    assert.equal(t.discountLabel, "Friends & family (10%)");
    assert.equal(t.total, 2700);
  });

  it("never stack with a bulk tier: the larger one wins", () => {
    // $60: bulk $5 beats friends $6? No, $6 wins.
    assert.equal(withGroup(60, "friends").discountAmount, 600);
    assert.equal(withGroup(60, "friends").discountGroup, "friends");
    // $45: friends $4.50 beats no tier.
    assert.equal(withGroup(45, "friends").discountAmount, 450);
    // $100: bulk $10 equals friends $10; the bulk tier stands.
    assert.equal(withGroup(100, "friends").discountGroup, null);
    assert.equal(withGroup(100, "friends").discountLabel,
      "Bulk discount ($100+)");
    // $100 wholesale $20 beats bulk $10.
    assert.equal(withGroup(100, "wholesale").discountAmount, 2000);
  });

  it("ignore an unknown group", () => {
    assert.equal(withGroup(60, "nope").discountAmount, 500);
    assert.equal(withGroup(60, null).discountLabel, "Bulk discount ($50+)");
  });

  it("round to the cent", () => {
    assert.equal(withGroup(33.33, "friends").discountAmount, 333);
  });
});

describe("the $40 delivery minimum", () => {
  it("is met at $40 after discount and not at $39", () => {
    assert.ok(meetsMinimum(totalsAt(40, "delivery"), money));
    assert.ok(!meetsMinimum(totalsAt(39, "delivery"), money));
  });

  it("counts the discount: $50 less $5 still passes", () => {
    assert.ok(meetsMinimum(totalsAt(50, "delivery"), money));
  });
});

describe("real catalog prices", () => {
  it("total a mixed order correctly", () => {
    const t = computeTotals({
      lines: [
        { sku: "NFF-CHK-EGG-LG", qty: 2 },
        { sku: "NFF-CHK-WHL-0350-0400", qty: 1 },
        { sku: "NFF-CHK-BRSBL-0000-0125", qty: 3 },
      ],
      method: "delivery",
      index,
      money,
    });

    assert.equal(t.subtotal, 8900);
    assert.equal(t.discountAmount, 500);
    assert.equal(t.deliveryFee, 500);
    assert.equal(t.total, 8900);
  });

  it("ignore unknown SKUs rather than crash", () => {
    const t = computeTotals({
      lines: [{ sku: "NOPE", qty: 4 }], method: "onfarm", index, money,
    });

    assert.equal(t.total, 0);
  });
});

describe("dollars", () => {
  it("formats whole and fractional amounts", () => {
    assert.equal(dollars(0), "$0");
    assert.equal(dollars(500), "$5");
    assert.equal(dollars(8950), "$89.50");
    assert.equal(dollars(-1000), "-$10");
  });
});
