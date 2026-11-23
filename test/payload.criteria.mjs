// Criteria tests for #821, phase 7 of the split of order-form.js
// (docs/refactors/order-form.md, "Phase 7: fields, payload,
// restore"), held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/payload.criteria.mjs test/payload.test.mjs
//
// The thirteen criteria here are of the new-module kind: they fail on
// `next`, where form/payload.mjs does not exist, and pass once the
// phase draws it out of collect, restore, billing and syncLines. The
// fourteenth box, group-delivery-removal.test.mjs reading payload.mjs,
// is a change to a live test and goes to the implementer as a patch.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice, plain data so
// that the module stays pure; the call shape and key names may be
// adapted, the expected values may not):
//
//   buildPayload({ fields, way, picked, lines, code, pass, groupCode,
//     groupLinked, optIn, claimedTotal, formVersion, website })
//     fields  readFields' values by data-field key ("delivery.zip":
//             "02825", "customer.marketing": true, ...); "code" is
//             the code box as typed
//     way     the chosen way: "onfarm", "scheduled", "delivery" or
//             "group" (Group orders)
//     picked  the picker's value: an occurrence id or a date
//     code    the applied code's entry, or null
//     optIn   the farm list's opt-in block is shown
//     ->      the payload the page posts
//
//   restorePlan(payload, { editing, aliases, dropSeries, roundGroup })
//     ->  { fields, lines, way, want, askPass, askGroup }:
//         fields    data-field key -> value, for each value the draft
//                   holds
//         lines     [{ sku, qty }], the SKUs to set
//         way       the way to choose ("group" for a round)
//         want      { way, value, series } for the date picker
//         askPass   the pass to ask about again, or null
//         askGroup  the group code to ask about again, or null
//
//   billingOf(payload, area)          -> the card's billing details
//   lineTargets({ lines, rows, aliases })
//     rows  the SKUs of the page's rows
//     ->    { sku: qty } for every row

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import { postedDelivery } from "../assets/scripts/order/lib/posted.mjs";
import { occurrenceId } from "../assets/scripts/order/lib/scheduled.mjs";
import { zipInfo } from "../assets/scripts/order/lib/validate.mjs";
import {
  billingOf, buildPayload, lineTargets, restorePlan,
} from "../assets/scripts/order/form/payload.mjs";

const MODULE = new URL(
  "../assets/scripts/order/form/payload.mjs", import.meta.url
);

const ADDRESS = {
  address1: "1 Main St", address2: "Apt 2", town: "Foster", zip: "02825",
  cooler: "Porch", notes: "Ring twice",
};
const fields = {
  "customer.firstName": "Ada", "customer.lastName": "Hen",
  "customer.email": "ada@example.com", "customer.phone": "(401) 555-0100",
  "customer.contact": "text", "customer.marketing": true,
  "onfarm.window": "10:00-12:00",
  ...Object.fromEntries(Object.entries(ADDRESS)
    .map(([k, v]) => [`delivery.${k}`, v])),
  code: "",
};
const send = (more = {}) => buildPayload({
  fields, way: "delivery", picked: "2026-12-10",
  lines: [{ sku: "NFF-CHK-EGG-LG", qty: 2 }],
  code: null, pass: null, groupCode: null, groupLinked: false,
  optIn: true, claimedTotal: 1900, formVersion: "3", website: "",
  ...more,
});

// Box 1 of #821.
describe("buildPayload, the way", () => {
  it("posts Group orders as scheduled with its round as occurrence, and "
    + "every other way with date", () => {
    const group = send({ way: "group", picked: "pond-2026-12-12" });

    assert.equal(group.fulfilment.method, "scheduled");
    assert.equal(group.fulfilment.occurrence, "pond-2026-12-12");
    assert.equal(group.fulfilment.date, undefined);

    for (const way of ["delivery", "onfarm"]) {
      const f = send({ way, picked: "2026-12-10" }).fulfilment;

      assert.equal(f.method, way);
      assert.equal(f.date, "2026-12-10", way);
      assert.equal(f.occurrence, undefined, way);
    }

    // Pick-up days keep what they post today: the occurrence, which
    // holds the date.
    const day = send({ way: "scheduled", picked: "market-2026-12-12" });

    assert.equal(day.fulfilment.method, "scheduled");
    assert.equal(day.fulfilment.occurrence, "market-2026-12-12");
  });
});

