// Criteria tests for #709 (Farm-copy sheet footer sits inside the
// 0.5 in margin), one per "Done when" box, named for it. Held out of
// npm test as packing-footer.criteria.mjs; the implementer turns them
// on by renaming the file packing-footer.test.mjs.
//
// They read the packet's PDF as the printer gets it: each page's
// content stream (pdf.mjs writes them uncompressed), its text drawn
// as `BT <colour> /F<n> <size> Tf <x> <y> Td (<text>) Tj ET 0 g`, with
// `y` the baseline in points up from the bottom edge.
//
// The hashes below were recorded from origin/next at 11cc569c (Send
// one packing email per kind of fulfillment), before the fix, by the
// `record` helper at the foot of this file: they are what "nothing
// else moves" and "unchanged" mean.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { samplePacket } from "../netlify/functions/lib/library.mjs";
import {
  FARM_COPY, packetPdf,
} from "../netlify/functions/lib/packing.mjs";

// Half an inch, in points.
const MARGIN = 36;
// Helvetica's and Helvetica-Bold's descender in the Adobe AFM files,
// in thousandths of the size: the lowest a "p" or "y" reaches below
// the baseline. The footer's text is wholly clear of the margin when
// its baseline less this much is.
const DESCENDER = 207;

const PAYPAL = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" };
const { now, entries } = samplePacket();

// A packet long enough that the cover, a revision sheet and a slip
// each run onto a second page, so the "(continued)" pages are held
// to the rule too.
const long = () => {
  const base = entries.find((e) => e.kind === "changed");
  const lines = Array.from({ length: 60 }, (_, i) => ({
    sku: `L${i}`, label: `Pick-list item number ${i + 1}`, qty: 1 + (i % 3),
    lineTotal: 10 * (1 + (i % 3)),
  }));

  return [{
    ...base,
    order: { ...base.order, lines },
    changes: lines.map((l) => `Added ${l.label}`),
  }];
};

const PACKETS = {
  sample: () => packetPdf({
    entries, now, title: "Packing slips for Tue, Oct 6", day: "2026-10-06",
    env: PAYPAL,
  }),
  cancelled: () => packetPdf({
    entries: entries.filter((e) => e.kind === "cancelled"), now,
    title: "T", cover: false, env: PAYPAL,
  }),
  long: () => packetPdf({ entries: long(), now, title: "T", env: PAYPAL }),
  coverOnly: () => packetPdf({
    entries, now, title: "T", cover: "only", env: PAYPAL,
  }),
  slips: () => packetPdf({
    entries: entries.filter((e) => e.kind === "new"), now, title: "T",
    cover: false, env: PAYPAL,
  }),
};

// Each page's content stream, in page order: pdf.mjs writes a page's
// contents just before the page, and they are the only streams with a
// bare /Length.
const pagesOf = (bytes) => [...bytes.toString("latin1").matchAll(
  /<< \/Length \d+ >>\nstream\n([\s\S]*?)\nendstream/g,
)].map((m) => m[1].split("\n"));

const TEXT = new RegExp("^BT .*? /(F\\d) ([\\d.]+) Tf ([\\d.-]+) " +
  "([\\d.-]+) Td \\((.*)\\) Tj ET 0 g$");
const textOf = (op) => {
  const m = TEXT.exec(op);

  return m && {
    face: m[1], size: Number(m[2]), x: Number(m[3]), y: Number(m[4]),
    text: m[5],
  };
};

const farmCopy = FARM_COPY.replace("·", "\\267");
// A farm sheet is one under the FARM COPY band, its words at 14 pt.
const isFarm = (page) => page.some((op) => {
  const t = textOf(op);

  return t && t.text === farmCopy && t.size === 14;
});
// The footer's two pieces: the Printed timestamp and the second
// FARM COPY marker, both 8 pt Helvetica.
const footerKind = (op) => {
  const t = textOf(op);

  if (!t || t.size !== 8 || !/^F[12]$/.test(t.face)) return null;
  if (t.text.startsWith("Printed ")) return "printed";
  if (t.text === farmCopy) return "marker";

  return null;
};

const sha = (lines) => createHash("sha256").update(lines.join("\n"))
  .digest("hex").slice(0, 16);

// Every page of every packet, as { packet, page, farm, rest, footer }:
// `rest` hashes the page's ops less its footer, `footer` hashes the
// footer's ops with their heights left out.
const survey = () => Object.entries(PACKETS).flatMap(([packet, make]) =>
  pagesOf(make()).map((ops, i) => {
    const farm = isFarm(ops);
    const foot = farm ? ops.filter(footerKind) : [];

    return {
      packet, page: i + 1, farm, ops, foot,
      rest: sha(ops.filter((op) => !foot.includes(op))),
      footer: sha(foot.map((op) => {
        const t = textOf(op);

        return `${t.face} ${t.size} ${t.x} ${t.text}`;
      })),
    };
  }));

