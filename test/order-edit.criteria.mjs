// Criteria tests for #825, phase 11 of the split of order-form.js
// (docs/refactors/order-form.md, "Phase 11: the account and a paid
// order's change"), held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/order-edit.criteria.mjs test/order-edit.test.mjs
//
// All nine criteria are of the new-module kind: they fail on `next`,
// where form/edit.mjs and the two transitions do not exist, and pass
// once the phase draws them out. Nothing retires: edit.test.mjs tests
// the server's lib/edit.mjs, which does not move (hence the new name).
//
// Contract (the design names the functions, not their arguments; these
// are the test agent's choice; the call shape and key names may be
// adapted, the expected values may not). The state record is #819's
// (form/order-state.mjs), with `group` the discount group and
// `shownMember` the member line shown.
//
//   editingFrom(order)                      form/edit.mjs
//     -> { id, held, kept, keptDate, placed, booked }
//   pricedPerks({ order, customer })        form/edit.mjs
//     customer  /api/me's customer, or null with no answer
//     ->        the perks the change is priced with ([{ type }])
//   editDraft({ order, customer })          form/edit.mjs -> a payload
//   bookedClosed({ booked, fulfilment, now, terms })
//                                           form/edit.mjs -> boolean
//   editButtons({ total, editing, cardOpen })
//                                           form/edit.mjs
//     -> { paymentHidden, saveHidden, payHidden }
//   accountLoaded(state, who)               form/order-state.mjs
//     who  /api/me's answer: { signedIn, customer, member, credit }
//     ->   { state, askGroup }: askGroup, that the account's group is
//          to be asked for

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import { cutoffFor } from "../assets/scripts/order/lib/dates.mjs";
import {
  bookedClosed, editButtons, editDraft, editingFrom, pricedPerks,
} from "../assets/scripts/order/form/edit.mjs";
import {
  accountLoaded, initialState,
} from "../assets/scripts/order/form/order-state.mjs";

const types = (perks) => perks.map((p) => p.type ?? p);
const THU = "2026-12-10";
const ORDER = {
  id: "NFF-2612-QA61",
  submittedAt: "2026-12-01T14:00:00.000Z",
  lines: [{ sku: "NFF-CHK-EGG-LG", label: "Eggs", qty: 8, unitPrice: 7,
    lineTotal: 56 }],
  totals: { subtotal: 5600, deliveryFee: 500, total: 6100,
    perks: ["friends", "free-delivery"] },
  code: "TEN",
  customer: { firstName: "Ada", lastName: "Hen", phone: "4015550100",
    contact: "" },
  fulfilment: { method: "delivery", date: THU, state: "agreed",
    delivery: { address1: "1 Main St", town: "Foster", zip: "02825" } },
  payments: [{ amount: 6100 }, { amount: 700 }],
  refunds: [{ amount: 1200 }],
  keptFee: 500,
  keptDate: "2026-11-26",
};

// Box 1 of #825.
describe("editingFrom", () => {
  it("holds what was paid less what was refunded, the kept fee and its "
    + "date, the day placed and the booked day", () => {
    const e = editingFrom(ORDER);

    assert.equal(e.id, ORDER.id);
    assert.equal(e.held, 6100 + 700 - 1200);
    assert.equal(e.kept, 500);
    assert.equal(e.keptDate, "2026-11-26");
    assert.equal(e.placed, ORDER.submittedAt);
    assert.equal(e.booked, THU);

    const plain = editingFrom({ ...ORDER, refunds: [], keptFee: undefined,
      keptDate: undefined, fulfilment: { method: "onfarm",
        date: "2026-12-12" } });

    assert.equal(plain.held, 6800);
    assert.equal(plain.kept, 0);
    assert.equal(plain.keptDate, null);
    assert.equal(plain.booked, null, "only a delivery books a day");
  });
});

// Box 2 of #825.
describe("pricedPerks", () => {
  it("keeps the order's perks the account still holds, and all of the "
    + "order's when the account gave no answer", () => {
    assert.deepEqual(types(pricedPerks({ order: ORDER, customer: {
      perks: [{ type: "friends" }, { type: "family" }],
    } })), ["friends"]);
    assert.deepEqual(types(pricedPerks({ order: ORDER,
      customer: { perks: [] } })), []);
    assert.deepEqual(types(pricedPerks({ order: ORDER, customer: null })),
      ["friends", "free-delivery"]);
    assert.deepEqual(types(pricedPerks({ order: ORDER, customer: {} })),
      ["friends", "free-delivery"], "an answer with no perks list");
    assert.deepEqual(types(pricedPerks({
      order: { ...ORDER, totals: { total: 6100 } }, customer: null,
    })), []);
  });
});

