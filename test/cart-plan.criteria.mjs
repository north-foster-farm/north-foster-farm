// Criteria tests for #852, phase 2 of the split of cart/cart.js
// (docs/refactors/cart.md, "Phase 2: drawing"), held out of `npm
// test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/cart-plan.criteria.mjs test/cart-plan.test.mjs
//
// The seven criteria here are of the new-module kind: they fail on
// `next`, where cart/plan.mjs does not exist, and pass once the phase
// draws it out. The eighth box, remove-icon.test.mjs reading
// lines-view.js, is not in this file: it is a change to an existing
// test, delivered as a patch (see the test agent's report).
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice, plain data so
// that the module stays pure; the call shape may be adapted, the
// expected values may not). Money is in cents, as lib/totals.mjs's
// dollars() takes it; the words are today's, byte for byte.
//
//   changed({ next, was, lines, drawn, nudge, nudgeShown })
//     next, was    state.mjs records, after and before the render
//     lines        the summary's groups
//     drawn        the groups the cart last drew
//     nudge        the summary's nudge text ("" for none)
//     nudgeShown   whether the nudge shows now
//     ->           whether the render moves the pane
//
//   readoutLabels({ countText, total })  -> { link, pill }
//
//   editMoney({ held, kept, keptDate, total })
//     -> { paid, kept, keptLabel, dueLabel, due }, each the text
//        shown; kept and keptLabel only matter when a fee was kept
//
//   wayButtons({ method, ways, choices })
//     method   the way the page holds
//     ways     the form's: way -> false when it cannot be picked,
//              and `name` for a way the switch lacks
//     choices  the switch's buttons, [{ way, name }]
//     ->       { buttons: [{ way, pressed, disabled }], name }
//
//   passedBy({ placement, short, slotBottom })  -> boolean
//   tierKeys(money)                             -> badge keys
//   deliveryTip(tip, money)                     -> the tip
//     money  moneyOn()'s for the day (bulkTiers, deliveryMinimum)
//
// The test of purity comes from the design's module table (section
// 2: plan.mjs is listed as pure), not from a box.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import { dollars } from "../assets/scripts/order/lib/totals.mjs";
import { label } from "../assets/scripts/order/lib/zoned.mjs";
import {
  changed, deliveryTip, editMoney, passedBy, readoutLabels, tierKeys,
  wayButtons,
} from "../assets/scripts/order/cart/plan.mjs";

const PLAN = new URL("../assets/scripts/order/cart/plan.mjs", import.meta.url);

// Box 1 of #852.
describe("changed", () => {
  it("is true when the fold or the emptiness changes, when the lines "
    + "differ from those drawn, and when the nudge comes or goes; "
    + "otherwise false", () => {
    const at = {
      placement: "floating", fold: "closed", empty: false, share: "",
      shutByScroll: false, kept: false,
    };
    const lines = [{ label: "Eggs", items: [{ sku: "A", qtyText: "2" }] }];
    const same = {
      next: { ...at }, was: at, lines, drawn: structuredClone(lines),
      nudge: "", nudgeShown: false,
    };

    assert.equal(changed(same), false, "nothing changes");
    assert.equal(
      changed({ ...same, nudge: "Add more", nudgeShown: true }), false,
      "a nudge that stays"
    );
    assert.equal(
      changed({ ...same, next: { ...at, share: "way" } }), false,
      "only the shared row"
    );

    assert.equal(changed({ ...same, next: { ...at, fold: "open" } }), true,
      "the fold");
    assert.equal(changed({ ...same, next: { ...at, empty: true } }), true,
      "the emptiness");
    assert.equal(
      changed({
        ...same,
        lines: [{ label: "Eggs", items: [{ sku: "A", qtyText: "3" }] }],
      }),
      true, "the lines"
    );
    assert.equal(changed({ ...same, lines: [] }), true, "the lines go");
    assert.equal(changed({ ...same, nudge: "Add more" }), true,
      "the nudge comes");
    assert.equal(changed({ ...same, nudgeShown: true }), true,
      "the nudge goes");
  });
});

// Box 2 of #852.
describe("readoutLabels", () => {
  it("gives the bars' link \"N items, total $X. Go to the cart.\" and the "
    + "pill \"N items, total $X. Show or hide the cart.\"", () => {
    assert.deepEqual(readoutLabels({ countText: "3 items", total: "$42.50" }),
      {
        link: "3 items, total $42.50. Go to the cart.",
        pill: "3 items, total $42.50. Show or hide the cart.",
      });
    const one = readoutLabels({ countText: "1 item", total: "$7" });

    assert.equal(one.link, "1 item, total $7. Go to the cart.");
    assert.equal(one.pill, "1 item, total $7. Show or hide the cart.");
  });
});

