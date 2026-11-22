// Criteria tests for #842, phase 10 of the split of account/main.js
// (docs/refactors/account.md, "Phase 10: the record and the root"),
// held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/account-state.criteria.mjs test/account-state.test.mjs
//
// All four criteria are of the new-module kind: they fail on `next`,
// where account/lib/state.mjs does not exist, and pass once the phase
// adds it. Nothing retires.
//
// Contract. The design writes the transitions as `store.set(loaded(got))`
// and so on; here each takes the record first and returns the next
// one, the test agent's choice. The call shape may be adapted, the
// expected values may not. The record's keys are the design's:
// customer, orders, member, credit, membership, dates, roundSeries,
// locations.
//
//   initialState({ locations })
//   loaded(state, { customer, orders, member, credit })
//   customerSaved(state, customer)
//   orderReplaced(state, order)
//   datesLoaded(state, dates, group)
//     dates  /api/dates' answer; group  /api/group's (dates, group with
//            series and places), or null

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  customerSaved, datesLoaded, initialState, loaded, orderReplaced,
} from "../assets/scripts/account/lib/state.mjs";
import { assertPure } from "./pure-module.mjs";

const PUBLIC = [{ code: "D8RW", name: "Foster" }];
const start = () => initialState({ locations: PUBLIC });
const order = (id, status = "paid") => ({ id, status, lines: [] });
const got = {
  customer: { email: "ada@example.com", firstName: "Ada" },
  orders: [order("NFF-A"), order("NFF-B"), order("NFF-C")],
  member: { name: "The gym", credit: 1500 }, credit: 300,
};

// Box 1 of #842.
describe("loaded", () => {
  it("sets the customer, the orders, the member and the credit", () => {
    const s = loaded(start(), got);

    assert.deepEqual(s.customer, got.customer);
    assert.deepEqual(s.orders, got.orders);
    assert.deepEqual(s.member, got.member);
    assert.equal(s.credit, 300);
    assert.deepEqual(s.locations, PUBLIC);
  });
});

// Box 2 of #842.
describe("customerSaved", () => {
  it("replaces the customer and nothing else", () => {
    const before = loaded(start(), got);
    const customer = { ...got.customer, firstName: "Adele" };
    const after = customerSaved(before, customer);

    assert.deepEqual(after.customer, customer);
    for (const key of Object.keys(before).filter((k) => k !== "customer")) {
      assert.deepEqual(after[key], before[key], key);
    }
    assert.equal(before.customer.firstName, "Ada", "the old record kept");
  });
});

// Box 3 of #842.
describe("orderReplaced", () => {
  it("swaps the order with the same id and keeps the list's order", () => {
    const s = orderReplaced(loaded(start(), got), order("NFF-B", "cancelled"));

    assert.deepEqual(s.orders.map((o) => [o.id, o.status]), [
      ["NFF-A", "paid"], ["NFF-B", "cancelled"], ["NFF-C", "paid"],
    ]);
  });
});

// Box 4 of #842.
describe("datesLoaded", () => {
  it("adds the group's rounds, its series, and its places after the "
    + "public ones", () => {
    const dates = { delivery: [{ date: "2026-12-10" }], scheduled: [] };
    const rounds = [{ occurrence: "36TS-261212", date: "2026-12-12" }];
    const places = [{ code: "NR9D", name: "The gym" }];
    const s = datesLoaded(loaded(start(), got), dates, {
      dates: rounds, group: { series: "36TS", places: { locations: places } },
    });

    assert.deepEqual(s.dates.delivery, dates.delivery);
    assert.deepEqual(s.dates.group, rounds);
    assert.equal(s.roundSeries, "36TS");
    assert.deepEqual(s.locations, [...PUBLIC, ...places]);

    const alone = datesLoaded(loaded(start(), got), dates, null);

    assert.deepEqual(alone.dates, dates);
    assert.deepEqual(alone.locations, PUBLIC);
  });
});

describe("design, section 2", () => {
  it("keeps account/lib/state.mjs pure", () => {
    assertPure(new URL("../assets/scripts/account/lib/state.mjs",
      import.meta.url), { banned: ["document", "(?<![.\\w])window\\.",
      "Element", "fetch"] });
  });
});