// Box 3 of #825.
describe("editDraft", () => {
  it("is the order's customer, lines, fulfilment and code, with the "
    + "account's email where the order has none", () => {
    const draft = editDraft({ order: ORDER,
      customer: { email: "ada@example.com" } });

    assert.deepEqual(draft, {
      customer: { ...ORDER.customer, email: "ada@example.com" },
      lines: [{ sku: "NFF-CHK-EGG-LG", qty: 8 }],
      fulfilment: ORDER.fulfilment,
      code: "TEN",
    });

    const own = editDraft({
      order: { ...ORDER, customer: { ...ORDER.customer,
        email: "hen@example.com" } },
      customer: { email: "ada@example.com" },
    });

    assert.equal(own.customer.email, "hen@example.com");
  });
});

// Box 4 of #825.
describe("bookedClosed", () => {
  it("is true only for a delivery on the booked day, past that day's "
    + "cutoff", () => {
    const cutoff = cutoffFor(THU, terms).getTime();
    const after = new Date(cutoff + 60_000);
    const before = new Date(cutoff - 60_000);
    const onDay = { method: "delivery", date: THU };
    const ask = (more) => bookedClosed({
      booked: THU, fulfilment: onDay, now: after, terms, ...more,
    });

    assert.equal(ask({}), true);
    assert.equal(ask({ now: before }), false, "before the cutoff");
    assert.equal(ask({ fulfilment: { method: "delivery",
      date: "2026-12-17" } }), false, "another day");
    assert.equal(ask({ fulfilment: { method: "onfarm", date: THU } }), false,
      "not a delivery");
    assert.equal(ask({ booked: null }), false, "nothing booked");
  });
});

// Box 5 of #825.
describe("editButtons", () => {
  it("with nothing more to pay hides the payment section and shows Save; "
    + "with more to pay shows the section, and Pay only while the card is "
    + "open", () => {
    const editing = { held: 6100, kept: 500 };

    for (const total of [5600, 3000]) {
      assert.deepEqual(editButtons({ total, editing, cardOpen: true }), {
        paymentHidden: true, saveHidden: false, payHidden: true,
      }, `total ${total}`);
    }
    assert.deepEqual(editButtons({ total: 7000, editing, cardOpen: true }), {
      paymentHidden: false, saveHidden: true, payHidden: false,
    });
    assert.deepEqual(editButtons({ total: 7000, editing, cardOpen: false }),
      { paymentHidden: false, saveHidden: true, payHidden: true });
  });
});

const who = (more = {}) => ({
  signedIn: true,
  customer: { email: "ada@example.com", discountGroup: "friends",
    perks: [{ type: "free-delivery" }], memberGroup: null },
  member: null,
  credit: 0,
  ...more,
});
const editing = { id: ORDER.id, held: 6100, kept: 0 };

// Box 6 of #825.
describe("accountLoaded, signed in", () => {
  it("sets the discount group and marks the page signed in", () => {
    const { state } = accountLoaded(initialState(), who());

    assert.equal(state.group, "friends");
    assert.equal(state.signedIn, true);
  });
});

// Box 7 of #825.
describe("accountLoaded, perks", () => {
  it("lays the account's perks and member line over the order, except on "
    + "a paid order being changed", () => {
    const member = { name: "The gym" };
    const fresh = accountLoaded(initialState(), who({ member })).state;

    assert.deepEqual(types(fresh.perks), ["free-delivery"]);
    assert.deepEqual(fresh.shownMember, member);

    const priced = { ...initialState(), editing, perks: [{ type: "friends" }] };
    const changing = accountLoaded(priced, who({ member })).state;

    assert.deepEqual(types(changing.perks), ["friends"]);
    assert.ok(!changing.shownMember);
  });
});

// Box 8 of #825.
describe("accountLoaded, the account's group", () => {
  it("asks for the account's group when the account has one, none is "
    + "unlocked, and no order is being changed", () => {
    const inGroup = who({ customer: { ...who().customer,
      memberGroup: "vff" } });
    const host = who({ member: { name: "The gym" } });

    assert.equal(accountLoaded(initialState(), inGroup).askGroup, true);
    assert.equal(accountLoaded(initialState(), host).askGroup, true,
      "a host, a member by `member` alone");
    assert.ok(!accountLoaded(initialState(), who()).askGroup, "no group");
    assert.ok(!accountLoaded({ ...initialState(), member: { name: "x" } },
      inGroup).askGroup, "one unlocked");
    assert.ok(!accountLoaded({ ...initialState(), editing }, inGroup)
      .askGroup, "a change");
  });
});

// Box 9 of #825.
describe("accountLoaded, own credit", () => {
  it("applies the account's own credit only with no group unlocked and no "
    + "order being changed", () => {
    const credited = who({ credit: 300 });

    assert.equal(accountLoaded(initialState(), credited).state.credit, 300);
    assert.equal(accountLoaded({ ...initialState(), member: { name: "x" },
      credit: 1200 }, credited).state.credit, 1200, "a group's credit");
    assert.equal(accountLoaded({ ...initialState(), editing }, credited)
      .state.credit, 0, "a change");
  });
});
