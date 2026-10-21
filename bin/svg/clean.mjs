#!/usr/bin/env node
// Clean every tracked SVG with SVGO and the settings in
// svgo.config.mjs (#295), or check that each already is.
//
//   node bin/svg/clean.mjs [files...]           npm run svg:clean
//   node bin/svg/clean.mjs --check [files...]   npm run check:svg
//
// With no files it takes every tracked .svg outside EXCLUDE. The
// check fails when a file differs from what the clean-up would write.
//
// Before it drops a class or an id, it looks for that name in the
// project's stylesheets, scripts, templates, content and tests. A
// name in use stops the run and says where: add the class to KEEP in
// bin/svg/strip.mjs with the reason, or point the reference at
// something SVGO keeps. See docs/svg.md.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { optimize } from "svgo";

import config from "../../svgo.config.mjs";

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

export const clean = (markup, path) => optimize(markup, { ...config, path })
  .data;

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
        `which ${where.join(", ")} uses. Keep it (bin/svg/strip.mjs, ` +
        "KEEP) or stop naming it; see docs/svg.md.");
    }
    if (check && changed) {
      failed = true;
      console.error(`${file}: not cleaned. Run npm run svg:clean.`);
    } else if (changed && !blocked.length) {
      console.log(`cleaned ${file}`);
    }
  }
  const dirty = results.filter((r) => r.changed).length;

  console.log(check
    ? `check:svg: ${results.length} SVG(s), ${dirty} not cleaned.`
    : `svg:clean: ${results.length} SVG(s), ${dirty} changed.`);
  if (failed) process.exit(1);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
