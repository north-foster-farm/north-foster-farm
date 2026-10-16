import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  GUIDE, RUNBOOK_ALERTS,
} from "../netlify/functions/lib/alerts-guide.mjs";
import { BEACONS } from "../netlify/functions/health.mjs";

const root = new URL("../", import.meta.url);
const runbook = readFileSync(new URL("docs/monitoring.md", root), "utf8");

// Every source that may raise an alert: the functions, their library
// and the CLI.
const sources = () => {
  const dir = new URL("netlify/functions/", root);
  const files = readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => new URL(f, dir));

  return [...files, new URL("bin/nff", root)]
    .map((url) => ({ url, text: readFileSync(url, "utf8") }));
};

// Every call like alert(stores, "kind", ...) or alert(stores(), ...),
// across lines, with its second argument as written.
const CALL = /\balert\(\s*[A-Za-z_$][\w$.]*(?:\(\))?\s*,\s*([^\s,)]+)/g;
const LITERAL = /^(["'])([a-z0-9_.-]+)\1$/;

// The calls whose kind is a variable, each for a reason, by file. Any
// other must name its kind as a string, or the scan cannot see it.
const VARIABLE_KINDS = {
  // The beacon's kind, from BEACONS, which the scan reads itself.
  "netlify/functions/health.mjs": ["kind"],
};

const scan = () => {
  const kinds = new Set(Object.values(BEACONS));
  const variable = {};

  for (const { url, text } of sources()) {
    const file = url.href.slice(root.href.length);

    for (const m of text.matchAll(CALL)) {
      const literal = m[1].match(LITERAL);

      if (literal) {
        kinds.add(literal[2]);
      } else {
        variable[file] = [...(variable[file] || []), m[1]];
      }
    }
  }

  return { kinds: [...kinds].sort(), variable };
};

const emittedKinds = () => scan().kinds;

describe("the alerts guide", () => {
  it("has an entry for every kind the code can raise", () => {
    const kinds = emittedKinds();
    const missing = kinds.filter((k) => !GUIDE[k]);

    // A scan that finds nothing would pass anything.
    assert.ok(kinds.length >= 13, `found only ${kinds.join(", ")}`);
    assert.deepEqual(missing, [],
      "add these to lib/alerts-guide.mjs and docs/monitoring.md");
  });

  it("sees every kind: each is a string, but for the named exceptions",
    () => {
      assert.deepEqual(scan().variable, VARIABLE_KINDS);
    });

  it("has no entry for a kind nothing raises", () => {
    const kinds = new Set(emittedKinds());

    assert.deepEqual(Object.keys(GUIDE).filter((k) => !kinds.has(k)), []);
  });

  it("names every kind the runbook documents, and vice versa", () => {
    const documented = [...runbook
      .matchAll(/^\*\*`([a-z0-9_.-]+)`\.\*\*/gm)]
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
