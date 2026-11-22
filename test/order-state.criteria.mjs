// Criteria tests for #819, phase 5 of the split of order-form.js
// (docs/refactors/order-form.md, "Phase 5: one record for the order's
// state"), held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/order-state.criteria.mjs test/order-state.test.mjs
//
// All five criteria are of the new-module kind: they fail on `next`,
// where form/page-data.mjs and form/order-state.mjs do not exist, and
// pass once the phase adds them. Nothing retires.
//
// Contract (the design names the functions and their modules, not
// their arguments or the record's keys; these are the test agent's
// choice; the call shape and the key names may be adapted, the
// values may not):
//
//   pageData(data)                              form/page-data.mjs
//     data  #order-data's JSON: catalog, aliases, terms, locations,
//           series, codes, contact (layouts/partials/order/form.html)
//     ->    { terms (with `model`), dropSeries, drop, codes, aliases,
//           ... }
//
//   editIdFrom(search)                          form/page-data.mjs
//     search  location.search
//     ->      the id, or null
//
//   initialState()                              form/order-state.mjs
//     ->  { code, pass, member, groupCode, roundGroup, credit, perks,
//         signedIn, editing, ... }
//
//   createStore(record)                         form/order-state.mjs
//     ->  { get(), set(record) }

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import company from "../data/company.json" with { type: "json" };
import terms from "../data/delivery.json" with { type: "json" };
import places from "../data/locations.json" with { type: "json" };
import rhythms from "../data/series.json" with { type: "json" };
import { buildModel } from "../assets/scripts/order/lib/events.mjs";
import {
  editIdFrom, pageData,
} from "../assets/scripts/order/form/page-data.mjs";
import {
  createStore, initialState,
} from "../assets/scripts/order/form/order-state.mjs";

const FORM = new URL("../assets/scripts/order/form/", import.meta.url);

// The page's data as form.html embeds it, from the data files. The
// group places the page leaves out make no difference here.
const embedded = (more = {}) => ({
  catalog,
  aliases: { "NFF-OLD-1": "NFF-CHK-EGG-LG" },
  terms,
  locations: places.locations,
  series: rhythms.series,
  codes: [{ hash: "ab12", label: "Ten off", off: 10 }],
  contact: { name: company.name, email: company.email,
    phone: company.phone },
  ...more,
});

// Box 1 of #819.
describe("pageData, the pickup model", () => {
  it("builds the pickup model from the page's locations and series, and "
    + "names the drop site's series and its record", () => {
    const page = pageData(embedded());
    const model = buildModel(places.locations, rhythms.series);
    const drop = rhythms.series.find((s) => s.kind === "drop-site");

    assert.ok(drop, "data/series.json has a drop site");
    assert.deepEqual(page.terms.model.series, model.series);
    assert.deepEqual(
      places.locations.map((l) => page.terms.model.location(l.code)),
      places.locations.map((l) => model.location(l.code))
    );
    assert.equal(page.dropSeries, drop.code);
    assert.equal(page.drop.code, drop.code);
    assert.deepEqual(page.drop, model.series.find((s) => s.code === drop.code));
    // The rest of the terms ride along.
    assert.equal(page.terms.timeZone, terms.timeZone);
  });
});

// Box 2 of #819.
describe("pageData, what may be missing", () => {
  it("gives an empty list for missing codes and an empty map for missing "
    + "aliases", () => {
    const page = pageData(embedded({ codes: undefined, aliases: undefined }));

    assert.deepEqual(page.codes, []);
    assert.deepEqual(page.aliases, {});

    const kept = pageData(embedded());

    assert.deepEqual(kept.codes, embedded().codes);
    assert.deepEqual(kept.aliases, embedded().aliases);
  });
});

// Box 3 of #819.
describe("editIdFrom", () => {
  it("takes 1 to 32 letters, digits and hyphens from ?edit=, and gives "
    + "null for anything else or nothing", () => {
    assert.equal(editIdFrom("?edit=NFF-2609-QA85"), "NFF-2609-QA85");
    assert.equal(editIdFrom("?edit=a"), "a");
    assert.equal(editIdFrom(`?edit=${"A".repeat(32)}`), "A".repeat(32));
    assert.equal(editIdFrom("?add=X:1&edit=abc-9"), "abc-9");

    assert.equal(editIdFrom(`?edit=${"A".repeat(33)}`), null, "33 long");
    assert.equal(editIdFrom("?edit="), null, "empty");
    assert.equal(editIdFrom(""), null, "nothing");
    assert.equal(editIdFrom("?add=X:1"), null, "no edit");
    for (const bad of ["NFF_2609", "NFF 2609", "../x", "NFF%2F1", "é"]) {
      assert.equal(editIdFrom(`?edit=${encodeURIComponent(bad)}`), null,
        bad);
    }
  });
});

// Box 4 of #819.
describe("initialState", () => {
  it("has no code, pass, member, group or credit, no perks, is signed "
    + "out, and is not editing", () => {
    const s = initialState();

    for (const key of ["code", "pass", "member", "groupCode", "roundGroup",
      "editing"]) {
      assert.ok(s[key] === null || s[key] === undefined, key);
    }
    assert.equal(s.credit, 0);
    assert.equal([...(s.perks ?? [])].length, 0);
    assert.equal(s.signedIn, false);
  });
});

// Box 5 of #819.
describe("createStore", () => {
  it("returns the record it was given, replaces it on set, and never "
    + "changes a record it has handed out", () => {
    const first = initialState();
    const before = structuredClone(first);
    const store = createStore(first);

    assert.equal(store.get(), first);

    store.set({ ...store.get(), code: { code: "TEN", off: 10 } });

    const second = store.get();

    assert.notEqual(second, first, "a new record");
    assert.deepEqual(second.code, { code: "TEN", off: 10 });
    assert.deepEqual(first, before, "the first is as it was");

    const kept = structuredClone(second);

    store.set({ ...store.get(), credit: 500 });
    assert.equal(store.get().credit, 500);
    assert.deepEqual(second, kept, "the second is as it was");
  });
});

describe("design, phase 5", () => {
  it("keeps form/page-data.mjs and form/order-state.mjs pure", () => {
    for (const name of ["page-data.mjs", "order-state.mjs"]) {
      const code = readFileSync(new URL(name, FORM), "utf8")
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");

      assert.doesNotMatch(code,
        new RegExp("(?<![.\\w])(document|window)\\."
          + "|\\b(location\\.search|querySelector|Element)\\b"),
        name);
    }
  });
});
