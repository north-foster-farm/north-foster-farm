// The words an out-of-stock item shows, by restock type (#267). Hugo
// builds them from the catalog, so a stubbed /api/stock in an e2e
// spec can't reach a type no catalog item has. This reads the
// partial instead: each type but archived has its branch and its
// words, and archived has none, so it says nothing.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const PARTIAL = readFileSync(new URL(
  "../layouts/partials/order/restock-label.html", import.meta.url
), "utf8");

// The table in docs/order-form.md. Seasonal's season is a field of its own.
const LABELS = {
  seasonal: 'printf "Back in %s"',
  soon: '"Returning soon"',
  hiatus: '"On hiatus"',
  discontinued: '"Not available"',
};

// The type each `eq . "<type>"` branch tests, with the value it sets.
const branches = () => {
  const found = {};
  const re = /eq \. "(\w+)" \}\}\s*\{\{ \$label = ([^\n]*?) \}\}/g;

  for (const [, type, value] of PARTIAL.matchAll(re)) found[type] = value;

  return found;
};

describe("the restock label partial", () => {
  it("has a branch for each type but archived, with its words", () => {
    const found = branches();

    for (const [type, words] of Object.entries(LABELS)) {
      assert.ok(found[type], `no branch for ${type}`);
      assert.ok(found[type].startsWith(words),
        `${type} sets ${found[type]}`);
    }
  });

  it("says nothing for archived, or for a type it doesn't know", () => {
    const found = branches();

    assert.equal(found.archived, undefined);
    assert.deepEqual(Object.keys(found).sort(),
      Object.keys(LABELS).sort());
    assert.match(PARTIAL, /\{\{ \$label := "" \}\}/);
  });
});
