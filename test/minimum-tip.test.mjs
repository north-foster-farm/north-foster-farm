// Proceed to checkout's tooltip for a delivery short of the minimum
// (#706, lib/summary.mjs minimumTip): the implementer's own test of
// the helper, beside the criteria test in e2e/checkout-go.spec.mjs.

import assert from "node:assert/strict";
import { it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import {
  minimumTip, summarize,
} from "../assets/scripts/order/lib/summary.mjs";
import { computeTotals } from "../assets/scripts/order/lib/totals.mjs";

const { money } = terms;

const at = (price, method = "delivery") => computeTotals({
  lines: [{ sku: "X", qty: 1 }],
  method,
  index: new Map([["X", { price }]]),
  money,
});

it("names the minimum and the current order, from the data", () => {
  assert.equal(minimumTip(at(7), money),
    `Delivery orders have a $${money.deliveryMinimum} minimum (current ` +
    "order is $7). Please add more to your cart or choose a different " +
    "pick-up option.");
  assert.match(minimumTip(at(12.5), money), /current order is \$12\.50\)/);
});

it("measures the goods after discounts, never the delivery fee", () => {
  const totals = { ...at(30), discountAmount: 500 };

  assert.match(minimumTip(totals, money), /current order is \$25\)/);
});

it("is in the summary only for a delivery short of the minimum", () => {
  const sum = (totals, method) => summarize({
    totals, method, money, count: 1,
  }).minimumTip;

  assert.notEqual(sum(at(7), "delivery"), "");
  assert.equal(sum(at(7, "onfarm"), "onfarm"), "");
  assert.equal(sum(at(money.deliveryMinimum), "delivery"), "");
});
