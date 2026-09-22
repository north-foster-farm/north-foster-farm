import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  GUIDE, RUNBOOK_ALERTS,
} from "../netlify/functions/lib/alerts-guide.mjs";

const runbook = readFileSync(new URL("../docs/monitoring.md", import.meta.url),
  "utf8");

describe("the alerts guide", () => {
  it("names every kind the runbook documents, and vice versa", () => {
    const documented = [...runbook.matchAll(/^\*\*`([a-z_.]+)`\.\*\*/gm)]
      .map((m) => m[1]).sort();

    assert.deepEqual(Object.keys(GUIDE).sort(), documented);
    for (const [kind, g] of Object.entries(GUIDE)) {
      assert.ok(g.means && g.action, kind);
    }
  });

  it("links to the runbook's alerts section", () => {
    assert.match(RUNBOOK_ALERTS,
      /docs\/monitoring\.md#the-alerts-and-what-to-do$/);
    assert.match(runbook, /^## The alerts, and what to do$/m);
  });
});
