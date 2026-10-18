#!/usr/bin/env node
// Fails a lint-and-test run when a range of commits touches the code
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
// cannot be skipped silently: a person had to write it.
//
//   node bin/check-record-shape.mjs <base> [<head>]   head defaults to HEAD

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Where record shape lives: Blobs stores and keys, the order and
// customer records and their indexes, the code that rewrites or
// removes them, and any data migration. A directory ends in "/".
export const SHAPE_PATHS = [
  "netlify/functions/lib/store.mjs",
  "netlify/functions/lib/records.mjs",
  "netlify/functions/lib/checkout.mjs",
  "netlify/functions/lib/edit.mjs",
  "netlify/functions/lib/account.mjs",
  "netlify/functions/lib/admin.mjs",
  "netlify/functions/lib/forget.mjs",
  "netlify/functions/lib/backup.mjs",
  "netlify/functions/lib/stock.mjs",
  "netlify/migrations/",
  "bin/migrations/",
];

export const TRAILER = /^Record-shape:[ \t]*\S/im;

export const touchesShape = (files, paths = SHAPE_PATHS) =>
  files.filter((file) => paths.some((path) =>
    path.endsWith("/") ? file.startsWith(path) : file === path));

// A commit is { sha, message, files }. Returns { ok, touched, trailers }.
export const checkRange = (commits, paths = SHAPE_PATHS) => {
  const touched = commits
    .map((c) => ({ sha: c.sha, files: touchesShape(c.files, paths) }))
    .filter((c) => c.files.length);
  const trailers = commits.filter((c) => TRAILER.test(c.message));
  return { ok: !touched.length || trailers.length > 0, touched, trailers };
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [arg, head = "HEAD"] = process.argv.slice(2);
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
    console.error("Record-shape: this range touches record-shape code and " +
      "no commit carries a Record-shape trailer.");
    for (const { sha, files } of result.touched) {
      console.error(`  ${sha.slice(0, 7)}  ${files.join(", ")}`);
    }
    console.error("Add 'Record-shape: <what changed>' (or 'Record-shape: " +
      "none') to one commit message. See docs/rollback.md.");
    process.exit(1);
  }
  console.log(result.touched.length
    ? `Record-shape: ${result.trailers.length} trailer(s) cover ` +
      `${result.touched.length} commit(s) touching record shape.`
    : "Record-shape: no commit touches record-shape code.");
}
