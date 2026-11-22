// Criteria tests for #835, phase 3 of the split of account/main.js
// (docs/refactors/account.md, "Phase 3: receipts and downloads"), held
// out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/receipts.criteria.mjs test/receipts.test.mjs
//
// All four criteria are of the new-module kind: they fail on `next`,
// where account/lib/receipts.mjs does not exist, and pass once the
// phase draws renderReceipts' and showReceipt's facts out. Nothing
// retires: history.test.mjs tests a library that does not move.
//
// Contract (the design names the functions and their module, not
// their arguments or what they return; these are the test agent's
// choice; the call shape and keys may be adapted, the expected values
// may not):
//
//   receiptRows(orders)
//     -> [{ id, amount, status, cancelled, link }], one a payment, in
//        order; `link` { href } for the processor's receipt,
//        { card: true } for the page's own, or null
//   venmoReceipt(order, payment)
//     -> { paid, amount, payer, capture }; payer and capture null
//        where the payment lacks them

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  receiptRows, venmoReceipt,
} from "../assets/scripts/account/lib/receipts.mjs";
import { placed } from "../assets/scripts/account/lib/order-words.mjs";
import { statusOf } from "../assets/scripts/account/lib/history.mjs";
import { dollars } from "../assets/scripts/order/lib/totals.mjs";
import { assertPure } from "./pure-module.mjs";

const AT = "2026-12-01T14:00:05.000Z";
const URL_SQ = "https://squareupsandbox.com/receipt/preview/qa";
const card = (amount) => ({ method: "card", brand: "VISA", last4: "1111",
  amount, at: AT, receiptUrl: URL_SQ });
const venmo = (amount, more = {}) => ({ method: "venmo", via: "venmo",
  amount, at: AT, ...more });
const order = (id, payments, refunds = [], status = "paid") => ({
  id, status, payments, refunds,
  fulfilment: { method: "delivery", date: "2026-12-10" },
});

// Box 1 of #835.
describe("receiptRows, one a payment", () => {
  it("gives one row for each payment of each order", () => {
    const rows = receiptRows([
      order("NFF-A", [card(2000), venmo(500)]),
      order("NFF-B", [card(1400)]),
      order("NFF-C", []),
    ]);

    assert.deepEqual(rows.map((r) => [r.id, r.amount]), [
      ["NFF-A", dollars(2000)], ["NFF-A", dollars(500)],
      ["NFF-B", dollars(1400)],
    ]);
  });
});

// Box 2 of #835.
describe("receiptRows, refunds", () => {
  it("reads Refunded and marks cancelled a payment refunded in full, the "
    + "amount for one refunded in part, and the order's status for one "
    + "with no refund", () => {
    const paid = order("NFF-A", [card(2000), venmo(500)], [
      { amount: 2000, payment: 0, at: AT },
      { amount: 200, payment: 1, at: AT },
    ]);
    const [full, part] = receiptRows([paid]);

    assert.equal(full.status, "Refunded");
    assert.equal(full.cancelled, true);
    assert.equal(part.status, `Refunded ${dollars(200)}`);
    assert.equal(part.cancelled, false);

    const done = order("NFF-B", [card(1400)], [], "fulfilled");
    const [none] = receiptRows([done]);

    assert.equal(none.status, statusOf(done));
    assert.equal(none.cancelled, false);
  });
});

// Box 3 of #835.
describe("receiptRows, the link", () => {
  it("links the processor's receipt when the payment has one, our own card "
    + "for a Venmo payment without one, and nothing otherwise", () => {
    const [square, ours, none, paypal] = receiptRows([order("NFF-A", [
      card(2000), venmo(500), { method: "card", amount: 100, at: AT },
      venmo(300, { receiptUrl: "https://www.paypal.com/receipt/x" }),
    ])]);

    assert.deepEqual(square.link, { href: URL_SQ });
    assert.deepEqual(ours.link, { card: true });
    assert.equal(none.link, null);
    assert.deepEqual(paypal.link, { href: "https://www.paypal.com/receipt/x" });
  });
});

// Box 4 of #835.
describe("venmoReceipt", () => {
  it("gives the date, the amount, and the payer and PayPal capture only "
    + "where the payment has them", () => {
    const paid = order("NFF-A", []);

    assert.deepEqual(venmoReceipt(paid, venmo(2000, { payer: "Ada Hen",
      paypalCaptureId: "3C679366HH908993F" })), {
      paid: placed(AT), amount: dollars(2000), payer: "Ada Hen",
      capture: "PayPal 3C679366HH908993F",
    });
    assert.deepEqual(venmoReceipt(paid, venmo(500)), {
      paid: placed(AT), amount: dollars(500), payer: null, capture: null,
    });
  });
});

describe("design, section 2", () => {
  it("keeps account/lib/receipts.mjs pure", () => {
    assertPure(new URL("../assets/scripts/account/lib/receipts.mjs",
      import.meta.url), { banned: ["document", "(?<![.\\w])window\\.",
      "Element"] });
  });
});
