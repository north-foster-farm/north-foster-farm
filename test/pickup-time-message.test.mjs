// Criteria test for #706 (Proceed to checkout says why, and goes to
// what is missing), the box James added on 2026-11-21: on submit,
// validate.mjs says "Please select a pickup time." too, as Proceed
// to checkout does. Held out of `npm test` by its name; the
// implementer turns it on by renaming it
// test/pickup-time-message.test.mjs.
//
// It relies on validateOrder's error key for a missing on-farm time,
// "onfarm.window" (assets/scripts/order/lib/validate.mjs).

import assert from "node:assert/strict";
import { it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import terms from "../netlify/functions/lib/terms.mjs";
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import {
  validateOrder,
} from "../assets/scripts/order/lib/validate.mjs";
import {
  parseSchedule,
} from "../assets/scripts/order/lib/schedule.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

const ctx = {
  index: indexCatalog(catalog),
  terms,
  now: instant("2026-10-06", 9, 0, "America/New_York"),
  schedule: parseSchedule(SCHEDULE).windows,
};

const order = (onfarm) => ({
  customer: {
    firstName: "Pat", lastName: "Example", email: "pat@example.com",
    phone: "401-555-0100", contact: "text",
  },
  lines: [{ sku: "NFF-CHK-WHL-35-39", qty: 2 }],
  fulfilment: { method: "onfarm", date: "2026-10-07", onfarm },
});

it("On submit, the order form's own validation (validate.mjs) says " +
  "\"Please select a pickup time.\" too, not \"Choose a pickup time.\"",
() => {
  // No time, an empty one and no on-farm part at all: each is a
  // pickup time not chosen.
  for (const onfarm of [{}, { window: "" }, undefined]) {
    const r = validateOrder(order(onfarm), ctx);

    assert.equal(r.ok, false);
    assert.equal(r.errors["onfarm.window"], "Please select a pickup time.",
      `onfarm ${JSON.stringify(onfarm)}`);
  }
});
