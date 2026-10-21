#!/usr/bin/env node
// Clean every tracked SVG with SVGO and the settings in
// svgo.config.mjs (#295), or check that each already is.
//
//   node bin/svg/clean.mjs [files...]           npm run svg:clean
//   node bin/svg/clean.mjs --check [files...]   npm run check:svg
//
// With no files it takes every tracked .svg outside EXCLUDE, each with
// its override in svgo.config.mjs, and the check also fails on an
// <svg> written by hand in a template. The check fails when a file
// differs from what the clean-up would write.
//
// Before it drops a class or an id, it looks for that name in the
// project's stylesheets, scripts, templates, content and tests. A
// name in use stops the run and says where: give the file an override
// in svgo.config.mjs with the reason, or point the reference at
// something SVGO keeps. See docs/svg.md.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { optimize } from "svgo";

import { configFor } from "../../svgo.config.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

// Not cleaned. James's original vectors are the record of what he
// supplied, kept as they came (docs/media-provenance.md); nothing
// serves them, and bin/logos/build.mjs reads their ids and their
// Inkscape bounds. Its outputs are cleaned.
export const EXCLUDE = ["bin/logos/originals/"];

// Where a class or id the site uses would be named. SVGs and the
// files that write them are left out: they hold the names they make,
// not uses of them.
const CORPUS = /\.(s?css|m?js|html|md|json|toml|ya?ml)$/;
const NOT_CORPUS = [
  /\.svg$/,
  /^bin\/svg\//,
  /^bin\/logos\//,
  /^bin\/favicons\//,
  /^svgo\.config\.mjs$/,
  /^netlify\/functions\/lib\/gate-logo\.mjs$/,
  /^test\/svg\.test\.mjs$/,
  /^test\/fixtures\/svg\//,
  /^docs\//,
  /^package(-lock)?\.json$/,
];

const git = (...args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean);

export const trackedSvgs = () => git("ls-files", "*.svg")
  .filter((file) => !EXCLUDE.some((dir) => file.startsWith(dir)));

export const corpus = () => git("ls-files")
  .filter((file) => CORPUS.test(file))
  .filter((file) => !NOT_CORPUS.some((re) => re.test(file)))
  .map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }));

export const clean = (markup, path) =>
  optimize(markup, { ...configFor(path), path }).data;

const names = (markup, attr) => new Set([...markup.matchAll(
  new RegExp(`\\s${attr}="([^"]*)"`, "g"))]
  .flatMap((m) => m[1].split(/\s+/)).filter(Boolean));

const lost = (before, after, attr) => {
  const kept = names(after, attr);

  return [...names(before, attr)].filter((name) => !kept.has(name));
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The ways a stylesheet, script or template names a class or an id: a
// selector (.name, #name, [class~=name]) or the name as a whole
// quoted string (classList, getElementById, a class attribute).
export const usePattern = (name) => {
  const n = escape(name);

  // A dot after a word is a property (still.ring), not a selector.
  return new RegExp(
    `(?<![\\w$)\\]])[.#]${n}(?![\\w-])` +
    `|\\[(?:class|id)[~*^$|]?=["']?${n}(?![\\w-])` +
    `|["'\`]${n}["'\`]|class="(?:[^"]*\\s)?${n}(?:\\s[^"]*)?"`);
};

export const uses = (name, files) => {
  const re = usePattern(name);

  return files.filter(({ text }) => re.test(text)).map(({ file }) => file);
};

// The classes and ids the clean-up drops that something still names.
export const guard = (before, after, files) => [
  ...lost(before, after, "class").map((name) => ({ kind: "class", name })),
  ...lost(before, after, "id").map((name) => ({ kind: "id", name })),
].map((hit) => ({ ...hit, files: uses(hit.name, files) }))
  .filter((hit) => hit.files.length);

// Every SVG in markup comes from a file through partials/svg.html
// (#295): a template or a content file that writes an <svg> element
// by hand fails the check. Each exception says why.
export const INLINE_ALLOWED = {
  "layouts/partials/svg.html": "the partial that writes them",
  "layouts/partials/map.html": "Hugo builds the map from data/map.json, " +
    "the delivery tiers and the market schedule on every build: each ZIP " +
    "is a path with its tier's class and data attributes, and each " +
    "place a pin; no file could hold it",
};

const INLINE_IN = /^(layouts|content)\/.*\.(html|md)$/;
const SVG_TAG = /<svg[\s>/]/i;

// The template lines that write an <svg> by hand: [{ file, line }].
// A Go template comment ({{/* ... */}}) is not markup and is skipped.
export const inlineSvgs = (files) => files
  .filter(({ file }) => INLINE_IN.test(file))
  .filter(({ file }) => !Object.hasOwn(INLINE_ALLOWED, file))
  .flatMap(({ file, text }) => {
    const bare = text.replace(/{{-?\s*\/\*[\s\S]*?\*\/\s*-?}}/g,
      (comment) => comment.replace(/[^\n]/g, " "));

    return bare.split("\n").flatMap((line, i) =>
      SVG_TAG.test(line) ? [{ file, line: i + 1 }] : []);
  });

const templates = () => git("ls-files", "layouts", "content")
  .map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }));

// Each file's verdict: { file, clean, changed, blocked }.
export const run = (files, { check = false, read, write, ...rest } = {}) => {
  const text = rest.corpus ?? corpus();
  const load = read ?? ((file) => readFileSync(join(ROOT, file), "utf8"));
  const save = write ?? ((file, data) => writeFileSync(join(ROOT, file),
    data));

  return files.map((file) => {
    const before = load(file);
    const after = clean(before, file);
    const blocked = guard(before, after, text);
    const changed = after !== before;

    if (!check && changed && !blocked.length) save(file, after);

    return { file, changed, blocked };
  });
};

const main = (args) => {
  const check = args.includes("--check");
  const given = args.filter((arg) => arg !== "--check")
    .map((file) => relative(ROOT, resolve(file)));
  const files = given.length
    ? given.filter((file) => !EXCLUDE.some((dir) => file.startsWith(dir)))
    : trackedSvgs();
  const results = run(files, { check });
  let failed = false;

  for (const { file, changed, blocked } of results) {
    for (const { kind, name, files: where } of blocked) {
      failed = true;
      console.error(`${file}: SVGO would drop the ${kind} "${name}", ` +
        `which ${where.join(", ")} uses. Keep it (OVERRIDES in ` +
        "svgo.config.mjs) or stop naming it; see docs/svg.md.");
    }
    if (check && changed) {
      failed = true;
      console.error(`${file}: not cleaned. Run npm run svg:clean.`);
    } else if (changed && !blocked.length) {
      console.log(`cleaned ${file}`);
    }
  }
  const dirty = results.filter((r) => r.changed).length;

  // The whole-project check also holds templates to the partial.
  if (check && !given.length) {
    for (const { file, line } of inlineSvgs(templates())) {
      failed = true;
      console.error(`${file}:${line}: an <svg> written by hand. Put the ` +
        "drawing in a file and include it with partials/svg.html; see " +
        "docs/svg.md.");
    }
  }

  console.log(check
    ? `check:svg: ${results.length} SVG(s), ${dirty} not cleaned.`
    : `svg:clean: ${results.length} SVG(s), ${dirty} changed.`);
  if (failed) process.exit(1);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
