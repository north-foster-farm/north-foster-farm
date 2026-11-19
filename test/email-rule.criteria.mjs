// Criteria test for #678, box 4 of its "Done when": no email pattern
// is left in the files that kept their own, and each imports the one
// rule from assets/scripts/utils/email.js. Written from the issue
// alone, before the fix (2026-11-19).
//
// Held out of `npm test` by its name until the fix lands; the
// implementer turns it on with
//
//   git mv test/email-rule.criteria.mjs test/email-rule.test.mjs
//
// An email pattern here is a regular expression that validates an
// address: anchored at both ends and matching an ordinary address
// whole. That counts `validate.mjs`'s, `auth.mjs`'s and `gate.mjs`'s
// EMAIL and `group-log.mjs`'s ADDRESS. It leaves out:
// - `gate.mjs`'s DOMAIN, the allow-list entry for a whole domain
//   (`@example.com`): it matches no address, so it validates none;
// - `group-log.mjs`'s ANY_ADDRESS, which finds addresses inside text
//   to mask them, the same pattern and job as `log.mjs`'s masking
//   pattern, which the issue keeps.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RULE = resolve(ROOT, "assets/scripts/utils/email.js");

const FILES = [
  "assets/scripts/order/lib/validate.mjs",
  "netlify/functions/lib/auth.mjs",
  "netlify/functions/lib/gate.mjs",
  "netlify/functions/lib/group-log.mjs",
];

const ADDRESSES = ["name@example.com", "pat.example+x@mail.example.org"];

// Every regular expression in the source: the literals, and the
// patterns given to RegExp as string literals. -> [{ text, re }]
const LITERAL = new RegExp(String.raw`(?:^|[=(:,;!&|?{}\[]|\breturn)\s*` +
  String.raw`\/((?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+)` +
  String.raw`\/([dgimsuvy]*)`, "gm");
const CONSTRUCTED = /\bRegExp\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;

const patterns = (source) => {
  const found = [];
  const add = (text, body, flags) => {
    try {
      found.push({ text, re: new RegExp(body, flags.replace(/[gy]/g, "")) });
    } catch {
      // Not a regular expression after all (a division, say).
    }
  };

  for (const m of source.matchAll(LITERAL)) add(m[0].trim(), m[1], m[2]);
  for (const m of source.matchAll(CONSTRUCTED)) {
    add(m[0], m[2].replace(/\\\\/g, "\\"), "");
  }

  return found;
};

const validatesAddress = ({ re }) => re.source.startsWith("^")
  && re.source.endsWith("$") && ADDRESSES.some((a) => re.test(a));

// The modules a file imports, resolved to paths.
const imports = (file, source) => [
  ...source.matchAll(/\bimport\s[^;]*?\bfrom\s*["']([^"']+)["']/g),
  ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
].map((m) => resolve(dirname(file), m[1]));

describe("#678: one email rule, in one place", () => {
  it("leaves no email pattern in the five files, and each imports the " +
    "one in assets/scripts/utils/email.js", () => {
    // The detector finds what it is meant to: the pattern the issue
    // quotes, and none of the two it leaves alone.
    const quoted = String.raw`const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;`;
    const domain = String.raw`const DOMAIN = /^@[^\s@/]+\.[^\s@/]{2,}$/;`;
    const masking = "const A = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+" +
      "(?:\\.[A-Za-z0-9-]+)+/g;";

    assert.equal(patterns(quoted).filter(validatesAddress).length, 1);
    assert.equal(patterns(domain).filter(validatesAddress).length, 0);
    assert.equal(patterns(masking).filter(validatesAddress).length, 0);
    assert.equal(patterns(
      "const E = new RegExp(\"^[^@]+@[^@]+$\");"
    ).filter(validatesAddress).length, 1);

    for (const name of FILES) {
      const file = resolve(ROOT, name);
      const source = readFileSync(file, "utf8");
      const left = patterns(source).filter(validatesAddress);

      assert.deepEqual(left.map((p) => p.text), [],
        `${name} keeps its own email pattern`);
      assert.ok(imports(file, source).includes(RULE),
        `${name} does not import assets/scripts/utils/email.js`);
    }
  });
});
