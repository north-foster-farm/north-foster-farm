// Criteria tests for #790 (farm notices name the place, in the third
// person), one per box of its "Done when" list. James approved the
// wording, option b, on PR #783 (2026-11-22): "so the site canceled
// it", and the farm's name for the place rather than the customer's
// name for the way.
//
// Held out of `npm test` until the change lands: the glob there is
// test/**/*.test.mjs. Run it alone with
//   node --import ./test/setup.mjs --test test/farm-notice-place.criteria.mjs
// and turn it on, once it passes, with
//   git mv test/farm-notice-place.criteria.mjs \
//     test/farm-notice-place.test.mjs
//
// Boxes 4 (delivery) and 6 (customer emails) guard what must not
// change and pass today; the other four fail until the change lands.
// Box 6 compares with test/farm-notice-place.customer.json, the
// customer emails as origin/next rendered them on 2026-11-22
// (6aaa4e6d), recorded from test/farm-notice-place-fixtures.mjs.
//
// Written by the place-tests agent from the criteria alone. Its
// expectations, the JSON snapshot included, are closed to the
// implementer (~/.claude/CLAUDE.md, "Tests and implementation come
// from different agents").

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { packingGroup } from "../netlify/functions/lib/describe.mjs";
import {
  farmOrderCancelled, farmRefundNeeded, farmRefundedClosed,
  farmSquareNotCompleted, farmSquareOutOfSync,
} from "../netlify/functions/lib/templates.mjs";
import {
  SCHEDULED, WAYS, customerEmails, links, order,
} from "./farm-notice-place-fixtures.mjs";

// Every farm notice that names the fulfillment, by name.
const NOTICES = {
  farmRefundNeeded: (o) => farmRefundNeeded(o, o.customer, { links }),
  farmOrderCancelled: (o) => farmOrderCancelled(o, o.customer, { links }),
  farmRefundedClosed: (o) => farmRefundedClosed(o,
    { where: "PayPal", links }),
  farmSquareOutOfSync: (o) => farmSquareOutOfSync(o, o.customer,
    { links }),
  farmSquareNotCompleted: (o) => farmSquareNotCompleted(o, { links }),
};
const each = (way) => Object.entries(NOTICES)
  .map(([name, render]) => [name, render(order(way))]);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The sentences of a notice's body that name the order: not its title,
// not a command to run.
const naming = (m) => m.text.split("\n")
  .filter((line) => line.includes("NFF-2610-ABCD") && line !== m.subject
    && !line.trim().startsWith("bin/nff"))
  .join("\n");

describe("farm notices name the place, in the third person (#790)", () => {
  it("box 1: the refunded-and-closed notice reads \"so the site " +
    "canceled it\"", () => {
    for (const way of Object.keys(WAYS)) {
      const m = NOTICES.farmRefundedClosed(order(way));

      for (const body of [m.text, m.html]) {
        assert.ok(body.includes("so the site canceled it"),
          `${way}: "so the site canceled it"`);
        assert.ok(!body.includes("so we canceled it"),
          `${way}: no "so we canceled it"`);
      }
    }
  });

  it("box 2: an on-farm pickup reads \"pickup at the farm on <date>\" " +
    "in every farm notice that names the fulfillment", () => {
    const said = `pickup at the farm on ${WAYS.onfarm.day}`;

    for (const [name, m] of each("onfarm")) {
      assert.ok(m.text.includes(said), `${name}: "${said}"`);
      assert.ok(m.html.includes(said), `${name} (HTML): "${said}"`);
    }
  });

  it("box 3: a scheduled pickup (drop site, market, pop-up, group " +
    "round) reads \"pickup at <the farm's name for the place> on " +
    "<date>\", the name taken from the same source as the packing " +
    "email's heading", () => {
    for (const way of SCHEDULED) {
      const { fulfilment, day } = WAYS[way];
      // The packing email's heading for the same fulfillment.
      const { place } = packingGroup(fulfilment);
      // Whether "the" comes before the name is left open by the box.
      const said = new RegExp(`pickup at (the )?${escape(place)} on ` +
        `${escape(day)}`);

      for (const [name, m] of each(way)) {
        assert.match(naming(m), said, `${way}, ${name}`);
        assert.ok(!/pick-up days/i.test(m.text),
          `${way}, ${name}: not the customer's "Pick-up days"`);
      }
    }
  });

  it("box 4: delivery still reads \"delivery on <date>\"", () => {
    const said = `delivery on ${WAYS.delivery.day}`;

    for (const [name, m] of each("delivery")) {
      assert.ok(naming(m).includes(said), `${name}: "${said}"`);
      assert.ok(!/pickup at/.test(m.text), `${name}: no "pickup at"`);
    }
  });

  it("box 5: an occurrence gone from the data still names no place it " +
    "can't know (it reads by its id, as the packing email does)", () => {
    const { fulfilment, day } = WAYS.gone;
    const id = fulfilment.occurrence;

    for (const [name, m] of each("gone")) {
      const line = naming(m);

      assert.match(line, new RegExp(`${escape(id)} on ${escape(day)}`),
        `${name}: read by its id, ${id}`);
      assert.doesNotMatch(line,
        /the farm|drop site|market|pop-up|pick-up days/i,
        `${name}: names no place`);
    }
  });

  it("box 6: customer emails are unchanged", () => {
    const before = JSON.parse(readFileSync(
      new URL("./farm-notice-place.customer.json", import.meta.url),
      "utf8"));

    assert.deepEqual(customerEmails(), before);
  });
});
