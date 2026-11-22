// Criteria tests for #815, phase 1 of the split of order-form.js
// (docs/refactors/order-form.md, "Phase 1: helpers and the section
// spy"), held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/section-pick.criteria.mjs test/section-pick.test.mjs
//
// All six criteria are of the new-module kind: they fail on `next`,
// where form/section-pick.mjs does not exist, and pass once the phase
// draws it out of watchSections. Nothing retires: sections.test.mjs
// tests lib/sections.mjs, which does not move.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice, plain data so
// that the module stays pure; the call shape may be adapted, the
// expected values may not). Positions are px from the screen's top,
// as getBoundingClientRect gives them.
//
//   barEdge(bars)
//     bars  [{ shown, top, bottom }]: shown is false for a bar with
//           no offsetParent or at opacity 0
//     ->    the edge in px
//
//   pickSection({ sections, line, end, screen, column })
//     sections  [{ key, top, shown, stuck, cart }], in the outline's
//               order: `cart` marks the cart's section (its top is
//               its heading's), `stuck` a section stuck at the top
//     line      where a section's top must reach
//     end       the page is scrolled to its foot
//     screen    the screen's height
//     column    the cart is a column (xl)
//     ->        the current section's key, or null
//
//   inCatalog({ given, catalog, rows, edge, screen })
//     given    the key pickSection chose, the catalog or a category
//     catalog  the catalog's own key
//     rows     the catalog's rows, top to bottom: [{ cat, top, bottom }]
//     edge     barEdge's
//     ->       the key to show
//
//   barTitle({ name, cat, phone })
//     name   the section's name
//     cat    the section is a category
//     phone  the title is the phone's bar (.order-topbar)
//     ->     the bar's text
//
// The test of purity comes from the design (section-pick.mjs is the
// choice "drawn out" of the DOM watcher), not from a box.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  barEdge, barTitle, inCatalog, pickSection,
} from "../assets/scripts/order/form/section-pick.mjs";

const MODULE = new URL(
  "../assets/scripts/order/form/section-pick.mjs", import.meta.url
);

// Box 1 of #815.
describe("barEdge", () => {
  it("returns the lowest bottom edge among the bars that are shown and "
    + "stuck (top within 1 px of the screen's top), and 0 when there is "
    + "none", () => {
    const bar = (top, bottom, shown = true) => ({ shown, top, bottom });

    assert.equal(barEdge([bar(0, 56)]), 56);
    assert.equal(barEdge([bar(0, 56), bar(0.5, 104)]), 104);
    assert.equal(barEdge([bar(0, 104), bar(1, 56)]), 104);
    assert.equal(barEdge([bar(1, 72)]), 72, "within 1 px");

    // Not stuck: further down the page than 1 px.
    assert.equal(barEdge([bar(2, 58)]), 0);
    assert.equal(barEdge([bar(0, 56), bar(300, 356)]), 56);
    // Not shown.
    assert.equal(barEdge([bar(0, 56, false)]), 0);
    assert.equal(barEdge([bar(0, 104, false), bar(0, 56)]), 56);
    // None.
    assert.equal(barEdge([]), 0);
  });
});

const section = (key, top, more = {}) => ({
  key, top, shown: true, stuck: false, cart: false, ...more,
});
const at = { line: 80, end: false, screen: 800, column: false };

// Box 2 of #815.
describe("pickSection, passing over", () => {
  it("passes over a section that is stuck, one that is not shown, and the "
    + "cart when the cart is a column", () => {
    const sections = [
      section("catalog", -900),
      section("rail", 20, { stuck: true }),
      section("hidden", 0, { shown: false }),
      section("cart", 40, { cart: true }),
    ];

    assert.equal(pickSection({ ...at, sections, column: true }), "catalog");
    assert.equal(pickSection({ ...at, sections }), "cart",
      "the cart counts once it is not a column");
    assert.equal(
      pickSection({ ...at, sections: sections.slice(0, 3) }), "catalog"
    );
  });
});

// Box 3 of #815.
describe("pickSection, the line", () => {
  it("makes a section current once its top reaches the line; of two that "
    + "have, the lower one wins, and on a tie the later link", () => {
    const pick = (sections) => pickSection({ ...at, sections });

    // Below the line: not yet.
    assert.equal(pick([section("a", 81)]), null);
    assert.equal(pick([section("a", 80)]), "a");
    assert.equal(pick([section("a", -400), section("b", 120)]), "a");

    // Both reached it: the lower one, whichever comes first.
    assert.equal(pick([section("a", -400), section("b", 40)]), "b");
    assert.equal(pick([section("b", 40), section("a", -400)]), "b");

    // A tie: the later link.
    assert.equal(pick([section("catalog", 10), section("cat-eggs", 10)]),
      "cat-eggs");
  });
});

// Box 4 of #815.
describe("pickSection, the foot", () => {
  it("at the foot of the page lets the last section on screen win, though "
    + "its top never reached the line", () => {
    const sections = [
      section("a", -600), section("b", 200), section("c", 640),
    ];

    assert.equal(pickSection({ ...at, sections }), "a");
    assert.equal(pickSection({ ...at, sections, end: true }), "c");
    assert.equal(pickSection({
      ...at, end: true,
      sections: [...sections.slice(0, 2), section("c", 820)],
    }), "b", "the last on screen, not one below it");
  });
});

// Box 5 of #815.
describe("inCatalog", () => {
  it("names the category of the first row showing below the bar when that "
    + "row is on screen, the catalog itself when every row has gone above "
    + "the bar, and otherwise keeps the section it was given", () => {
    const edge = 120;
    const screen = 800;
    const row = (cat, top) => ({ cat, top, bottom: top + 96 });
    const ask = (given, rows) => inCatalog({
      given, catalog: "catalog", rows, edge, screen,
    });

    // The first row with more than a sliver below the bar names it.
    const rows = [row("cat-tenders", -200), row("cat-wings", 200)];

    assert.equal(ask("catalog", rows), "cat-wings");
    assert.equal(ask("cat-tenders", rows), "cat-wings");

    // Every row above the bar: the catalog itself.
    assert.equal(
      ask("cat-wings", [row("cat-tenders", -400), row("cat-wings", -150)]),
      "catalog"
    );

    // The first showing row is below the screen: the section stays.
    assert.equal(ask("cat-tenders", [row("cat-wings", 900)]), "cat-tenders");
  });
});

// Box 6 of #815.
describe("barTitle", () => {
  it("gives the phone bar a category's name or nothing, and the other bars "
    + "the section's name", () => {
    assert.equal(barTitle({ name: "Eggs", cat: true, phone: true }), "Eggs");
    assert.equal(barTitle({ name: "Your details", cat: false, phone: true }),
      "");
    assert.equal(barTitle({ name: "Eggs", cat: true, phone: false }), "Eggs");
    assert.equal(
      barTitle({ name: "Your details", cat: false, phone: false }),
      "Your details"
    );
  });
});

describe("design, phase 1", () => {
  it("keeps form/section-pick.mjs pure", () => {
    const dom = new RegExp(`\\b(${[
      "document", "window", "getComputedStyle", "matchMedia",
      "requestAnimationFrame", "getBoundingClientRect", "performance",
      "Element", "Node",
    ].join("|")})\\b`);
    const code = readFileSync(MODULE, "utf8")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    assert.doesNotMatch(code, dom, "section-pick.mjs reaches the DOM");
    for (const [, from] of code.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      assert.match(from, /\.mjs$/, `section-pick.mjs imports ${from}`);
    }
  });
});
