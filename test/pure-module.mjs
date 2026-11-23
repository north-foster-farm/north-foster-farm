// The purity check the refactor series' criteria tests share
// (docs/refactors/): a module the design lists as pure names none of
// the globals it is given, and imports only modules whose address
// matches `imports` (other .mjs modules, unless the test says
// otherwise; null when the test checks no imports), never the `door`
// when one is named. Comments are stripped first. Each criteria test
// passes its own list; nothing here is an expectation of its own.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export const assertPure = (url, {
  banned, door = null, imports = /\.mjs$/,
}) => {
  const name = url.pathname.split("/").pop();
  const code = readFileSync(url, "utf8")
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  assert.doesNotMatch(code, new RegExp(`\\b(${banned.join("|")})\\b`),
    `${name} reaches the DOM`);
  for (const [, from] of code.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    if (imports) assert.match(from, imports, `${name} imports ${from}`);
    if (door) assert.doesNotMatch(from, door, `${name} imports the door`);
  }
};
