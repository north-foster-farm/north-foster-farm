// Criteria test for #627, held out of `npm test` until the code
// changes: the countdown names the date it counts down to.
//
// Turn it on, in the commit that changes the code:
//   git mv test/countdown-date.criteria.mjs test/countdown-date.test.mjs
// It then runs in `npm test` with the rest. Nothing else retires: the
// old sentence's one e2e assertion (forms.spec.mjs, "the delivery
// countdown names the next delivery day") moved to
// e2e/countdown-date.spec.mjs in the same commit as this file.
//
// Contract (the seam; no pure function builds the sentence today):
//   name    DateLists#apply(lists), the class's own entry point for
//           an /api/dates answer
//   module  assets/scripts/order/date-lists.js
//   inputs  a form whose querySelector finds [data-countdown] (the
//           chip) and [data-countdown-text] (its text), and `lists`,
//           /api/dates's JSON: `now` (the server's clock, which the
//           page anchors to), `delivery` (lib/dates.mjs entries:
//           date, label, cutoff), `scheduled`
//   output  the text's textContent, the notice as the customer reads
//           it
//
// Only delivery has a countdown: the notice sits in the Delivery body
// of layouts/partials/order/fulfilment.html, and neither pickup way
// has one. "Every method it serves" is delivery alone.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import { DateLists } from "../assets/scripts/order/date-lists.js";
import { deliveryDates } from "../assets/scripts/order/lib/dates.mjs";

const made = [];

// A form holding only the countdown's chip and text.
const notice = () => {
  const chip = { dataset: {} };
  const text = { textContent: "" };
  const form = {
    querySelector: (sel) => ({
      "[data-countdown]": chip,
      "[data-countdown-text]": text,
    })[sel] || null,
    querySelectorAll: () => [],
  };

  return { form, chip, text };
};

// The notice once /api/dates answers at `now`, the delivery days
// those the site offers then.
const at = (now) => {
  const { form, text } = notice();
  const lists = new DateLists(form, () => {});
  const delivery = deliveryDates(new Date(now), terms);

  made.push(lists);
  lists.apply({ now, delivery, onfarm: [], scheduled: [] });

  return { text: text.textContent, first: delivery[0] };
};

afterEach(() => {
  for (const lists of made.splice(0)) {
    clearTimeout(lists.timer);
    clearTimeout(lists.closing);
    clearTimeout(lists.again);
  }
});

describe("the countdown names its date (#627)", () => {
  // Each `now` sits 30 s past a whole minute, so the milliseconds the
  // test itself takes never round a minute away.
  it("names the date of the day it counts down to, for every method "
    + "it serves", () => {
    // James's screenshot on #626: Wednesday 18 November, 6:09 AM.
    const wed = at("2026-11-18T11:09:30.000Z");

    assert.equal(wed.text, "Order within 5 hours and 50 minutes for "
      + "delivery on Thursday, November 19.");
    assert.ok(wed.text.endsWith(` on ${wed.first.label}.`),
      "the date is written the way the select writes it");

    // Days out, the same Thursday by its date.
    const mon = at("2026-11-16T14:59:30.000Z");

    assert.equal(mon.text, "Order within 2 days, 2 hours, and 0 minutes "
      + "for delivery on Thursday, November 19.");

    // Past the 19th's cutoff, Thanksgiving week skipped: the next
    // Thursday on offer is named by its own date.
    const late = at("2026-11-18T17:29:30.000Z");

    assert.equal(late.first.date, "2026-12-03");
    assert.equal(late.text, "Order within 13 days, 23 hours, and 30 "
      + "minutes for delivery on Thursday, December 3.");

    for (const { text } of [wed, mon, late]) {
      assert.doesNotMatch(text, /\b20\d\d\b/, "no year");
    }
  });
});
