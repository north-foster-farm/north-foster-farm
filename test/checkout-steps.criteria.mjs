// Criteria tests for #826, phase 12 of the split of order-form.js
// (docs/refactors/order-form.md, "Phase 12: checking and the way to
// Pay"), held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/checkout-steps.criteria.mjs test/checkout-steps.test.mjs
//
// All six criteria are of the new-module kind: they fail on `next`,
// where form/checkout.mjs does not exist, and pass once the phase
// draws the decisions out of proceed, check, lapse and useLapsed.
// Nothing retires.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice, plain data so
// that the module stays pure; the call shape and key names may be
// adapted, the expected values may not). The words are today's, byte
// for byte.
//
//   nextStep(errors)
//     errors  validateOrder's, by field key ({} for none)
//     ->      { step: "way" | "contact" | "payment", errors }
//   roundWording({ errors, way, occurrence })
//     way         the chosen way ("group" for Group orders)
//     occurrence  the posted occurrence, or "" for none
//     ->          the errors, reworded
//   lapseList({ way, lists, dates })
//     lists  the page's lists ({ group, scheduled, ... })
//     dates  the dates the server sent with its 409
//     ->     what the dialog offers
//   lapsedStatus({ method, day, roundLabel, times, place })
//     day         the new day's label ("Saturday, December 12")
//     roundLabel  the round's own label, for a group
//     times       the window, for on-farm pickup
//     place       "at ...", for a pickup day
//     ->          the line by Pay

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  lapseList, lapsedStatus, nextStep, roundWording,
} from "../assets/scripts/order/form/checkout.mjs";

const MODULE = new URL(
  "../assets/scripts/order/form/checkout.mjs", import.meta.url
);
const WAY = {
  "fulfilment.date": "Choose a delivery day.",
  "onfarm.window": "Choose a pick-up time.",
  "delivery.zip": "Enter your ZIP code.",
};
const CONTACT = {
  "customer.email": "Enter your email address.",
  "customer.phone": "Enter your phone number.",
};

// Box 1 of #826.
describe("nextStep, the way", () => {
  it("with an error under fulfilment., onfarm. or delivery. is the way, "
    + "with only those errors", () => {
    assert.deepEqual(nextStep({ ...WAY, ...CONTACT }),
      { step: "way", errors: WAY });
    for (const [key, words] of Object.entries(WAY)) {
      assert.deepEqual(nextStep({ [key]: words, ...CONTACT }),
        { step: "way", errors: { [key]: words } }, key);
    }
  });
});

// Box 2 of #826.
describe("nextStep, contact", () => {
  it("with none of those and an error under customer. is the contact "
    + "section, with only those", () => {
    assert.deepEqual(nextStep({ ...CONTACT, total: "The total changed." }),
      { step: "contact", errors: CONTACT });
  });
});

// Box 3 of #826.
describe("nextStep, payment", () => {
  it("with neither is the payment", () => {
    assert.equal(nextStep({}).step, "payment");
    assert.equal(nextStep({ total: "The total changed." }).step, "payment");
  });
});

// Box 4 of #826.
describe("roundWording", () => {
  it("rewords a missing occurrence as \"Choose a group order date.\" only "
    + "when Group orders is chosen", () => {
    const missing = { "fulfilment.occurrence": "Choose a pick-up day.",
      ...CONTACT };

    assert.deepEqual(
      roundWording({ errors: missing, way: "group", occurrence: "" }),
      { ...missing, "fulfilment.occurrence": "Choose a group order date." }
    );
    assert.deepEqual(
      roundWording({ errors: missing, way: "scheduled", occurrence: "" }),
      missing, "Pick-up days"
    );
    assert.deepEqual(
      roundWording({ errors: missing, way: "group",
        occurrence: "36TS-2026-12-06" }),
      missing, "a round was posted"
    );
    assert.deepEqual(
      roundWording({ errors: CONTACT, way: "group", occurrence: "" }),
      CONTACT, "no occurrence error"
    );
  });
});

// Box 5 of #826.
describe("lapseList", () => {
  it("offers a lapsed round the group's open rounds, a lapsed pickup day "
    + "the other pickups, and any other way the dates the server sent", () => {
    const lists = {
      group: [{ id: "36TS-2026-12-20" }],
      scheduled: [{ id: "WAC5-2026-12-13" }, { id: "H3TQ-2026-12-15" }],
      delivery: [{ date: "2026-12-17" }],
    };
    const dates = [{ date: "2026-12-24" }];

    assert.deepEqual(lapseList({ way: "group", lists, dates }), lists.group);
    assert.deepEqual(lapseList({ way: "scheduled", lists, dates }),
      lists.scheduled);
    for (const way of ["delivery", "onfarm"]) {
      assert.deepEqual(lapseList({ way, lists, dates }), dates, way);
    }
  });
});

// Box 6 of #826.
describe("lapsedStatus", () => {
  it("names the new day, with the round's own label for a group, the "
    + "times for on-farm pickup, the place for a pickup day, and ends "
    + "\"Pay again to place your order.\"", () => {
    const day = "Saturday, December 12";
    const end = ". Pay again to place your order.";

    assert.equal(lapsedStatus({ method: "group", day,
      roundLabel: "Sunday, December 20" }),
    `Your group order is now for Sunday, December 20${end}`);
    assert.equal(lapsedStatus({ method: "group", day, roundLabel: "" }),
      `Your group order is now for ${day}${end}`, "no label: the day");
    assert.equal(lapsedStatus({ method: "onfarm", day,
      times: "10:00 AM – 12:00 PM" }),
    `Pickup is now ${day}, 10:00 AM – 12:00 PM${end}`);
    assert.equal(lapsedStatus({ method: "scheduled", day,
      place: "9:00 AM – 1:00 PM, at Foster Farmers’ Market" }),
    `Pickup is now ${day}, 9:00 AM – 1:00 PM, at Foster Farmers’ Market${
      end}`);
    assert.equal(lapsedStatus({ method: "delivery", day }),
      `Delivery is now ${day}${end}`);
  });
});

describe("design, phase 12", () => {
  it("keeps form/checkout.mjs pure", () => {
    const code = readFileSync(MODULE, "utf8")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    assert.doesNotMatch(code,
      /(?<![.\w])(document|window)\.|\b(querySelector|Element)\b/);
  });
});
