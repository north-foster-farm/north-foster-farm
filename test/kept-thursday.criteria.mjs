// An order on a Thursday the schedule has replaced keeps its date on
// the order page (#643): the criteria tests that fail until the change.
// Written before the change, from the issue's spec and "Done when"
// alone; one test per criterion, named for it. Held out of `npm test`
// by its name; the change that meets #643 turns it on with
//
//   git mv test/kept-thursday.criteria.mjs test/kept-thursday.test.mjs
//
// The server's rule, which holds today and must go on holding, is in
// test/kept-thursday-server.test.mjs; what the customer sees on the
// order page and in the account is in e2e/kept-thursday.spec.mjs.
//
// THE CONTRACT. Where the issue leaves room, this decides, so the
// implementer does not guess.
//
// 1. The list. `keptDelivery(list, date, now, terms)`, exported from
//    assets/scripts/order/lib/dates.mjs, is the Delivery day list the
//    order page shows for an order being changed: `list` is
//    /api/dates' `delivery` list, `date` the delivery day the order
//    holds (null for a new order). When the date is not in the list
//    and `now` is not past its cutoff, `cutoffFor(date, terms)`,
//    inclusive as the server's `keptDate` rule is (validateOrder), it
//    returns the list with one entry added for it, in date order:
//    `{ date, label, cutoff, kept: true }`. Otherwise it returns the
//    list's entries as they are. It never changes `list`.
//
// 2. "Marked as such". The kept entry's label is the day as every
//    other entry writes it, followed by " (as booked)": "Thursday,
//    December 10 (as booked)". It is the marker the account's Change
//    delivery already gives an order's own day that the list lacks
//    (account/main.js openChange, "Delivery, Thursday, December 10
//    (as booked)") and its pickup times (drawWindows), so the page
//    and the account say it the same way and no new wording is
//    needed. A day the list offers is never marked.
//
// 3. Where it goes. The page's Delivery day select shows the kept
//    entry and selects it unless the customer chooses another day.
//    It goes on the select only, never into DateLists' `lists`:
//    the countdown names the first day on offer, and
//    `DateLists.schedule()`, which the page's own check reads, rebuilds
//    the farm's moves from the days on offer, so neither may take the
//    replaced Thursday for one. The page's own check passes the
//    order's date as `keptDate`, as lib/edit.mjs does, so a
//    quantity-only edit sends the kept date and the page lets it go.
//
// 4. After the cutoff. The page never sends another day in place of
//    the kept one. Once the kept day's cutoff has passed, Save opens
//    the lapsed dialog (order/lapsed.js) as it does for any lapsed
//    date: "That delivery day is no longer available", with the days
//    on offer. The e2e spec holds the page to this.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as datesLib from "../assets/scripts/order/lib/dates.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import { ny } from "./delivery-moved-setup.mjs";

// A namespace, so the missing seam fails only these tests.
const { deliveryDates, keptDelivery } = datesLib;

// December's moved week: Wednesday the 9th in place of Thursday the
// 10th, whose cutoff is noon on Wednesday the 9th.
const schedule = Object.assign([], {
  lines: [], deliveries: parseSchedule("2026-12-09 delivery").deliveries,
});
const KEPT = "2026-12-10";
const offered = (now) => deliveryDates(now, terms, undefined, schedule);
const days = (list) => list.map((d) => d.date);

describe("the Delivery day list for an order on a replaced Thursday " +
  "(#643)", () => {
  it("shows the order's own Thursday, in date order and marked as " +
    "booked, until its cutoff", () => {
    for (const now of [ny("2026-12-03"), ny("2026-12-09", 12, 0)]) {
      const list = offered(now);
      const before = JSON.stringify(list);
      const shown = keptDelivery(list, KEPT, now, terms);
      const kept = shown.filter((d) => d.kept);

      assert.deepEqual(days(shown),
        [...days(list), KEPT].sort(), now.toISOString());
      assert.equal(kept.length, 1);
      assert.equal(kept[0].date, KEPT);
      assert.equal(kept[0].label, "Thursday, December 10 (as booked)");
      assert.equal(kept[0].cutoff,
        datesLib.cutoffFor(KEPT, terms).toISOString());
      assert.ok(shown.filter((d) => !d.kept)
        .every((d) => !d.label.includes("(as booked)")),
      "no day on offer is marked");
      assert.equal(JSON.stringify(list), before, "the list is unchanged");
    }
  });

  it("drops the order's Thursday once its cutoff has passed", () => {
    const now = ny("2026-12-09", 12, 1);
    const list = offered(now);

    assert.deepEqual(days(keptDelivery(list, KEPT, now, terms)),
      days(list));
  });

  it("adds nothing for a new order or a day already on offer", () => {
    const now = ny("2026-12-03");
    const list = offered(now);

    assert.deepEqual(keptDelivery(list, null, now, terms), list);
    assert.deepEqual(keptDelivery(list, "2026-12-17", now, terms), list,
      "an order on a day on offer is shown as any other");
  });
});
