// #303: the Square sandbox card's details are one component, the same
// in the staging toolbar and in the order page's first-visit overlay.
// Both render partials/staging/sandbox-card.html, and staging.css
// lays it out as a component, never per place, so a fix to one is a
// fix to both. (The built order page is held to the same by
// bin/check-staging.mjs, in test/staging-build.test.mjs and CI.)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const read = (f) => readFileSync(join(root, f), "utf8");

describe("the sandbox card", () => {
  it("renders from one partial in the toolbar and the overlay", () => {
    const toolbar = read("layouts/partials/staging-toolbar.html");
    const uses = [...toolbar.matchAll(
      /partial "staging\/sandbox-card\.html" "(\w+)"/g
    )].map((m) => m[1]);

    assert.deepEqual(uses.sort(), ["overlay", "toolbar"]);
    assert.doesNotMatch(toolbar, /staging-card-row|<dl/,
      "no second copy of its markup");
  });

  it("is laid out as a component, never by where it sits", () => {
    const css = read("assets/styles/staging.css");
    // Every selector, comments dropped, that reaches into the card's
    // layout (the grid, its rows, labels and values).
    const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "")
      .match(/[^{}]+(?=\{)/g)
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter((s) => /\.staging-card(?:-row|-value)?\b(?![-\w])/.test(s));
    const own = /^\.staging-card(?:-row|-value)?\b(?![-\w])/;
    const placed = selectors.filter((s) => !own.test(s));

    assert.ok(selectors.length > 0);
    assert.deepEqual(placed, [], "card layout styled by its place");
  });
});