// Box 3 of #852.
describe("editMoney", () => {
  it("gives what is paid, the kept fee with its day, and \"You pay\" or "
    + "\"We refund\" with the difference, never negative", () => {
    const keptDate = "2026-11-19";
    const more = editMoney({ held: 5000, kept: 500, keptDate, total: 6000 });

    assert.equal(more.paid, dollars(5000));
    assert.equal(more.kept, `−${dollars(500)}`);
    assert.equal(more.keptLabel, `Delivery fee for the trip on ${
      label(keptDate)}`);
    assert.equal(more.dueLabel, "You pay");
    assert.equal(more.due, dollars(1500));

    const less = editMoney({ held: 5000, kept: 500, keptDate, total: 3000 });

    assert.equal(less.dueLabel, "We refund");
    assert.equal(less.due, dollars(1500));

    const none = editMoney({
      held: 4000, kept: 0, keptDate: null, total: 4000,
    });

    assert.equal(none.paid, dollars(4000));
    assert.equal(none.dueLabel, "You pay");
    assert.equal(none.due, dollars(0));

    const back = editMoney({
      held: 4000, kept: 0, keptDate: null, total: 2550,
    });

    assert.equal(back.dueLabel, "We refund");
    assert.equal(back.due, dollars(1450));
    assert.doesNotMatch(back.due, /[-−]/);
  });
});

// Box 4 of #852.
describe("wayButtons", () => {
  it("presses the way the page holds, disables a way that cannot be "
    + "picked, and names the button by that way, by the form's name for "
    + "a way the switch lacks, or \"Pickup or delivery\"", () => {
    const choices = [
      { way: "onfarm", name: "On-farm pickup" },
      { way: "scheduled", name: "Pick-up days" },
      { way: "delivery", name: "Delivery" },
    ];
    const pressed = (r) => r.buttons.filter((b) => b.pressed).map((b) => b.way);
    const disabled = (r) => r.buttons.filter((b) => b.disabled)
      .map((b) => b.way);

    const held = wayButtons({
      method: "delivery", ways: { onfarm: false }, choices,
    });

    assert.deepEqual(pressed(held), ["delivery"]);
    assert.deepEqual(disabled(held), ["onfarm"]);
    assert.equal(held.name, "Delivery");
    assert.deepEqual(held.buttons.map((b) => b.way),
      ["onfarm", "scheduled", "delivery"]);

    // Only false disables: a way the form says nothing of stays open.
    assert.deepEqual(disabled(wayButtons({
      method: "scheduled", ways: { onfarm: true, delivery: false }, choices,
    })), ["delivery"]);

    const group = wayButtons({
      method: "group", ways: { name: "Group orders" }, choices,
    });

    assert.deepEqual(pressed(group), []);
    assert.equal(group.name, "Group orders");

    const none = wayButtons({ method: "", ways: {}, choices });

    assert.deepEqual(pressed(none), []);
    assert.equal(none.name, "Pickup or delivery");
  });
});

// Box 5 of #852.
describe("passedBy", () => {
  it("is true only for a settled cart on a screen that is not short, "
    + "whose foot has come within 60 px of the screen's top", () => {
    const settled = { placement: "inline", short: false };

    assert.equal(passedBy({ ...settled, slotBottom: 59 }), true);
    assert.equal(passedBy({ ...settled, slotBottom: 10 }), true);
    assert.equal(passedBy({ ...settled, slotBottom: -400 }), true);
    assert.equal(passedBy({ ...settled, slotBottom: 61 }), false);
    assert.equal(passedBy({ ...settled, slotBottom: 500 }), false);

    assert.equal(passedBy({ ...settled, short: true, slotBottom: 10 }), false,
      "a short screen");
    for (const placement of ["floating", "column"]) {
      assert.equal(passedBy({ placement, short: false, slotBottom: 10 }),
        false, placement);
    }
  });
});

// Box 6 of #852.
describe("tierKeys", () => {
  it("lists the badge keys of the day's bulk tiers", () => {
    assert.deepEqual(tierKeys(terms.money),
      terms.money.bulkTiers.map((t) => `tier-${t.threshold}`));
    assert.deepEqual(
      tierKeys({ ...terms.money, bulkTiers: terms.money.bulkTiers.slice(1) }),
      terms.money.bulkTiers.slice(1).map((t) => `tier-${t.threshold}`)
    );
    assert.deepEqual(tierKeys({ ...terms.money, bulkTiers: [] }), []);
  });
});

// Box 7 of #852.
describe("deliveryTip", () => {
  it("puts the day's minimum into the delivery badge's tip", () => {
    // The badge's tip as cart.html writes it, from the page's terms.
    const { deliveryMinimum: built, deliveryFee, feeWaivedAt } = terms.money;
    const rest = ` or more after discounts can be delivered on Thursdays. $${
      deliveryFee} fee, waived at $${feeWaivedAt}.`;
    const tip = `Orders of $${built}${rest}`;
    const day = { ...terms.money, deliveryMinimum: built + 10 };

    assert.equal(deliveryTip(tip, day), `Orders of $${built + 10}${rest}`);
    assert.equal(deliveryTip(tip, terms.money), tip);
  });
});

describe("design, section 2", () => {
  it("keeps cart/plan.mjs pure", () => {
    const dom = new RegExp(`\\b(${[
      "document", "window", "getComputedStyle", "matchMedia",
      "requestAnimationFrame", "performance", "Element", "Node",
    ].join("|")})\\b`);
    const code = readFileSync(PLAN, "utf8")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    assert.doesNotMatch(code, dom, "plan.mjs reaches the DOM");
    for (const [, from] of code.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      assert.match(from, /\.mjs$/, `plan.mjs imports ${from}`);
    }
  });
});
