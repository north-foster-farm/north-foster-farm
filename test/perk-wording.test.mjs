// Criteria test for James's revision of #717 (Perks show as one
// pricing label with a tooltip; "Revision from James", 2026-11-21),
// for the one box of its "Done when" that the wording alone decides,
// named for it. Held out of `npm test` by its name until the change
// lands: renamed to perk-wording.test.mjs, it runs. The page's boxes
// are e2e/perk-revision.criteria.mjs.
//
// The seam: assets/scripts/order/lib/perks.mjs, which names each perk
// for the page and the functions alike (perkName, perkParts,
// perkSentence) and lays out the lines (perkLines); and the site's
// own sources, where the retired wording must appear nowhere.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  perkLines, perkName, perkParts, perkSentence,
} from "../assets/scripts/order/lib/perks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NEW = "No delivery minimum";
const OLD = /no order minimum/i;

// What the customer can read: the page's scripts, styles and
// templates, the content, the data, the functions (their emails and
// answers), the config and the static files. Tests and docs may
// quote the old wording.
const SOURCES = [
  "assets", "layouts", "content", "data", "netlify", "config", "static",
  "i18n",
];
const TEXT = /\.(m?js|html|md|json|ya?ml|toml|scss|css|txt|xml)$/;

const files = (dir) => {
  let names;

  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  return names.flatMap((name) => {
    const path = join(dir, name);

    if (name === "node_modules") return [];
    if (statSync(path).isDirectory()) return files(path);

    return TEXT.test(name) ? [path] : [];
  });
};

const perk = (type, end = null) => ({ type, start: "2026-11-01", end });

describe("perk wording, revised (#717, James, 2026-11-21)", () => {
  it("Every perk wording reads \"No delivery minimum\", in the " +
    "tooltips' bullets and as a standalone perk; \"No order minimum\" " +
    "appears nowhere", () => {
    // The tooltips' bullets.
    assert.deepEqual(perkParts("friends"),
      ["Friends and family discount", "Free delivery", NEW]);
    assert.deepEqual(perkParts("family"),
      ["Family discount", "Free delivery", NEW]);

    // The standalone perk, with and without its end date, and as the
    // line the page draws.
    assert.equal(perkName("minimum-waived"), NEW);
    assert.equal(perkSentence({ type: "minimum-waived" }), NEW);
    assert.equal(perkSentence({ type: "minimum-waived", end: "2027-03-03" }),
      `${NEW} through March 3, 2027`);
    assert.deepEqual(perkLines([perk("minimum-waived")]),
      [{ labels: [NEW] }]);

    // Nowhere in what the site builds or sends.
    const found = SOURCES.flatMap((dir) => files(join(ROOT, dir)))
      .filter((path) => OLD.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path));

    assert.deepEqual(found, [], "files that still say \"No order minimum\"");
  });
});
