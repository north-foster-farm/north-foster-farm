#!/usr/bin/env node
// The unit tests' coverage as a report: overall, and of the lines a
// change adds (#450). Insight, never a gate: it exits 0 whatever the
// figures, and with a note in place of a table when it cannot tell.
//
//   node bin/coverage/report.mjs [--base <ref>] [--notice] [lcov.info]
//
// It reads the lcov file `npm run coverage` writes (coverage/lcov.info
// by default). With --base, the changed lines are those `git diff`
// adds from <ref> to HEAD, and only lines the coverage instruments
// count: a template, a doc or a comment has none. It prints markdown
// for a check summary, or with --notice one workflow annotation line.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LISTED = 10;

// Each file's instrumented lines from an lcov file, as a map of path,
// relative to `root`, to a map of line number to hit count.
export const parseLcov = (text, root = ROOT) => {
  const files = new Map();
  let lines = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();

    if (line.startsWith("SF:")) {
      const path = line.slice(3);
      const key = isAbsolute(path) ? relative(root, path) : path;

      lines = files.get(key) || new Map();
      files.set(key, lines);
    } else if (line.startsWith("DA:") && lines) {
      const [number, hits] = line.slice(3).split(",").map(Number);

      lines.set(number, Math.max(lines.get(number) || 0, hits));
    } else if (line === "end_of_record") {
      lines = null;
    }
  }

  return files;
};

// The lines a zero-context unified diff adds, as a map of the new path
// to a set of line numbers. A deleted file has no new path.
export const addedLines = (diff) => {
  const files = new Map();
  let lines = null;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);

      lines = path.startsWith("b/") ? new Set() : null;
      if (lines) files.set(path.slice(2), lines);
      continue;
    }

    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);

    if (hunk && lines) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);

      for (let n = start; n < start + count; n++) lines.add(n);
    }
  }

  return files;
};

const tally = (hits) => {
  let covered = 0;

  for (const count of hits) if (count > 0) covered++;

  return { covered, total: hits.length };
};

// Overall coverage, and, given the added lines, the changed lines'
// coverage with each changed file's uncovered line numbers.
export const summarize = (coverage, added) => {
  const overall = tally(
    [...coverage.values()].flatMap((lines) => [...lines.values()]),
  );

  if (!added) return { overall };

  const files = [];

  for (const [path, numbers] of added) {
    const lines = coverage.get(path);

    if (!lines) continue;

    const measured = [...numbers]
      .filter((n) => lines.has(n))
      .sort((a, b) => a - b);

    if (!measured.length) continue;

    files.push({
      path,
      ...tally(measured.map((n) => lines.get(n))),
      uncovered: measured.filter((n) => lines.get(n) === 0),
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  const changed = files.reduce(
    (sum, f) => ({
      covered: sum.covered + f.covered, total: sum.total + f.total,
    }),
    { covered: 0, total: 0 },
  );

  return { overall, changed, files };
};

export const percent = ({ covered, total }) =>
  total ? `${(100 * covered / total).toFixed(1)}%` : "n/a";

const figure = (t) => t.total
  ? `${percent(t)} (${t.covered.toLocaleString("en-US")} of `
    + `${t.total.toLocaleString("en-US")})`
  : "no measured lines";

// "3-5, 9" from [3, 4, 5, 9].
export const ranges = (numbers) => {
  const parts = [];

  for (let i = 0; i < numbers.length; i++) {
    let j = i;

    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    parts.push(i === j ? `${numbers[i]}` : `${numbers[i]}-${numbers[j]}`);
    i = j;
  }

  return parts.join(", ");
};

export const markdown = ({ overall, changed, files }) => {
  const out = [
    "### Coverage",
    "",
    "Unit tests under c8. Report only: nothing fails on these figures.",
    "",
    "| | Lines |",
    "| --- | --- |",
    `| Overall | ${figure(overall)} |`,
  ];

  if (changed) out.push(`| Changed lines | ${figure(changed)} |`);
  if (!files?.length) return `${out.join("\n")}\n`;

  out.push(
    "",
    "| Changed file | Covered | Uncovered lines |",
    "| --- | --- | --- |",
  );

  for (const f of files.slice(0, LISTED)) {
    out.push(`| \`${f.path}\` | ${figure(f)} | ${ranges(f.uncovered)} |`);
  }

  if (files.length > LISTED) {
    out.push("", `And ${files.length - LISTED} more changed files.`);
  }

  return `${out.join("\n")}\n`;
};

export const notice = ({ overall, changed }) => {
  const parts = [`overall ${percent(overall)}`];

  if (changed) parts.push(`changed lines ${percent(changed)}`);

  return `::notice title=Coverage::${parts.join(", ")}`;
};

export const run = (args, { read = readFileSync, git } = {}) => {
  let base = null;
  let lcov = join(ROOT, "coverage", "lcov.info");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base") base = args[++i];
    else if (!args[i].startsWith("--")) lcov = args[i];
  }

  const asNotice = args.includes("--notice");
  const diff = git || ((ref) => execFileSync(
    "git", ["diff", "-U0", "--no-color", "--no-ext-diff", ref, "HEAD"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ));

  let report;

  try {
    report = summarize(
      parseLcov(read(lcov, "utf8")),
      base ? addedLines(diff(base)) : null,
    );
  } catch (error) {
    return asNotice
      ? "::notice title=Coverage::no report"
      : `### Coverage\n\nNo report: ${error.message}\n`;
  }

  return asNotice ? notice(report) : markdown(report);
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  console.log(run(process.argv.slice(2)).trimEnd());
}
