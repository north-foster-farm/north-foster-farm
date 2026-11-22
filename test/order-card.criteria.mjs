// Criteria tests for #834, phase 2 of the split of account/main.js
// (docs/refactors/account.md, "Phase 2: the order card"), held out of
// `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/order-card.criteria.mjs test/order-card.test.mjs
//
// All twelve criteria are of the new-module kind: they fail on `next`,
// where account/lib/order-card.mjs does not exist, and pass once the
// phase draws orderCard's decisions out. Nothing retires.
//
// Contract (the design names the functions and their module, not
// their arguments or what they return; these are the test agent's
// choice; the call shape and keys may be adapted, the expected values
// may not). Each takes the order as /api/account/orders gives it. The
// words are today's, byte for byte.
//
//   pickupNote(order)  -> the note under the when line, or nothing
//   refundNote(order)  -> the money note, or nothing
//   totalRows(order)   -> [[term, value]], in order
//   actionsOf(order)   -> the actions' names, in order, as the buttons
//                         and links read
//   lineRows(order)    -> [{ qty, label, total, href }]

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  actionsOf, lineRows, pickupNote, refundNote, totalRows,
} from "../assets/scripts/account/lib/order-card.mjs";
import {
  addUrl, placed,
} from "../assets/scripts/account/lib/order-words.mjs";
import { paidWith } from "../assets/scripts/account/lib/history.mjs";
import { dollars } from "../assets/scripts/order/lib/totals.mjs";
import { label } from "../assets/scripts/order/lib/zoned.mjs";
import { assertPure } from "./pure-module.mjs";

const nothing = (text) => [null, undefined, ""].includes(text);
const CARD = { method: "card", brand: "VISA", last4: "1111" };
const base = {
  id: "NFF-2612-QA71", status: "paid", cancelRequested: false,
  submittedAt: "2026-12-01T14:00:00.000Z",
  lines: [
    { sku: "NFF-CHK-EGG-LG", label: "Eggs, Grade A · Large", qty: 2,
      unitPrice: 7, lineTotal: 14 },
    { sku: "NFF-CHK-WNG", label: "Wings", qty: 1, unitPrice: 9.5,
      lineTotal: 9.5 },
  ],
  totals: { subtotal: 2350, discountAmount: 0, deliveryFee: 500,
    total: 2850 },
  fulfilment: { method: "delivery", date: "2026-12-10" },
  payments: [{ ...CARD, amount: 2850, at: "2026-12-01T14:00:05.000Z" }],
  refunds: [], returns: [], question: null, keptFee: 0,
  canChange: true, canCancel: true,
};
const order = (more = {}) => ({ ...base, ...more });

// Box 1 of #834.
describe("pickupNote, a pickup gone", () => {
  it("for a pickup that no longer resolves is the line asking the customer "
    + "to get in touch", () => {
    assert.equal(pickupNote(order({
      fulfilment: { method: "scheduled", occurrence: "X-1",
        date: "2026-12-12" },
      pickup: { name: "Gone", gone: true },
    })), "We can't change this pickup here. Please call, text, or email us, "
      + "and we'll work it out.");
  });
});

// Box 2 of #834.
describe("pickupNote, a pickup time the farm can't make", () => {
  it("says the farm can't make an unanswered question's pickup time, with "
    + "the farm's reason when one was given", () => {
    const asked = (reason) => order({
      fulfilment: { method: "onfarm", date: "2026-12-12" },
      question: { kind: "window", reason, answeredAt: null },
    });
    const tail = " Please choose another day and time with Change pickup, or "
      + "cancel the order.";

    assert.equal(pickupNote(asked("We're at market that morning.")),
      `We can't make that pick-up time: We're at market that morning.${tail}`);
    assert.equal(pickupNote(asked("")), `We can't make that pick-up time.${
      tail}`);
  });
});

const missed = (keptFee) => order({
  keptFee,
  refunds: [{ amount: 300, at: "2026-12-11T15:00:00.000Z", payment: 0 }],
  question: { kind: "missed", until: "2026-12-17", answeredAt: null },
});

// Box 3 of #834.
describe("pickupNote, a missed delivery", () => {
  it("names the day the order is held until and the refund on cancelling: "
    + "what was paid, less refunds, less a kept fee", () => {
    assert.equal(pickupNote(missed(0)), "We couldn't deliver this order, so "
      + `we're holding it until ${label("2026-12-17")}. Choose another `
      + "delivery day or a pickup with Change items, or cancel it for a "
      + `refund of ${dollars(2850 - 300)}. If we don't hear from you by `
      + "then, we'll cancel it and refund you in full.");
    assert.ok(pickupNote(missed(500))
      .includes(`refund of ${dollars(2850 - 300 - 500)}.`));
  });
});

// Box 4 of #834.
describe("pickupNote, a fee kept", () => {
  it("says another delivery day carries another fee and that the fee is "
    + "not refunded", () => {
    const note = pickupNote(missed(500));

    assert.ok(note.includes("Choose another delivery day (with another "
      + "delivery fee) or a pickup with Change items"), note);
    assert.ok(note.endsWith("we'll cancel it and refund you, though the "
      + `delivery fee of ${dollars(500)} isn't refunded because we made the `
      + "trip."), note);
  });
});

