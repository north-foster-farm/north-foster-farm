#!/usr/bin/env node
// Write every logo file the site uses from James's original vectors in
// bin/logos/originals/ (#220, L1). Run it from the repository root:
//
//   bin/logos/build.mjs
//
// The originals: wordmark.svg (the wordmark, by an unnamed designer),
// halo-chicken.svg (the hen and the arc) and halo-chicken-wordmark.svg
// (the two on one line). halo-chicken-tight.svg is the hen and arc
// cropped; nothing is built from it. Each output keeps the originals'
// paths as drawn and sets its viewBox to their bounds, as Inkscape
// measures them. Needs Node and Inkscape.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = "bin/logos/originals";
// The header's green, which the emails' wordmark wears.
const EMAIL_GREEN = "#124a32";
// The originals' own green.
const LOGO_GREEN = "#1e7b54";
// The search palette's and the map's hen (#142).
const HEN_GREEN = "#4c6b5c";

const read = (name) => readFileSync(join(SRC, name), "utf8");

// The <path> with this id, as {d, evenodd}.
const path = (svg, id) => {
  const tag = svg.match(new RegExp(`<path id="${id}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`no path ${id}`);
  return {
    d: tag.match(/ d="([^"]+)"/)[1],
    evenodd: tag.includes('fill-rule="evenodd"'),
  };
};

// The bounds of an element, from Inkscape, rounded out to whole units.
const bounds = (file, id) => {
  const out = execFileSync("inkscape", [file, "--query-all"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const row = out.split("\n").find((line) => line.startsWith(`${id},`));
  const [x, y, w, h] = row.split(",").slice(1).map(Number);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);

  return [x0, y0, Math.ceil(x + w) - x0, Math.ceil(y + h) - y0].join(" ");
};

const svg = (viewBox, paths, attrs) => [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">`,
  ...paths.map((p) => `  <path ${attrs}${p.evenodd
    ? ' fill-rule="evenodd"' : ""} d="${p.d}"/>`),
  "</svg>",
  "",
].join("\n");

const write = (file, text) => {
  writeFileSync(file, text);
  console.log(`wrote ${file}`);
};

const tmp = mkdtempSync(join(tmpdir(), "logos-"));
try {
  // The wordmark: the header, and the emails' header as a PNG. The
  // header colors .black; see _header.scss.
  const wordmarkFile = join(SRC, "wordmark.svg");
  const wordmark = path(read("wordmark.svg"), "NORTH-FOSTER-FARM-copy");
  const wordmarkBox = bounds(wordmarkFile, "NORTH-FOSTER-FARM-copy");
  write("assets/images/logo.svg",
    svg(wordmarkBox, [wordmark], 'class="black"'));

  const email = join(tmp, "email.svg");
  writeFileSync(email, svg(wordmarkBox, [wordmark], `fill="${EMAIL_GREEN}"`));
  execFileSync("inkscape", [email, "--export-type=png",
    "--export-width=1200", "--export-filename=static/images/email/logo.png"],
  { stdio: "ignore" });
  console.log("wrote static/images/email/logo.png");

  // The hen and the arc: the header's mark, the README, and the news
  // page's placeholder tiles (#222). The hen alone: search and the map.
  const haloFile = join(SRC, "halo-chicken.svg");
  const halo = read("halo-chicken.svg");
  const hen = path(halo, "Path-copy-2");
  const arc = path(halo, "Path-copy");
  write("assets/images/logo-mark.svg",
    svg(bounds(haloFile, "Group"), [hen, arc], 'class="black"'));
  // The mark as a PNG in the originals' green: the farm's logo in the
  // JSON-LD (params.logo), where some readers take no SVG.
  const mark = join(tmp, "mark.svg");
  writeFileSync(mark, svg(bounds(haloFile, "Group"), [hen, arc],
    `fill="${LOGO_GREEN}"`));
  execFileSync("inkscape", [mark, "--export-type=png",
    "--export-width=512", "--export-filename=assets/images/logo-mark.png"],
  { stdio: "ignore" });
  console.log("wrote assets/images/logo-mark.png");
  write("assets/images/search/hen.svg",
    svg(bounds(haloFile, "Path-copy-2"), [hen], `fill="${HEN_GREEN}"`));

  // The horizontal lockup, served as-is at /logo-horizontal.svg.
  const lockup = read("halo-chicken-wordmark.svg");
  for (const file of ["assets/images/logo-horizontal.svg",
    "static/logo-horizontal.svg"]) {
    write(file, lockup);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
