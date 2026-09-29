import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configDrift, findCopies, scan } from "../bin/facts/check.mjs";

const values = (file, text) => scan(file, text).map((f) => f.value);

describe("one source for every fact (Q21b)", () => {
  it("finds no copy of a data/ value outside data/", () => {
    const found = findCopies().map((f) =>
      `${f.file}:${f.line}: ${f.fact} "${f.value}", from ${f.source}`);

    assert.deepEqual(found, [], "read these from data/ instead " +
      `(node bin/facts/check.mjs lists them):\n${found.join("\n")}`);
  });

  it("keeps netlify.toml's copies in step with data/", () => {
    assert.deepEqual(configDrift(), []);
  });

  it("finds a fee, a day, a window and the phone in page text", () => {
    assert.deepEqual(values("content/x.md",
      "Delivery is $5 on Thursdays, 10:00 AM to 4:00 PM."),
    ["$5", "Thursday", "10:00 AM to 4:00 PM"]);
    assert.deepEqual(values("layouts/x.html", "Call (401) 578-3713"),
      ["(401) 578-3713"]);
  });

  it("finds the farm's name in templates and code, not in content", () => {
    assert.deepEqual(values("layouts/x.html",
      "<a aria-label=\"North Foster Farm, home\">"), ["North Foster Farm"]);
    assert.deepEqual(values("assets/scripts/x.js",
      "label: \"North Foster Farm\""), ["North Foster Farm"]);
    assert.deepEqual(values("content/x.md",
      "North Foster Farm is a small family farm"), []);
  });

  it("reads a dollar amount whole", () => {
    assert.deepEqual(values("content/x.md", "$55 or $400"), []);
    assert.deepEqual(values("content/x.md", "$50 or $5.00"), ["$5", "$50"]);
  });

  it("skips comments, but not strings, in a script", () => {
    assert.deepEqual(values("assets/scripts/x.js",
      "// a $5 fee\nconst s = \"Thursday\"; /* $40 */"), ["Thursday"]);
    assert.deepEqual(values("layouts/x.html",
      "{{/* $40 */}}<!-- $40 -->{{- /* $150 */ -}}"), []);
  });
});
