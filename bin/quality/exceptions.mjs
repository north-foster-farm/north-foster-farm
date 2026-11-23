#!/usr/bin/env node
// The check run as npm run check:exceptions (#782 step 3; the
// proposal, issuecomment-7075114694, section 2). Every exception is
// logged on #791 (rule exceptions log) and cites its entry, so this
// fails on:
// - a disable directive that names no rule, or cites no #791 c<id>;
// - any @ts-ignore or @ts-nocheck;
// - an exclusion in a config with no citation beside it;
// - in a pull request or on a push, a stall marker with no #791 entry
//   (the hook accepts one, since the entry may not exist yet;
//   coordinator, 2026-11-23, provisional for James).
// A directive that no longer suppresses anything is ESLint's and
// Stylelint's own error (step 1).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { git, changeOf } from "./change.mjs";
import { directiveFaults, kindOf } from "./directives.mjs";
import { configFaults } from "./configs.mjs";
import { LISTS, readLists } from "./lists.mjs";

const root = process.cwd();

// The folders ESLint's config leaves out as never source.
const skipped = () => {
  const load = createRequire(import.meta.url);
  const config = load(join(root, "eslint.config.js"));
  const only = (block) => block.ignores && Object.keys(block).length === 1;
  return config.find(only)?.ignores ?? [];
};

const files = () => {
  const skip = skipped();
  return git(["ls-files", "-c", "-z"]).split("\0").filter(Boolean)
    .filter((path) => !skip.some((folder) => path.startsWith(folder)));
};

const readable = (path) => {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
};

const fileFaults = (path) => {
  const text = readable(path);
  const kind = text === null ? null : kindOf(path, text.split("\n", 1)[0]);
  if (!kind) return [];
  return directiveFaults(kind, text)
    .map((f) => `${path}:${f.line}: ${f.fault}`);
};

const markerFaults = () => {
  if (changeOf().kind === "hook") return [];
  return Object.entries(readLists(root)).flatMap(([gate, entries]) => entries
    .filter((e) => e.stall && !e.stall.entry)
    .map((e) => `${LISTS}/${gate}.txt: ${e.path}: a stall marker with no ` +
      "#791 entry (c<id>)"));
};

const tracked = files();
const faults = [
  ...tracked.flatMap(fileFaults),
  ...markerFaults(),
  ...configFaults(root, tracked),
];
for (const line of faults) console.error(line);
if (faults.length) {
  console.error(`check:exceptions: ${faults.length} to fix`);
  process.exit(1);
}
