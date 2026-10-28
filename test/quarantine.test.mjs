// A quarantined e2e test is listed in e2e/quarantine.json with its
// issue and an expiry, and tagged @quarantine in its spec; each needs
// the other, and an expired entry fails CI so it can't linger.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const list = JSON.parse(readFileSync(
  new URL("../e2e/quarantine.json", import.meta.url), "utf8",
));
const read = (spec) => readFileSync(new URL(`../${spec}`, import.meta.url),
  "utf8");

describe("e2e quarantine", () => {
  it("gives each entry an issue, a reason and an expiry still ahead",
    () => {
      const today = new Date().toISOString().slice(0, 10);

      for (const q of list) {
        assert.ok(Number.isInteger(q.issue), q.test);
        assert.ok(q.why && q.approved, q.test);
        assert.match(q.expires, /^\d{4}-\d\d-\d\d$/, q.test);
        assert.ok(q.expires >= today,
          `${q.test}: quarantine expired ${q.expires}; fix #${q.issue} ` +
          "or ask James to extend it");
      }
    });

  it("tags exactly the listed tests @quarantine", () => {
    for (const q of list) {
      const source = read(q.spec);
      const at = source.indexOf(q.test);

      assert.ok(at >= 0, `${q.spec} has no test "${q.test}"`);
      assert.match(source.slice(at, at + 300), /@quarantine/, q.test);
    }

    const specs = new Set(list.map((q) => q.spec));
    const tagged = (source) => (source.match(/"@quarantine"/g) || []).length;

    for (const spec of specs) {
      assert.equal(tagged(read(spec)),
        list.filter((q) => q.spec === spec).length, spec);
    }
  });
});