// Box 5 of #834.
describe("pickupNote, an answered question", () => {
  it("leaves no note", () => {
    for (const kind of ["window", "missed"]) {
      assert.ok(nothing(pickupNote(order({ question: { kind,
        until: "2026-12-17", reason: "x",
        answeredAt: "2026-12-12T10:00:00.000Z" } }))), kind);
    }
    assert.ok(nothing(pickupNote(order())));
  });
});

// Box 6 of #834.
describe("refundNote, a cancellation asked for", () => {
  it("says the refund is on its way", () => {
    assert.equal(refundNote(order({ cancelRequested: true })),
      "We're refunding this order. Your money goes back to the way you paid.");
  });
});

// Box 7 of #834.
describe("refundNote, refunds", () => {
  it("says Refunded when all is back and the amount otherwise, with the "
    + "date of the last one", () => {
    const last = "2026-12-12T15:00:00.000Z";
    const all = [{ amount: 2000, at: "2026-12-11T15:00:00.000Z" },
      { amount: 850, at: last }];

    assert.equal(refundNote(order({ refunds: all })),
      `Refunded on ${placed(last)}, back to the way you paid.`);
    assert.equal(refundNote(order({ refunds: all.slice(0, 1) })),
      `Refunded ${dollars(2000)} on ${placed(all[0].at)}, back to the way `
      + "you paid.");
  });
});

// Box 8 of #834.
describe("refundNote, unpaid and abandoned", () => {
  it("says what is due on an unpaid order with an amount due, and that an "
    + "abandoned one was canceled", () => {
    assert.equal(refundNote(order({ status: "unpaid", due: 1500,
      payments: [] })), `Not paid yet: ${dollars(1500)} due.`);
    assert.equal(refundNote(order({ status: "abandoned", payments: [] })),
      "This order wasn't paid by the cutoff, so it was canceled.");
    assert.ok(nothing(refundNote(order())));
  });
});

// Box 9 of #834.
describe("totalRows", () => {
  it("has a discount row only with a discount, a delivery row only for a "
    + "delivery (Free at zero), the total, and how it was paid, payments "
    + "joined by \", then\"", () => {
    assert.deepEqual(totalRows(order()), [
      ["Delivery fee", `+${dollars(500)}`],
      ["Total", dollars(2850)],
      ["Paid with", paidWith(CARD)],
    ]);

    const venmo = { method: "venmo", amount: 500 };

    assert.deepEqual(totalRows(order({
      totals: { ...base.totals, discountAmount: 300,
        discountLabel: "Ten off", deliveryFee: 0 },
      payments: [base.payments[0], venmo],
    })), [
      ["Ten off", `−${dollars(300)}`],
      ["Delivery fee", "Free"],
      ["Total", dollars(2850)],
      ["Paid with", `${paidWith(CARD)}, then ${paidWith(venmo)}`],
    ]);
    assert.deepEqual(totalRows(order({
      fulfilment: { method: "onfarm", date: "2026-12-12" }, payments: [],
      totals: { ...base.totals, discountAmount: 300 },
    })), [["Discount", `−${dollars(300)}`], ["Total", dollars(2850)]]);
  });
});

// Box 10 of #834.
describe("actionsOf, changing", () => {
  it("always offers Reorder, and Change delivery or Change pickup, and "
    + "Change items, only when the order can change", () => {
    assert.deepEqual(actionsOf(order({ canCancel: false, status: "unpaid" })),
      ["Reorder", "Change delivery", "Change items"]);
    assert.deepEqual(actionsOf(order({ canCancel: false, status: "unpaid",
      fulfilment: { method: "onfarm", date: "2026-12-12" } })),
    ["Reorder", "Change pickup", "Change items"]);
    assert.deepEqual(actionsOf(order({ canChange: false, canCancel: false,
      status: "cancelled" })), ["Reorder"]);
  });
});

// Box 11 of #834.
describe("actionsOf, canceling and reporting", () => {
  it("offers Cancel order only when the order can be canceled, and Report "
    + "a problem only when it is paid or fulfilled", () => {
    const fixed = { canChange: false };

    assert.deepEqual(actionsOf(order({ ...fixed })),
      ["Reorder", "Cancel order", "Report a problem"]);
    assert.deepEqual(actionsOf(order({ ...fixed, canCancel: false,
      status: "fulfilled" })), ["Reorder", "Report a problem"]);
    assert.deepEqual(actionsOf(order({ ...fixed, status: "unpaid" })),
      ["Reorder", "Cancel order"]);
  });
});

// Box 12 of #834.
describe("lineRows", () => {
  it("gives each line its quantity, label, total and the link that adds it "
    + "again", () => {
    assert.deepEqual(lineRows(order()).map(({ qty, label: name, total,
      href }) => ({ qty, label: name, total, href })), [
      { qty: "2 ×", label: "Eggs, Grade A · Large", total: dollars(1400),
        href: addUrl([base.lines[0]]) },
      { qty: "1 ×", label: "Wings", total: dollars(950),
        href: addUrl([base.lines[1]]) },
    ]);
  });
});

describe("design, section 2", () => {
  it("keeps account/lib/order-card.mjs pure", () => {
    assertPure(new URL("../assets/scripts/account/lib/order-card.mjs",
      import.meta.url), { banned: ["document", "(?<![.\\w])window\\.",
      "Element"] });
  });
});
