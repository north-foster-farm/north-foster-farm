// #737: "pickup" or "pick-up", by James's rule (decided on #731,
// 2026-11-21): "pick-up" when it modifies another word ("Pick-up
// days", "pick-up time"), "pickup" when it is the noun ("On-farm
// pickup", "pickup or delivery"); "Pick-up days" for the days in the
// aggregate and "Pick-up day" for a single one. A criteria test,
// written by a test agent from the issue's "Done when" list before
// the change. One test per (test) box.
//
// The seam: the words a customer reads, in two places.
//
// - The built site: Hugo builds into a temp folder, and every page's
//   visible text (markup stripped, <template> text kept), its
//   customer-facing attributes (title, alt, aria-label, placeholder,
//   content, value), its JSON-LD, llms.txt, the web app manifest and
//   the bundled scripts (whose strings are the copy they insert).
// - The emails: every entry in the email library
//   (netlify/functions/lib/library.mjs) that is not the farm's own,
//   built from its sample records: subject, text and html.
//
// Only prose is read. Identifiers keep "pickup" (Spec item 2): ids,
// classes, data attributes, URLs, file names, keys and log events are
// never one word followed by a space and a noun, so the rule below
// never reaches them.
//
// Where Hugo is not installed (CI's test job), this is skipped.
//
// Held out of npm test by its name: rename it to
// pickup-hyphen.test.mjs to turn it on.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";

import { methodName } from "../netlify/functions/lib/describe.mjs";
import { library } from "../netlify/functions/lib/library.mjs";
import { mailLinks } from "../netlify/functions/lib/site.mjs";

const root = join(import.meta.dirname, "..");
const hasHugo = spawnSync("hugo", ["version"]).status === 0;

// "pickup" is a modifier when the word after it is a noun it
// describes. These are the nouns the site pairs it with, or plausibly
// will. Any other word after it ("pickup or delivery", "pickup at
// the farm", "Pickup moved") leaves it the noun, and it passes.
const MODIFIED = [
  "address", "appointment", "area", "date", "day", "detail", "hour",
  "instruction", "location", "option", "order", "place", "point",
  "schedule", "site", "slot", "spot", "time", "window",
];

// One word, a space (or a no-break space), then a modified noun or
// its plural.
const MODIFIER = new RegExp(
  `\\bpickup\\s+(?:${MODIFIED.join("|")})s?\\b`, "gi");

// A single day, by its determiner: "a pick-up day", "another pick-up
// day". The phrase after one must be the singular, hyphenated.
const SINGLE = new RegExp("\\b(?:a|an|another|one|each|every|this|that)" +
  "\\s+(pick[- ]?up\\s+days?)\\b", "gi");

const decode = (s) => s
  .replaceAll("&nbsp;", " ")
  .replaceAll("&#39;", "'")
  .replaceAll("&rsquo;", "'")
  .replaceAll("&amp;", "&")
  .replaceAll(String.fromCharCode(0x2060), "");

// What a customer reads on a page.
const pageText = (html) => {
  const ld = [...html.matchAll(
    /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g,
  )].map((m) => m[1]);
  const attrs = [...html.matchAll(
    /\s(?:title|alt|aria-label|placeholder|content|value)="([^"]*)"/g,
  )].map((m) => m[1]);
  const body = html
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  return decode([body, ...attrs, ...ld].join("\n"));
};

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);

  return statSync(path).isDirectory() ? walk(path) : [path];
});

// Each finding: where, the phrase, and a little context.
const scan = (sources, pattern, ok) => sources.flatMap(({ where, text }) =>
  [...text.matchAll(pattern)]
    .filter((m) => !ok(m))
    .map((m) => `${where}: "${m[0].replace(/\s+/g, " ")}" in "...${
      text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 20)
        .replace(/\s+/g, " ")}..."`));

const report = (found) => `${found.length} found:\n  ${
  found.slice(0, 25).join("\n  ")}${found.length > 25 ? "\n  ..." : ""}`;

describe("pickup and pick-up across the site (#737)",
  { skip: !hasHugo }, () => {
    let out;
    let sources;
    let orderPage;

    before(() => {
      out = mkdtempSync(join(tmpdir(), "nff-pickup-hyphen-"));

      const run = spawnSync("hugo", ["--gc", "--quiet", "--environment",
        "production", "-d", out], { cwd: root, encoding: "utf8" });

      assert.equal(run.status, 0, run.stderr);

      const site = walk(out).flatMap((path) => {
        // A bundle's name without its fingerprint.
        const where = relative(out, path).replace(/\.[0-9a-f]{32,}\./, ".");
        const raw = () => readFileSync(path, "utf8");

        if (path.endsWith(".html")) return [{ where, text: pageText(raw()) }];
        if (/\.(js|txt|webmanifest)$/.test(path)) {
          return [{ where, text: decode(raw()) }];
        }
        return [];
      });

      const links = mailLinks({ SITE_URL: "https://example.test" });
      const emails = library
        .filter((e) => e.audience !== "farm")
        .map((e) => {
          const m = e.build(links);

          return {
            where: `email ${e.id}`,
            text: [m.subject, m.text, pageText(m.html || "")].join("\n"),
          };
        });

      sources = [...site, ...emails];
      orderPage = readFileSync(join(out, "order", "index.html"), "utf8");
    });

    after(() => rmSync(out, { recursive: true, force: true }));

    // Done when 1.
    it("no customer-facing text uses \"pickup\" as a modifier; every " +
      "modifier reads \"pick-up\"", () => {
      const found = scan(sources, MODIFIER, () => false);

      assert.equal(found.length, 0, report(found));
    });

    // Done when 2.
    it("\"Pick-up days\" names the days in the aggregate and \"Pick-up " +
      "day\" a single day, wherever the site names them", () => {
      // The days as a way to get an order, in the aggregate: the name
      // every email, slip and account row prints for it, and the
      // order page's choice and cart pick.
      const named = ["scheduled", "scituate", "market"]
        .map((way) => [way, methodName(way)])
        .filter(([, name]) => name !== "Pick-up days")
        .map(([way, name]) => `methodName("${way}") is "${name}"`);

      const title = orderPage.match(
        /id="method-scheduled-title"[^>]*>([^<]*)</)?.[1].trim();
      const pick = orderPage.match(
        /data-way="scheduled"[^>]*>([^<]*)</)?.[1].trim();

      if (title !== "Pick-up days") {
        named.push(`the order page's method title is "${title}"`);
      }
      if (pick !== "Pick-up days") {
        named.push(`the order page's cart pick is "${pick}"`);
      }

      // A single day, wherever the site or an email names one.
      const single = scan(sources, SINGLE,
        (m) => /^pick-up day$/i.test(m[1].replace(/\s+/g, " ")));

      const found = [...named, ...single];

      assert.equal(found.length, 0, report(found));
    });
  });
