// #888: the privacy page promises a link about a particular order that
// works for 7 days, and nothing has issued one since 2026-09-28, when
// `bin/nff orders deny` and its "Pick a new time" email were retired.
// James's decision, 2026-11-22: drop the line; the links don't come
// back. A criteria test, written by a test agent from the issue's
// "Done when" list before the change. One test per (test) box. The
// fourth box, the page's "Last updated" date, is James's and gets no
// test: he decided on 2026-11-22 that it carries the date the change
// ships.
//
// The seam: the privacy page as built, both formats Hugo writes for it
// (privacy/index.html and the Markdown twin, privacy/index.md), and the
// source trees that could read the retired value.
//
// Where Hugo is not installed (CI's test job), the page tests skip.
//
// Held out of npm test by its name: rename it to
// privacy-order-links.test.mjs to turn it on.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const hasHugo = spawnSync("hugo", ["version"]).status === 0;
const accounts = JSON.parse(
  readFileSync(join(root, "data", "accounts.json"), "utf8"));

const HEADING = "Accounts and sign-in links";

// The sign-in sentences as they stand on next, with the minutes read
// from the value the code uses.
const SIGN_IN = "You don't need an account to order. To sign in, you " +
  "enter your email address and we email you a link. There is no " +
  "password. The link works once, within " +
  `${accounts.signInLinkMinutes} minutes.`;

const ENTITIES = {
  amp: "&", quot: "\"", nbsp: " ", rsquo: "'", lsquo: "'",
  rdquo: "\"", ldquo: "\"",
};

// Prose as a reader gets it: tags gone, entities and curly quotes
// made plain, whitespace collapsed.
const plain = (s) => s
  .replace(/<[^>]+>/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&(\w+);/g, (m, name) => ENTITIES[name] ?? m)
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, "\"")
  .replace(/\s+/g, " ")
  .trim();

const sentences = (text) => text.split(/(?<=[.!?])\s+/);

// A sentence that gives a lifetime in days to a link about an order.
const orderLinkLines = (text) => sentences(text).filter((s) =>
  /particular order/i.test(s) ||
  (/\blinks?\b/i.test(s) && /\border\b/i.test(s) && /\bdays?\b/i.test(s)));

// The section under the heading, up to the next heading.
const htmlSection = (html) => {
  const at = html.indexOf(`${HEADING}</h3>`);
  assert.ok(at >= 0, `the HTML has the "${HEADING}" heading`);
  const rest = html.slice(at + HEADING.length + 5);
  return plain(rest.slice(0, rest.search(/<h[1-6]\b/)));
};

const markdownSection = (md) => {
  const found = md.match(
    new RegExp(`^#+ ${HEADING}\\s*\\n([\\s\\S]*?)(?=^#+ )`, "m"));
  assert.ok(found, `the Markdown has the "${HEADING}" heading`);
  return plain(found[1]);
};

// Every file under a folder, node_modules aside.
const filesUnder = (dir) => readdirSync(dir).flatMap((name) => {
  if (name === "node_modules") return [];
  const path = join(dir, name);
  return statSync(path).isDirectory() ? filesUnder(path) : [path];
});

describe("#888 the privacy page drops the 7-day order link", () => {
  describe("the built page", { skip: !hasHugo && "no hugo" }, () => {
    let out;
    let html;
    let md;

    before(() => {
      out = mkdtempSync(join(tmpdir(), "nff-privacy-order-links-"));
      const run = spawnSync("hugo", ["--gc", "--quiet", "--environment",
        "production", "-d", out], { cwd: root, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      html = readFileSync(join(out, "privacy", "index.html"), "utf8");
      md = readFileSync(join(out, "privacy", "index.md"), "utf8");
    });

    after(() => out && rmSync(out, { recursive: true, force: true }));

    it("no longer says a link about a particular order works for 7 " +
      "days; the sign-in link sentence is unchanged", () => {
      const text = plain(html);

      assert.deepEqual(orderLinkLines(text), [],
        "the privacy page still gives an order link a lifetime");
      assert.ok(text.includes(SIGN_IN),
        `the privacy page keeps the sign-in sentences: "${SIGN_IN}"`);
    });

    it("says the same in its Markdown output as in its HTML", () => {
      const fromMarkdown = markdownSection(md);

      assert.equal(fromMarkdown, htmlSection(html),
        `"${HEADING}" reads differently in index.md and index.html`);
      assert.deepEqual(orderLinkLines(fromMarkdown), [],
        "index.md still gives an order link a lifetime");
    });
  });

  it("drops orderLinkDays and LONG_LINK_TTL, with nothing left that " +
    "reads either", () => {
    const auth = readFileSync(
      join(root, "netlify", "functions", "lib", "auth.mjs"), "utf8");

    assert.equal(Object.hasOwn(accounts, "orderLinkDays"), false,
      "data/accounts.json still holds orderLinkDays");
    assert.doesNotMatch(auth, /\bLONG_LINK_TTL\b/,
      "netlify/functions/lib/auth.mjs still holds LONG_LINK_TTL");

    const readers = ["content", "layouts", "assets", "netlify", "bin"]
      .flatMap((dir) => filesUnder(join(root, dir)))
      .filter((file) =>
        /\b(?:orderLinkDays|LONG_LINK_TTL)\b/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(root.length + 1));

    assert.deepEqual(readers, [], "these still read a retired value");
  });
});
