// The legacy lists of #782 step 3 (the proposal, issuecomment-7075114694,
// section 2): quality/legacy/<gate>.txt names the files not yet brought
// up to that gate, one path to a line, written once when the gate was
// switched on. A line may carry a stall marker after the path:
//
//   path # stall PR-<number> c<comment id>
//
// the pull request the stall valve was opened for and its entry on #791
// (rule exceptions log). The hook also accepts " # stall" alone, since
// a pull request has no number when its first commit is made.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const LISTS = "quality/legacy";

// Each gate is one ESLint rule, at James's figures (2026-11-22).
export const LIMITS = {
  "max-lines-per-function": 25,
  "max-lines": 300,
  "max-depth": 2,
  "max-params": 4,
};

// Function and file length are off in tests (James, 2026-11-23,
// #782 issuecomment-7095277804); nesting and parameters hold there.
export const LENGTHS = ["max-lines-per-function", "max-lines"];
export const TESTS = ["test/**", "e2e/**"];

const MARKER = /^(?<path>[^#]+?)\s*(?:#\s*stall(?<rest>.*))?$/;

// One list line: its path, and its stall marker if it has one.
export const parseLine = (line) => {
  const match = MARKER.exec(line.trim());
  if (!match) return null;
  const { path, rest } = match.groups;
  if (rest === undefined) return { path, stall: null };
  const pr = /PR-(\d+)/.exec(rest)?.[1] ?? null;
  const entry = /\bc(\d+)\b/.exec(rest)?.[1] ?? null;
  return { path, "stall": { "pr": pr && Number(pr), entry } };
};

// A list's text as its entries, blank lines and # comments skipped.
export const parseList = (text) => text.split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map(parseLine)
  .filter(Boolean);

// Every list in a folder as { gate: entries }, read from the disk.
export const readLists = (root) => {
  const folder = join(root, LISTS);
  if (!existsSync(folder)) return {};
  return Object.fromEntries(readdirSync(folder)
    .filter((name) => name.endsWith(".txt"))
    .map((name) => [name.slice(0, -".txt".length),
      parseList(readFileSync(join(folder, name), "utf8"))]));
};