// Box 2 of #821.
describe("buildPayload, the delivery block", () => {
  it("is postedDelivery's and never carries toGroup", () => {
    const payload = send({
      fields: { ...fields, "delivery.toGroup": true },
    });

    assert.deepEqual(payload.fulfilment.delivery, postedDelivery(ADDRESS));
    assert.ok(!("toGroup" in payload.fulfilment.delivery));
    assert.ok(!JSON.stringify(payload).includes("toGroup"));
  });
});

// Box 3 of #821.
describe("buildPayload, the code", () => {
  it("is the applied code, or else the typed one normalized", () => {
    assert.equal(send({ code: { code: "TENOFF", off: 10 },
      fields: { ...fields, code: "typed" } }).code, "TENOFF");
    assert.equal(send({ fields: { ...fields, code: " ten off! " } }).code,
      "TENOFF");
    assert.equal(send({ fields: { ...fields, code: "ab-12" } }).code,
      "AB-12");
    assert.equal(send().code, "");
  });
});

// Box 4 of #821.
describe("buildPayload, groupLink", () => {
  it("is set only with a group code that came by a link", () => {
    assert.equal(send({ groupCode: "POND22", groupLinked: true }).groupLink,
      true);
    assert.ok(!send({ groupCode: "POND22", groupLinked: false }).groupLink);
    assert.ok(!("groupLink" in send({ groupCode: null, groupLinked: true })));
    assert.ok(!("groupLink" in send()));
  });
});

// Box 5 of #821.
describe("buildPayload, marketing", () => {
  it("is false whenever the opt-in block is hidden", () => {
    assert.equal(send({ optIn: false }).customer.marketing, false);
    assert.equal(send({ optIn: false, fields: {
      ...fields, "customer.marketing": false,
    } }).customer.marketing, false);
    assert.equal(send({ optIn: true }).customer.marketing, true);
    assert.equal(send({ optIn: true, fields: {
      ...fields, "customer.marketing": false,
    } }).customer.marketing, false);
  });
});

const DROP = "drop";
const plan = (payload, more = {}) => restorePlan(payload, {
  editing: null, aliases: { "NFF-OLD-EGG": "NFF-CHK-EGG-LG" },
  dropSeries: DROP, roundGroup: null, ...more,
});
const PAID = { id: "NFF-2612-QA61", held: 6100, kept: 0 };

// Box 6 of #821.
describe("restorePlan, the old drop site", () => {
  it("turns a draft's scituate into a scheduled pickup at the drop site's "
    + "series", () => {
    const p = plan({ fulfilment: { method: "scituate", date: "2026-12-12" } });

    assert.equal(p.way, "scheduled");
    assert.equal(p.fields["fulfilment.method"], "scheduled");
    assert.deepEqual(p.want, {
      way: "scheduled", value: occurrenceId(DROP, "2026-12-12"),
      series: DROP,
    });
  });
});

// Box 7 of #821.
describe("restorePlan, the group's delivery", () => {
  it("brings a draft with the group's delivery ticked back with the "
    + "address blank and the notes kept; a paid order being changed keeps "
    + "its address", () => {
    const draft = { fulfilment: { method: "delivery", date: "2026-12-10",
      delivery: { ...ADDRESS, toGroup: true } } };
    const blank = plan(draft).fields;

    for (const key of ["address1", "address2", "town", "zip", "cooler"]) {
      assert.equal(blank[`delivery.${key}`], "", key);
    }
    assert.equal(blank["delivery.notes"], "Ring twice");

    const kept = plan(draft, { editing: PAID }).fields;

    for (const [key, value] of Object.entries(ADDRESS)) {
      assert.equal(kept[`delivery.${key}`], value, key);
    }

    // Unticked, a draft's address comes back as it was.
    const plain = plan({ fulfilment: { method: "delivery",
      delivery: ADDRESS } }).fields;

    assert.equal(plain["delivery.address1"], "1 Main St");
  });
});

// Box 8 of #821.
describe("restorePlan, the SKUs", () => {
  it("brings a draft's SKUs up to date through the aliases, and takes a "
    + "paid order's as they are", () => {
    const payload = { lines: [
      { sku: "NFF-OLD-EGG", qty: 2 }, { sku: "NFF-CHK-WNG", qty: 1 },
    ] };

    assert.deepEqual(plan(payload).lines, [
      { sku: "NFF-CHK-EGG-LG", qty: 2 }, { sku: "NFF-CHK-WNG", qty: 1 },
    ]);
    assert.deepEqual(plan(payload, { editing: PAID }).lines, payload.lines);
  });
});

