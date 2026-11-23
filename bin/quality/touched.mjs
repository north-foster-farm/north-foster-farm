#!/usr/bin/env node
// The check run as npm run check:touched (#782 step 3; the proposal,
// issuecomment-7075114694, section 2). A file a change adds or
// modifies is held to every gate as a whole file, so one on a legacy
// list fails until it is brought up and its line deleted, and a list
// may only shrink. A file whose line carries a stall marker valid for
// this change is held only on the lines the change adds or changes:
// - in a pull request, a marker naming that pull request and its #791
//   entry;
// - on a push, a marker with its #791 entry;
// - in the commit hook, any marker, since the pull request may not
//   exist yet (coordinator, 2026-11-23, provisional for James).
// A gate whose list the base lacks is being switched on, and holds
// nothing yet.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { LIMITS, LISTS, parseList, readLists } from "./lists.mjs";
import { atBase, changedLines, changeOf, touched } from "./change.mjs";

const root = process.cwd();

const validStall = (change, stall) => {
  if (!stall) return false;
  if (change.kind === "hook") return true;
  if (change.kind === "push") return Boolean(stall.entry);
  return stall.pr === change.pr && Boolean(stall.entry);
};

// Lines added to a list, which may only shrink.
const growth = (change, gate, entries) => {
  const before = new Set(parseList(
    atBase(change, `${LISTS}/${gate}.txt`)).map((e) => e.path));
  return entries.filter((e) => !before.has(e.path)).map((e) =>
    `${e.path}: added to ${LISTS}/${gate}.txt, and a list may only ` +
    "shrink: bring the file up to the gate instead");
};

const listed = (gate, entry) => `${entry.path}: on ${LISTS}/${gate}.txt ` +
  `(${gate}), so it is held to ${gate} as a whole file: bring it up and ` +
  "delete its line, or open the stall valve (#791)";

// ESLint's findings on stalled files, the lists left out.
const unlisted = (files) => {
  let out;
  try {
    out = execFileSync(join(root, "node_modules/.bin/eslint"),
      ["--format", "json", "--no-warn-ignored", "--", ...files], {
        "encoding": "utf8", "maxBuffer": 64 * 1024 * 1024,
        "env": { ...process.env, "NFF_QUALITY_UNLISTED": "1" },
      });
  } catch (error) {
    out = error.stdout;
  }
  return JSON.parse(out);
};

const overlaps = (message, lines) => {
  const end = message.endLine ?? message.line;
  for (let n = message.line; n <= end; n += 1) if (lines.has(n)) return true;
  return false;
};

// A stalled file's findings for its gate on the lines the change made.
const stalledFindings = (change, stalled) => {
  if (!stalled.length) return [];
  const reports = unlisted([...new Set(stalled.map((s) => s.path))]);
  return stalled.flatMap(({ path, gate }) => {
    const report = reports.find((r) => r.filePath === join(root, path));
    const lines = changedLines(change, path);
    return (report?.messages ?? [])
      .filter((m) => m.ruleId === gate && overlaps(m, lines))
      .map((m) => `${path}:${m.line}: ${gate}: ${m.message} (stalled: ` +
        "the lines this change adds or changes are held)");
  });
};

// One gate's list against the change: its growth, its touched files
// that fail, and its touched files the stall valve holds to their lines.
const gateVerdict = (change, files, [gate, entries]) => {
  const hit = entries.filter((e) => files.has(e.path));
  const valid = hit.filter((e) => validStall(change, e.stall));
  return {
    "failures": [...growth(change, gate, entries),
      ...hit.filter((e) => !valid.includes(e)).map((e) => listed(gate, e))],
    "stalled": valid.map((e) => ({ ...e, gate })),
  };
};

const GATES = Object.keys(LIMITS);

// The list files themselves: only the four limits can have one, and
// none is added once the frame is in place, that is once the base
// has any of the four (provisional, for James). The change that first
// writes the four, onto a base with none, switches the frame on.
const listFaults = (change, lists) => {
  const based = GATES.filter((gate) =>
    atBase(change, `${LISTS}/${gate}.txt`) !== null);
  return Object.keys(lists).flatMap((name) => {
    const list = `${LISTS}/${name}.txt`;
    if (!GATES.includes(name)) {
      return [`${list}: only the four limits (${GATES.join(", ")}) ` +
        `can have a legacy list, so ${name} stays on`];
    }
    if (based.length && !based.includes(name)) {
      return [`${list}: added once the frame is in place, and a list ` +
        "is never added, only shrunk"];
    }
    return [];
  });
};

const check = (change) => {
  const files = new Set(touched(change));
  const lists = readLists(root);
  const verdicts = Object.entries(lists)
    .filter(([gate]) => GATES.includes(gate))
    .filter(([gate]) => atBase(change, `${LISTS}/${gate}.txt`) !== null)
    .map((list) => gateVerdict(change, files, list));
  return [...listFaults(change, lists),
    ...verdicts.flatMap((v) => v.failures),
    ...stalledFindings(change, verdicts.flatMap((v) => v.stalled))];
};

const change = changeOf();
if (change.fellBack) {
  console.error("check:touched: no push base it could use " +
    "(NFF_QUALITY_PUSH_BEFORE unset, all zeros, or not an ancestor " +
    "of HEAD), so it fell back to HEAD against its first parent");
}
const failures = check(change);
for (const line of failures) console.error(line);
if (failures.length) {
  console.error(`check:touched: ${failures.length} to fix`);
  process.exit(1);
}