// Recorded from origin/next at 11cc569c.
// The sample's farm sheets are its cover (page 1), Lee's revision
// sheet (3) and Jo's CANCELLED sheet (7); the long packet's are a
// two-page cover and a three-page revision sheet.
const FARM_REST = {
  "sample 1": "b5eee8a7e036a5b6",
  "sample 3": "5d6306db6062fd49",
  "sample 7": "109296f42672a2c6",
  "cancelled 1": "109296f42672a2c6",
  "long 1": "3e0fe902b9263afa",
  "long 2": "28467751329be021",
  "long 3": "99f8ffbeef748f16",
  "long 4": "564fb26ff231dd8e",
  "long 5": "1e06283e3a58c98c",
  "coverOnly 1": "6fc8807f036d458b",
};
const FARM_FOOTER = Object.fromEntries(Object.keys(FARM_REST)
  .map((page) => [page, "7b1cd666eb640e07"]));
// The long packet's slip runs to five pages.
const SLIPS = {
  "sample 2": "283aae8cc8d6a6f1",
  "sample 4": "1f108c2dfe93b213",
  "sample 5": "3a20e9d5d1485b41",
  "sample 6": "4767c60572a76683",
  "sample 8": "1c06a63de69f8f23",
  "long 6": "6b326926db47bae4",
  "long 7": "0956f5e36db56578",
  "long 8": "fcb9c0cb5bd13050",
  "long 9": "ebd814ab0c3f42ca",
  "long 10": "b4b6567bdec66476",
  "slips 1": "283aae8cc8d6a6f1",
  "slips 2": "3a20e9d5d1485b41",
  "slips 3": "4767c60572a76683",
  "slips 4": "1c06a63de69f8f23",
};
const SLIPS_PDF = "23fbbbbb9a223851";

describe("#709 criteria", () => {
  it("On every farm-copy sheet (cover, revision, CANCELLED), the " +
    "footer's timestamp and FARM COPY marker sit wholly at least 0.5 in " +
    "from the bottom edge, and nothing else on those sheets moves", () => {
    const pages = survey();
    const farm = pages.filter((p) => p.farm);

    assert.deepEqual(farm.map((p) => `${p.packet} ${p.page}`),
      Object.keys(FARM_REST), "the same farm sheets as before");
    for (const p of farm) {
      const at = `${p.packet} page ${p.page}`;

      assert.deepEqual(p.foot.map(footerKind).sort(), ["marker", "printed"],
        `${at}: one timestamp and one marker in the footer`);
      for (const op of p.foot) {
        const t = textOf(op);
        const bottom = t.y - DESCENDER * t.size / 1000;

        assert.ok(bottom >= MARGIN, `${at}: the footer's ${footerKind(op)
        } reaches ${(bottom / 72).toFixed(2)} in from the bottom edge, ` +
          "inside the 0.5 in margin");
      }
      assert.equal(p.rest, FARM_REST[`${p.packet} ${p.page}`],
        `${at}: nothing but the footer's height moves`);
      assert.equal(p.footer, FARM_FOOTER[`${p.packet} ${p.page}`],
        `${at}: the footer keeps its words, face, size and x`);
    }
  });

  it("Customer slips are unchanged", () => {
    const slips = survey().filter((p) => !p.farm);

    assert.deepEqual(slips.map((p) => `${p.packet} ${p.page}`),
      Object.keys(SLIPS), "the same slip pages as before");
    for (const p of slips) {
      assert.equal(sha(p.ops), SLIPS[`${p.packet} ${p.page}`],
        `${p.packet} page ${p.page}: the slip is drawn as before`);
    }
    assert.equal(createHash("sha256").update(PACKETS.slips())
      .digest("hex").slice(0, 16), SLIPS_PDF,
    "a packet of slips alone is the same file, byte for byte");
  });
});

// Prints the tables above from the code as it stands:
// RECORD=1 node --test test/packing-footer.criteria.mjs
if (process.env.RECORD) {
  const table = (rows, key) => Object.fromEntries(rows.map((p) => [
    `${p.packet} ${p.page}`, key(p)]));
  const pages = survey();
  const farm = pages.filter((p) => p.farm);

  console.log(JSON.stringify({
    FARM_REST: table(farm, (p) => p.rest),
    FARM_FOOTER: table(farm, (p) => p.footer),
    SLIPS: table(pages.filter((p) => !p.farm), (p) => sha(p.ops)),
    SLIPS_PDF: createHash("sha256").update(PACKETS.slips()).digest("hex")
      .slice(0, 16),
  }, null, 2));
}