// Box 9 of #821.
describe("restorePlan, a group's round", () => {
  it("chooses Group orders for a draft's round of the offered group", () => {
    const round = { fulfilment: { method: "scheduled",
      occurrence: "pond-2026-12-12" } };
    const offered = plan(round, { roundGroup: { series: "pond" } });

    assert.equal(offered.way, "group");
    assert.equal(offered.fields["fulfilment.method"], "group");

    for (const roundGroup of [null, { series: "lake" }]) {
      const other = plan(round, { roundGroup });

      assert.equal(other.way, "scheduled");
      assert.equal(other.fields["fulfilment.method"], "scheduled");
    }
  });
});

// Box 10 of #821.
describe("restorePlan, asking again", () => {
  it("asks about a draft's pass and group code again, and about neither "
    + "for a paid order being changed", () => {
    const payload = { pass: "ABCD-1234", groupCode: "pond22" };

    assert.equal(plan(payload).askPass, "ABCD-1234");
    assert.equal(plan(payload).askGroup, "pond22");

    const changing = plan(payload, { editing: PAID });

    assert.ok(!changing.askPass);
    assert.ok(!changing.askGroup);
    assert.ok(!plan({}).askPass);
    assert.ok(!plan({}).askGroup);
  });
});

// Box 11 of #821.
describe("restorePlan, what the draft lacks", () => {
  it("leaves a field alone for a value the draft lacks", () => {
    const p = plan({
      customer: { firstName: "Ada", lastName: null },
      fulfilment: { method: "onfarm", date: "2026-12-12", onfarm: {} },
    });

    assert.equal(p.fields["customer.firstName"], "Ada");
    for (const key of ["customer.lastName", "customer.email",
      "customer.phone", "customer.contact", "code", "delivery.address1",
      "delivery.notes"]) {
      assert.ok(!(key in p.fields), key);
    }
    assert.ok(!("fulfilment.method" in plan({}).fields));
  });
});

// Box 12 of #821.
describe("billingOf", () => {
  it("carries the address only for a delivery, with the state its ZIP "
    + "belongs to", () => {
    const customer = { firstName: "Ada", lastName: "Hen",
      email: "ada@example.com", phone: "4015550100" };
    const delivered = billingOf({ customer, fulfilment: {
      method: "delivery", delivery: ADDRESS,
    } }, terms.area);

    assert.deepEqual(delivered, {
      ...customer, address1: "1 Main St", address2: "Apt 2",
      town: "Foster", zip: "02825",
      state: zipInfo("02825", terms.area).state.code,
    });

    for (const method of ["onfarm", "scheduled"]) {
      assert.deepEqual(billingOf({ customer, fulfilment: {
        method, delivery: ADDRESS,
      } }, terms.area), {
        ...customer, address1: "", address2: "", town: "", zip: "",
        state: "",
      }, method);
    }
  });
});

// Box 13 of #821.
describe("lineTargets", () => {
  it("gives each row its quantity from the saved lines, 0 to 99, and 0 for "
    + "a row the lines lack", () => {
    const rows = ["NFF-CHK-EGG-LG", "NFF-CHK-WNG", "NFF-CHK-THG"];

    assert.deepEqual(lineTargets({
      rows, aliases: { "NFF-OLD-EGG": "NFF-CHK-EGG-LG" },
      lines: [{ sku: "NFF-OLD-EGG", qty: 3 }, { sku: "NFF-CHK-WNG",
        qty: 250 }, { sku: "NFF-GONE", qty: 4 }],
    }), { "NFF-CHK-EGG-LG": 3, "NFF-CHK-WNG": 99, "NFF-CHK-THG": 0 });
    assert.deepEqual(lineTargets({ rows, aliases: {}, lines: [] }),
      { "NFF-CHK-EGG-LG": 0, "NFF-CHK-WNG": 0, "NFF-CHK-THG": 0 });
    assert.deepEqual(lineTargets({ rows: ["A"], aliases: {},
      lines: [{ sku: "A", qty: -2 }] }), { A: 0 });
  });
});

describe("design, phase 7", () => {
  it("keeps form/payload.mjs pure", () => {
    const code = readFileSync(MODULE, "utf8")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    assert.doesNotMatch(code,
      /(?<![.\w])(document|window)\.|\b(querySelector|Element)\b/);
  });
});
