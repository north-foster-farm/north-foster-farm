// Criteria tests for #628, the Foster market's name. James decided on
// 2026-11-18: "Foster Farmers’ Market", with the typographic
// apostrophe after the s (U+2019), is the one spelling wherever a
// customer reads it. Other markets' own names are proper names the
// farm does not choose ("Scituate Rotary Farmers Market", "Pawtucket
// Farmers Market") and are not checked here. Identifiers, slugs, file
// names and URLs (fosterfarmersmarketri.com) are not copy.
//
// Held out of `npm test` until the change lands: the glob there is
// test/**/*.test.mjs. Run it alone with
//   node --import ./test/setup.mjs --test test/foster-market.criteria.mjs
// and turn it on, once it passes, with
//   git mv test/foster-market.criteria.mjs test/foster-market.test.mjs
//
// Written by the wording-tests agent from the criteria alone. Its
// expectations are closed to the implementer (~/.claude/CLAUDE.md,
// "Tests and implementation come from different agents").

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, readFileSync, readdirSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const NAME = "Foster Farmers’ Market";

const files = (dir, pattern) => readdirSync(dir, {
  recursive: true, withFileTypes: true,
}).filter((e) => e.isFile() && pattern.test(e.name))
  .map((e) => join(e.parentPath, e.name))
  .sort();

// Every way of writing the name: either apostrophe or none, before or
// after the s, raw or as an HTML entity, across a line break.
const APOSTROPHE = "(?:['’]|&rsquo;|&#39;|&#x27;|&#8217;)";
const MENTION = new RegExp(
  `Foster\\s+Farmer(?:s|s?${APOSTROPHE}s?)?\\s+Market`, "gi");

const decode = (s) => s.replace(/&rsquo;|&#8217;/g, "’")
  .replace(/&#39;|&#x27;/g, "'");

// Each mention of the market in some text that is not the one
// spelling, as "file: mention", the file named from `base`.
const wrong = (file, text, base = ROOT, prefix = "") => [
  ...text.matchAll(MENTION),
].map(([m]) => decode(m).replace(/\s+/g, " "))
  .filter((m) => m !== NAME)
  .map((m) => `${prefix}${relative(base, file)}: ${m}`);

// Comments are for the next developer, not the customer.
const uncommented = (file, text) => {
  if (/\.html$/.test(file)) {
    return text.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, "")
      .replace(/<!--[\s\S]*?-->/g, "");
  }
  if (/\.m?js$/.test(file)) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  return text;
};

// The sources a customer reads: pages, templates, data, the scripts
// that write the page, and the functions that write emails and API
// answers (lib/library.mjs's samples among them).
const SOURCES = [
  ["content", /\.(md|html)$/],
  ["layouts", /\.(html|xml|txt|json)$/],
  ["data", /\.(json|ya?ml|toml)$/],
  ["static", /\.(html|txt|json|xml|webmanifest)$/],
  ["assets/scripts", /\.m?js$/],
  ["netlify/functions", /\.m?js$/],
  ["netlify/gate-edge", /\.m?js$/],
];

const hasHugo = spawnSync("hugo", ["version"]).status === 0;

describe("#628: the Foster market's name", () => {
  let out;

  before(() => {
    if (!hasHugo) return;
    out = mkdtempSync(join(tmpdir(), "nff-foster-build-"));

    const run = spawnSync("hugo", ["--gc", "--quiet", "--environment",
      "production", "-d", out], { cwd: ROOT, encoding: "utf8" });

    assert.equal(run.status, 0, run.stderr);
  });

  after(() => out && rmSync(out, { recursive: true, force: true }));

  it("nowhere a customer reads (pages, meta tags, emails) names the "
    + "Foster market any other way", { skip: !hasHugo && "no hugo" },
  () => {
    const inSources = SOURCES.flatMap(([dir, pattern]) =>
      files(join(ROOT, dir), pattern).flatMap((file) =>
        wrong(file, uncommented(file, readFileSync(file, "utf8")))));

    // The built site, text and attributes (meta tags, alt text) alike,
    // with its feeds, its Markdown twins, llms.txt and the bundles.
    const built = files(out, /\.(html|xml|txt|md|json|webmanifest|js)$/)
      .flatMap((file) =>
        wrong(file, readFileSync(file, "utf8"), out, "build/"));

    assert.deepEqual([...inSources, ...built], [],
      `every mention is "${NAME}"`);
  });

  it("the wording rule (#400) gives this spelling, if it lists approved "
    + "names", () => {
    // The #400 house rules stand in the repo's CLAUDE.md, under
    // "Customer copy follows the #400 house rules". If they name the
    // Foster market, they name it the one way.
    const claude = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
    const from = claude.indexOf("#400 house rules");

    assert.notEqual(from, -1, "CLAUDE.md has the #400 house rules");
    const rules = claude.slice(from, claude.indexOf("\n- **", from + 1));

    assert.deepEqual(wrong(join(ROOT, "CLAUDE.md"), rules), [],
      `the rules name the Foster market "${NAME}"`);
  });
});
