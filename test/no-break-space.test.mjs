// No template, page or data file writes a no-break space (#598).
// Aller's U+00A0 has an advance of 0, which Chromium and Firefox draw
// as no width: "10:00–11:00AM". Keep the ordinary space and wrap what
// must stay together in a text-nowrap span instead.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";

// The character, its entities and the escapes a template or JSON file
// may spell it with, and the word joiner (U+2060) #593 used beside it.
const NO_BREAK = new RegExp([
  String.fromCharCode(0xa0), String.fromCharCode(0x2060),
  "&nbsp;", "&#160;", "&#xa0;", "\\\\u00a0", "\\\\u2060",
].join("|"), "i");

// The &nbsp; in separator.html holds an empty div open: a spacer, not
// text.
const ALLOWED = new Set([join("layouts", "partials", "separator.html")]);

const files = (dir) => readdirSync(dir, { recursive: true })
  .map((f) => join(dir, f))
  .filter((f) => /\.(html|md|json|ya?ml|toml)$/.test(f));

it("writes no no-break space into layouts, content or data", () => {
  const found = ["layouts", "content", "data"].flatMap(files)
    .filter((f) => !ALLOWED.has(f))
    .flatMap((f) => readFileSync(f, "utf8").split("\n")
      .map((line, i) => (NO_BREAK.test(line) ? `${f}:${i + 1}` : null))
      .filter(Boolean));

  assert.deepEqual(found, []);
});
