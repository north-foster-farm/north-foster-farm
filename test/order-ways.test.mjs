// #534: the order page's Pickup or delivery cards, their wording and
// their "(map)" links, read off the built HTML. Where Hugo is not
// installed (CI's test job), CI's build job builds the page and this
// is skipped.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { locationsLabel } from "../assets/scripts/order/lib/scheduled.mjs";

const root = join(import.meta.dirname, "..");
const hasHugo = spawnSync("hugo", ["version"]).status === 0;
const data = (name) =>
  JSON.parse(readFileSync(join(root, "data", `${name}.json`), "utf8"));

const text = (html) => html
  .replace(/<span class="visually-hidden">[\s\S]*?<\/span>/g, "")
  .replace(/<[^>]+>/g, " ")
  .replaceAll(String.fromCharCode(0xa0), " ")
  .replaceAll(String.fromCharCode(0x2060), "")
  .replace(/\s+/g, " ")
  .replace(/\( /g, "(")
  .replace(/ \)/g, ")")
  .trim();

// The count the build gives: the locations of the series listed
// (partials/scheduled-places.html) that have not ended, on the build's
// day in New York or in UTC, whichever the runner's clock takes.
const counts = () => {
  const locations = data("locations").locations;
  const days = ["America/New_York", "UTC"].map((timeZone) =>
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date()));

  return days.map((today) => new Set(data("series").series
    .filter((s) => !s.archived && !s.group)
    .filter((s) => !locations.find((l) => l.code === s.location).archived)
    .filter((s) => !s.end || s.end >= today)
    .map((s) => s.location)).size);
};

describe("order page Pickup or delivery cards", { skip: !hasHugo }, () => {
  let out;
  let cards;

  before(() => {
    out = mkdtempSync(join(tmpdir(), "nff-order-ways-"));

    const run = spawnSync("hugo", ["--gc", "--quiet", "--environment",
      "production", "-d", out], { cwd: root, encoding: "utf8" });

    assert.equal(run.status, 0, run.stderr);

    const html = readFileSync(join(out, "order", "index.html"), "utf8");
    const set = html.match(/<fieldset[^>]*id=pickup[\s\S]*?<\/fieldset>/)
      || html.match(/<fieldset[^>]*id="pickup"[\s\S]*?<\/fieldset>/);

    cards = set[0].split(/<div class="?order-method"?>/).slice(1)
      .map((card) => {
        const facts = card.match(/<dl[\s\S]*?<\/dl>/)[0];
        // The facts as built: a pair built hidden (the Pickup days
        // card's Order by, shown once a pickup is chosen, #574) is not
        // read.
        const pairs = [...facts.matchAll(
          /<dt([^>]*)>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g
        )].filter((m) => !/\bhidden\b/.test(m[1]));
        const dts = pairs.map((m) => text(m[2]));
        const dds = pairs.map((m) => text(m[3]));

        const title = card.match(
          /<span ([^>]*order-method-title[^>]*)>([\s\S]*?)<\/span>/);

        return {
          title: text(title[2]),
          titleId: (title[1].match(/id="?([^" >]+)/) || [])[1],
          radio: card.match(/<input [^>]*name="?method"?[^>]*>/)[0],
          facts: Object.fromEntries(dts.map((dt, i) => [dt, dds[i]])),
          links: [...facts.matchAll(/<a [^>]*>/g)].map((m) => m[0]),
          anchors: [...facts.matchAll(/<a [\s\S]*?<\/a>/g)]
            .map((m) => m[0]),
        };
      });
  });

  after(() => rmSync(out, { recursive: true, force: true }));

  it("has the three cards", () => {
    assert.deepEqual(cards.map((c) => c.title),
      ["On-farm pickup", "Pickup days", "Delivery"]);
  });

  it("reads as James wrote (#534)", () => {
    const [onfarm, scheduled, delivery] = cards.map((c) => c.facts);
    const company = data("company").name;

    assert.deepEqual(onfarm, {
      When: "Select to see current availability",
      Where: `${company} (map)`,
      Cost: "No minimum, no fee",
    });
    assert.equal(scheduled.When, "Select to see current availability");
    assert.ok(counts().map((n) => `${locationsLabel(n)} (map)`)
      .includes(scheduled.Where), scheduled.Where);
    assert.equal(scheduled.Cost, "No minimum, no fee");
    assert.match(delivery.When, /^\w+days, \d/);
    assert.equal(delivery.Where, "Check our delivery area (map)");
    assert.match(delivery.Cost, /^\$\d+ minimum, \$\d+ delivery fee$/);
  });

  it("links each (map) to the home page's map in a new tab", () => {
    const hashes = cards.map((c) => {
      assert.equal(c.links.length, 1, c.title);

      const [link] = c.links;

      assert.match(link, /target="?_blank"?/);
      assert.match(link, /rel="?noopener"?/);

      // The build writes relative URLs: resolve from the order page.
      const url = new URL(link.match(/href="?([^" >]+)"?/)[1],
        "https://example.com/order/");

      return url.pathname + url.hash;
    });

    assert.deepEqual(hashes, [
      "/#place-north-foster-farm", "/#places", "/#map",
    ]);

    // The home page has what each hash points at.
    const home = readFileSync(join(out, "index.html"), "utf8");

    assert.match(home, /data-map-slug="?place-north-foster-farm[" >]/);
    assert.match(home, /id="?map[" >]/);
  });

  // Tabler's external-link icon after "map", hidden from screen
  // readers, where the arrow glyph stood (#534).
  it("marks each (map) with the external-link icon", () => {
    const icon = readFileSync(
      join(root, "assets/images/icons/external-link.svg"), "utf8");
    const paths = [...icon.matchAll(/<path [^>]*>/g)].map((m) => m[0]);

    for (const c of cards) {
      const [anchor] = c.anchors;
      const svg = anchor.match(/<svg[^>]*>[\s\S]*?<\/svg>/);

      assert.ok(svg, c.title);
      assert.match(svg[0], /class="?order-method-map-icon"?/);
      assert.match(svg[0], /aria-hidden="?true"?/);
      for (const path of paths) assert.ok(svg[0].includes(path), c.title);
      assert.doesNotMatch(anchor, /↗/);
      // Nothing between the icon and what follows it, so no space
      // shows before the ")" (the file's last newline is trimmed).
      assert.match(anchor, /<\/svg>(<span|<\/a>)/, c.title);
    }
  });

  // Each radio is named by its title alone, not the whole label with
  // its facts and "map (opens in a new tab)" (#534).
  it("names each radio by its card's title", () => {
    for (const c of cards) {
      const by = c.radio.match(/aria-labelledby="?([^" >]+)/);

      assert.ok(by, c.title);
      assert.ok(c.titleId, c.title);
      assert.equal(by[1], c.titleId, c.title);
    }
  });
});
