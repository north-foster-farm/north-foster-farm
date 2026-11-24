// Criteria test for #749 (Group orders as their own fulfillment type
// for Village Family Fitness members), the server's half of its box "A
// group order is accepted until 6:00 AM after its round's cutoff;
// after that, a late member sees 'That group order date is no longer
// available' and its approved lines" (item 8 of its approved list).
// The page's half is in e2e/group-orders.criteria.mjs. Held out of
// every run by its name until the change lands: renamed to
// group-orders-grace.test.mjs, `npm test` runs it.
//
// The seam, what the test relies on:
// - the order is checked by validateOrder (lib/validate.mjs) at `now`,
//   with the member's terms from lib/groups.mjs `memberTerms`, as
//   netlify/functions/orders.mjs calls it;
// - a group order is posted as the page posts it (POSTED below): the
//   way and the round's occurrence id, "36TS-<YYMMDD>", the shape a
//   stored round order keeps;
// - a refused one is answered as a lapsed pickup is today: not ok,
//   status 409, an error on the occurrence and the fresh `dates`.
//
// The round is the group's real one on Sunday 2026-11-22, from
// data/series.json; its cutoff is 11:59 PM on Saturday the 21st
// (lib/events.mjs `cutoffOf`).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import { validateOrder } from "../assets/scripts/order/lib/validate.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import {
  groupOf, memberTerms,
} from "../netlify/functions/lib/groups.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import discountCodes from "../data/discount-codes.json" with {
  type: "json",
};
import { SCHEDULE } from "./schedule-fixture.mjs";

const ny = (iso, h, m) => instant(iso, h, m, "America/New_York");
const VFF = groupOf("vff");
const ROUND = "2026-11-22";
const OCCURRENCE = `${VFF.series}-261122`;
const index = indexCatalog(catalog);
const schedule = Object.assign(parseSchedule(SCHEDULE).windows,
  { lines: parseSchedule(SCHEDULE).lines });

// A group order as the page posts it: the way and the round.
const POSTED = { method: "scheduled", occurrence: OCCURRENCE, date: ROUND };

const payload = {
  customer: {
    firstName: "Pat", lastName: "Example", email: "pat@example.com",
    phone: "401-555-0100", contact: "call",
  },
  lines: [{ sku: "NFF-CHK-WHL-35-39", qty: 2 }],
  fulfilment: POSTED,
  claimedTotal: 6000,
};

// The member's order, checked at `now`.
const placed = (now) => validateOrder(payload, {
  index, terms: memberTerms(terms, VFF), now, group: null,
  codes: discountCodes.codes, schedule,
});

describe("Group orders' grace (#749)", () => {
  it("A group order is accepted until 6:00 AM after its round's " +
    "cutoff; after that, a late member sees \"That group order date " +
    "is no longer available\" and its approved lines (server)", () => {
    // Before the cutoff, as today.
    for (const [label, now] of [
      ["Saturday 11:00 PM", ny("2026-11-21", 23, 0)],
      ["Saturday 11:59 PM, the cutoff", ny("2026-11-21", 23, 59)],
      // After the cutoff, inside the grace.
      ["Sunday 12:01 AM", ny(ROUND, 0, 1)],
      ["Sunday 3:00 AM", ny(ROUND, 3, 0)],
      ["Sunday 5:59 AM", ny(ROUND, 5, 59)],
    ]) {
      const result = placed(now);

      assert.equal(result.ok, true,
        `${label}: accepted, ${JSON.stringify(result.errors)}`);
      assert.equal(result.order.fulfilment.occurrence, OCCURRENCE,
        `${label}: its round`);
      assert.equal(result.order.fulfilment.date, ROUND, `${label}: its day`);
    }

    // Past 6:00 AM it has lapsed: refused, with the fresh list, which
    // no longer holds the round.
    for (const [label, now] of [
      ["Sunday 6:01 AM", ny(ROUND, 6, 1)],
      ["Sunday 8:30 AM, the round itself", ny(ROUND, 8, 30)],
    ]) {
      const result = placed(now);

      assert.equal(result.ok, false, `${label}: refused`);
      assert.equal(result.status, 409, `${label}: lapsed, not invalid`);
      assert.ok(result.errors["fulfilment.occurrence"],
        `${label}: the round is what lapsed`);
      assert.ok(Array.isArray(result.dates), `${label}: the fresh list`);
      assert.equal(result.dates.some((d) => d.occurrence === OCCURRENCE),
        false, `${label}: the round is no longer offered`);
    }
  });
});
