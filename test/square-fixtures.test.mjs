// Square's own answers, recorded from the sandbox (test/fixtures/
// square/, each with its source and date), replayed against what the
// site sends and expects: every faked response comes from a real one
// (James, 2026-10-26).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import terms from "../data/delivery.json" with { type: "json" };
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { computeTotals } from "../assets/scripts/order/lib/totals.mjs";
import {
  buildOrder, settings,
} from "../netlify/functions/lib/square.mjs";

const fixture = (name) => JSON.parse(readFileSync(
  new URL(`./fixtures/square/${name}.json`, import.meta.url), "utf8",
));
const index = indexCatalog(catalog);
const { money } = terms;
const cfg = settings({
  SQUARE_ACCESS_TOKEN: "tok", SQUARE_LOCATION_ID: "<LOCATION_ID>",
  SQUARE_ENV: "sandbox",
});
const EGGS = "NFF-CHK-EGG-LG";

describe("a credit larger than the items, on a delivery (C1)", () => {
  const { request, response } = fixture("create-order-credit-over-items");
  const sq = response.order;

  it("is applied by Square to the items only, never the fee", () => {
    assert.equal(sq.state, "OPEN");
    assert.equal(sq.discounts[0].amount_money.amount, 1200);
    assert.equal(sq.discounts[0].applied_money.amount, 700);
    assert.equal(sq.line_items[0].total_money.amount, 0);
    assert.equal(sq.service_charges[0].total_money.amount, 500);
    assert.equal(sq.total_discount_money.amount, 700);
    assert.equal(sq.total_money.amount, 500);
    assert.equal(sq.net_amount_due_money.amount, 500);
  });

  it("is what buildOrder sends, line, fee and discount alike", () => {
    // The same order on our side: one dozen large eggs, $7, delivered,
    // with $12 of credit on the account.
    const totals = computeTotals({
      lines: [{ sku: EGGS, qty: 1 }], method: "delivery", index, money,
      zipStatus: "approved", credit: 1200,
    });
    const built = buildOrder({
      id: "FIXTURE-C1",
      customer: { name: "Pat Example", email: "pat@example.com", phone: "",
        contact: "" },
      fulfilment: { method: "delivery", date: "2026-11-05", onfarm: null,
        delivery: { address1: "1 Main St", town: "Foster", zip: "02825",
          cooler: "Porch" } },
      lines: [{ sku: EGGS, label: "Eggs, Grade A · Large",
        name: "Eggs, Grade A · Large", unitPrice: 7, qty: 1, lineTotal: 7,
        squareVariationId: null }],
      totals, notes: "", source: "",
      flags: { zipUnlisted: false, totalMismatch: false },
    }, "<CUSTOMER_ID>", cfg);
    const sent = request.order;

    assert.equal(built.location_id, sent.location_id);
    assert.equal(built.reference_id, sent.reference_id);
    assert.deepEqual(built.line_items[0], sent.line_items[0]);
    assert.deepEqual(
      built.service_charges.map(({ name, amount_money: m,
        calculation_phase: p, taxable }) => ({ name, amount: m.amount,
        phase: p, taxable })),
      sent.service_charges.map(({ name, amount_money: m,
        calculation_phase: p, taxable }) => ({ name, amount: m.amount,
        phase: p, taxable })),
    );

    const credit = built.discounts.find((d) => d.name === "Group credit");

    assert.equal(credit.scope, sent.discounts[0].scope);
    // Capped at the items' net, our credit line is what Square would
    // apply, so the totals agree: $5 due, the fee.
    assert.equal(credit.amount_money.amount, sq.discounts[0].applied_money
      .amount);
    assert.equal(totals.credit, sq.total_discount_money.amount);
    assert.equal(totals.total, sq.total_money.amount);
  });
});
