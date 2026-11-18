// Criteria tests for #626: the "Deliver to <group>" option comes off
// the order page and is parked on `parked/group-delivery`. Written
// from the spec before the change, so they fail until it lands.
//
// Held out of `npm test` by its name. The change that meets them turns
// them on, in the same commit:
//
//   git mv test/group-delivery-removal.criteria.mjs \
//     test/group-delivery-removal.test.mjs
//   git rm test/group-delivery-offer.test.mjs
//
// group-delivery-offer.test.mjs holds the #471 tests these supersede
// (the cart readers carrying the tick); the test agent that wrote both
// files authorizes its removal with this rename and no other change.
//
// The page itself (no option offered, a ticked draft restored as an
// ordinary delivery) is e2e/group-delivery-removed.spec.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  carryOf, cartOf,
} from "../assets/scripts/order/lib/cart-sync.mjs";
import { groupOf } from "../netlify/functions/lib/groups.mjs";
import terms from "../netlify/functions/lib/terms.mjs";

const GYM = terms.model.location(groupOf("vff").location);

// A member's draft saved with the option ticked, as the page saved it
// at launch: the address fields filled from the group's place.
const ticked = (method = "delivery") => ({
  formVersion: "1",
  customer: {
    firstName: "Pat", lastName: "Example", email: "pat@example.com",
    phone: "401-555-0100", contact: "text",
  },
  lines: [{ sku: "NFF-CHK-WHL-35-39", qty: 3 }],
  fulfilment: {
    method, date: "2026-11-05",
    delivery: {
      toGroup: true, address1: GYM.street, address2: "", town: GYM.city,
      zip: GYM.zip, cooler: `The cooler at ${GYM.name}`, notes: "",
    },
  },
  groupCode: "GYM2026",
});

describe("#626 criterion 2", () => {
  it("a saved cart or draft with the option ticked loads as an " +
    "ordinary delivery", () => {
    // The account's copy of the cart, which another device restores.
    const cart = cartOf(ticked());
    const d = cart.fulfilment.delivery;

    assert.equal(cart.fulfilment.method, "delivery", "still a delivery");
    assert.equal(cart.fulfilment.date, "2026-11-05", "on its day");
    assert.notEqual(d.toGroup, true, "nothing ticked");
    for (const key of ["address1", "town", "zip"]) {
      assert.notEqual(d[key], GYM[{ address1: "street", town: "city",
        zip: "zip" }[key]], `no group address in ${key}`);
    }
    assert.doesNotMatch(d.cooler || "", new RegExp(GYM.name),
      "no group cooler line");
    assert.deepEqual(cart.lines, [{ sku: "NFF-CHK-WHL-35-39", qty: 3 }],
      "the cart itself is kept");

    // What a sign-in link carries to another browser (#521).
    const carried = carryOf({ savedAt: 1, payload: ticked() });

    assert.equal(carried.payload.fulfilment.method, "delivery");
    assert.notEqual(
      carried.payload.fulfilment.delivery
        && carried.payload.fulfilment.delivery.toGroup,
      true, "a sign-in link carries no tick");

    const scheduled = carryOf({ savedAt: 1, payload: ticked("scheduled") });

    assert.notEqual(
      scheduled.payload.fulfilment.delivery
        && scheduled.payload.fulfilment.delivery.toGroup,
      true, "nor with another way chosen");
  });
});

// The paragraphs of a Markdown file: blank-line blocks, and each list
// item on its own.
const paragraphs = (file) => readFileSync(new URL(`../${file}`,
  import.meta.url), "utf8")
  .split(/\n\s*\n|\n(?=\s*[-*] |\s*\d+\. )/)
  .map((p) => p.replace(/\s+/g, " ").trim())
  .filter(Boolean);

// A paragraph about the option: delivering to the group's place.
const ABOUT = new RegExp([
  "deliver(y|ed)? to (the|a) group", "deliver to <group>", "toGroup",
  "delivery-to-group", "left in the (gym's )?cooler", "group's cooler",
  "gym's cooler",
].join("|"), "i");

describe("#626 criterion 5", () => {
  it("the docs say the option is parked", () => {
    for (const file of ["docs/group-host-guide.md", "docs/order-form.md"]) {
      const all = paragraphs(file);

      assert.ok(all.some((p) => p.includes("parked/group-delivery")),
        `${file} says where the option is parked`);
      for (const p of all.filter((x) => ABOUT.test(x))) {
        assert.match(p, /parked/i,
          `${file} describes the option as available: "${p}"`);
      }
    }
  });
});
