// #705: the Place your order pane's wording, read off the built order
// page. A criteria test, written by a test agent from the issue's
// "Done when" list and James's mockup before the change. The words are
// James's and pinned word for word; "up to date" stays unhyphenated
// (James, 2026-11-21: an adverbial phrase here). Order, layout and
// hiding are e2e/place-order-pane.criteria.mjs.
//
// Where Hugo is not installed (CI's test job), CI's build job builds
// the page and this is skipped.
//
// Held out of npm test by its name: rename it to
// place-order-copy.test.mjs to turn it on.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const hasHugo = spawnSync("hugo", ["version"]).status === 0;

const QUESTION = "Interested in pasture-raised news and updates?";
const CHECKBOX = "Sign up and stay up to date with North Foster Farm.";

const text = (html) => html
  .replace(/<[^>]+>/g, " ")
  .replaceAll("&nbsp;", " ")
  .replaceAll("&#39;", "'")
  .replaceAll(String.fromCharCode(0xa0), " ")
  .replaceAll(String.fromCharCode(0x2060), "")
  .replace(/\s+/g, " ")
  .replace(/ ([.?,])/g, "$1")
  .trim();

describe("the Place your order pane's wording (#705)",
  { skip: !hasHugo }, () => {
    let out;
    let pane;

    before(() => {
      out = mkdtempSync(join(tmpdir(), "nff-place-order-copy-"));

      const run = spawnSync("hugo", ["--gc", "--quiet", "--environment",
        "production", "-d", out], { cwd: root, encoding: "utf8" });

      assert.equal(run.status, 0, run.stderr);

      const html = readFileSync(join(out, "order", "index.html"), "utf8");

      pane = html.match(
        /<fieldset[^>]*\bid="?confirm"?[\s>][\s\S]*?<\/fieldset>/,
      )?.[0];
      assert.ok(pane, "the order page has its Place your order fieldset");
    });

    after(() => rmSync(out, { recursive: true, force: true }));

    // Done when 2.
    it("the wording is the mockup's, word for word: \"Interested in " +
      "pasture-raised news and updates?\" and \"Sign up and stay up to " +
      "date with North Foster Farm.\"", () => {
      const label = pane.match(new RegExp(String.raw`<label\b[^>]*` +
        String.raw`\bfor="?customer-marketing"?(?=[\s>])[^>]*>` +
        String.raw`([\s\S]*?)</label>`));
      const words = text(pane);

      assert.ok(words.includes(QUESTION),
        `the pane asks "${QUESTION}"; it reads: ${words}`);
      assert.ok(label, "the checkbox has its label");
      assert.equal(text(label[1]), CHECKBOX);
      assert.ok(!words.includes("Farm News and updates"),
        "the question replaces the subheading Farm News and updates");
    });
  });
