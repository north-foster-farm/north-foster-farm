#!/usr/bin/env node
// Fails the record-shape check when a range of commits touches the code
// that decides the shape of a stored record and no commit in the range
// says so. A rollback (docs/rollback.md) republishes older code beside
// records the newer code may have written in a new shape, so the
// release's commits must name every such change.
//
// A commit says so with a trailer in its message:
//
//   Record-shape: <what changed>     the shape changed
//   Record-shape: none               touched, but the shape is the same
//
// One such commit anywhere in the range satisfies the check, so "none"
// cannot be skipped silently: a person had to write it. A line that
// tries to be the trailer and is not (`Record shape: x`, an empty
// `Record-shape:`) fails the range whatever it touches.
//
//   node bin/check-record-shape.mjs <base> [<head>] [--warn]
//
// Head defaults to HEAD. Every run fails without the trailer: CI's
// record-shape check on every branch and event, and the pre-push hook
// (.githooks/pre-push), so the agent who wrote the commit fixes it
// before it lands (James, #283). --warn only reports, for an early
// look. --event and --ref, from older callers, are accepted and
// ignored.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Where record shape lives: Blobs stores and keys, the order and
// customer records and their indexes, the code that rewrites or
// removes them, and any data migration. A directory ends in "/".
export const SHAPE_PATHS = [
  "netlify/functions/lib/store.mjs",
  "netlify/functions/lib/records.mjs",
  "netlify/functions/lib/news.mjs",
  "netlify/functions/lib/checkout.mjs",
  "netlify/functions/lib/edit.mjs",
  "netlify/functions/lib/account.mjs",
  "netlify/functions/lib/admin.mjs",
  "netlify/functions/lib/forget.mjs",
  "netlify/functions/lib/retention.mjs",
  "netlify/functions/lib/backup.mjs",
  "netlify/functions/lib/stock.mjs",
  "netlify/functions/lib/packing.mjs",
  "netlify/functions/lib/group-log.mjs",
  "netlify/migrations/",
  "bin/migrations/",
];

export const TRAILER = /^Record-shape:[ \t]*\S/im;

export const touchesShape = (files, paths = SHAPE_PATHS) =>
  files.filter((file) => paths.some((path) =>
    path.endsWith("/") ? file.startsWith(path) : file === path));

// A line that means to be the trailer: any spelling of the key at the
// start of a line, followed by a colon.
const ATTEMPT = /^[ \t]*record[ \t_-]*shape[ \t]*:.*$/gim;
const WELL_FORMED = /^Record-shape:[ \t]*\S/i;

// The attempted trailer lines in a message that are not well formed.
export const malformedTrailers = (message) =>
  (message.match(ATTEMPT) || []).filter((line) => !WELL_FORMED.test(line));

// A commit is { sha, message, files }. Returns
// { ok, touched, trailers, malformed }.
export const checkRange = (commits, paths = SHAPE_PATHS) => {
  const touched = commits
    .map((c) => ({ sha: c.sha, files: touchesShape(c.files, paths) }))
    .filter((c) => c.files.length);
  const trailers = commits.filter((c) => TRAILER.test(c.message));
  const malformed = commits
    .map((c) => ({ sha: c.sha, lines: malformedTrailers(c.message) }))
    .filter((c) => c.lines.length);
  return {
    ok: !malformed.length && (!touched.length || trailers.length > 0),
    touched, trailers, malformed,
  };
};

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

// A push to a new branch, or a force-push that dropped the old tip,
// names a base git no longer has (or all zeros): check against main.
export const resolveBase = (base, exists) =>
  !base || /^0+$/.test(base) || !exists(base) ? "origin/main" : base;

const readRange = (base, head) => {
  const shas = git("rev-list", "--reverse", "--no-merges", `${base}..${head}`)
    .split("\n").filter(Boolean);
  return shas.map((sha) => ({
    sha,
    message: git("log", "-1", "--format=%B", sha),
    files: git("diff-tree", "--no-commit-id", "--name-only", "-r",
      "--root", sha).split("\n").filter(Boolean),
  }));
};

// Every run is strict, whatever the event or branch: a lenient run on
// next once let a commit without its trailer land, to fail only on the
// way to main. Only --warn reports without failing.
export const modeFor = ({ warn = false } = {}) => warn ? "warn" : "strict";

const option = (args, name) => {
  const at = args.indexOf(name);

  return at === -1 ? "" : args.splice(at, 2)[1] ?? "";
};

const flag = (args, name) => {
  const at = args.indexOf(name);

  if (at !== -1) args.splice(at, 1);
  return at !== -1;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  option(args, "--event");
  option(args, "--ref");
  const mode = modeFor({ warn: flag(args, "--warn") });
  const [arg, head = "HEAD"] = args;
  const exists = (sha) => {
    try {
      git("cat-file", "-e", `${sha}^{commit}`);
      return true;
    } catch {
      return false;
    }
  };
  const result = checkRange(readRange(resolveBase(arg, exists), head));
  if (!result.ok) {
    const say = mode === "warn" ? console.log : console.error;

    if (mode === "warn") {
      say("::warning title=Record-shape::Record-shape trailer missing " +
        "or malformed. The push will be refused without one.");
    }
    for (const { sha, lines } of result.malformed) {
      const quoted = lines.map((line) => JSON.stringify(line.trim()));

      say(`Record-shape: ${sha.slice(0, 7)} has a malformed trailer: ${
        quoted.join(", ")}`);
    }
    if (result.touched.length && !result.trailers.length) {
      say("Record-shape: this range touches record-shape code and " +
        "no commit carries a Record-shape trailer.");
      for (const { sha, files } of result.touched) {
        say(`  ${sha.slice(0, 7)}  ${files.join(", ")}`);
      }
    }
    say("Write 'Record-shape: <what changed>' (or 'Record-shape: " +
      "none') in one commit message, exactly so spelled. See " +
      "docs/rollback.md.");
    if (mode === "strict") process.exit(1);
    console.log("Record-shape: warning only; passing.");

    process.exit(0);
  }
  console.log(result.touched.length
    ? `Record-shape: ${result.trailers.length} trailer(s) cover ` +
      `${result.touched.length} commit(s) touching record shape.`
    : "Record-shape: no commit touches record-shape code.");
}
