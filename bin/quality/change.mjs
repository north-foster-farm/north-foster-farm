// What a change is, for check:touched and check:exceptions (#782 step
// 3), told apart by git state alone, since CI runs npm run lint under
// env -i and no GitHub variable reaches it:
// - a pull request: a refs/remotes/pull/<n>/merge ref at HEAD, as
//   actions/checkout leaves it; the change is HEAD against its first
//   parent, the base;
// - the commit hook: staged changes; the change is the index against
//   HEAD;
// - otherwise a push (to next, staging or main): HEAD against its
//   first parent. It is never skipped (coordinator, 2026-11-23,
//   provisional for James).
import { execFileSync } from "node:child_process";

export const git = (args, cwd = process.cwd()) => execFileSync("git", args, {
  cwd, "encoding": "utf8", "maxBuffer": 64 * 1024 * 1024,
  "stdio": ["ignore", "pipe", "ignore"],
});

const tryGit = (args) => {
  try {
    return git(args);
  } catch {
    return null;
  }
};

const pullAtHead = () => {
  const refs = tryGit(["for-each-ref", "--points-at", "HEAD",
    "--format=%(refname)", "refs/remotes/pull"]) ?? "";
  const match = /refs\/remotes\/pull\/(\d+)\/merge/.exec(refs);
  return match ? Number(match[1]) : null;
};

const hasParent = () => tryGit(["rev-parse", "--verify", "-q", "HEAD^1"]);

// { kind: "pr" | "hook" | "push", pr, base }, with base null when the
// change has nothing to compare with (a first commit).
export const changeOf = () => {
  const pr = pullAtHead();
  if (pr !== null) return { "kind": "pr", pr, "base": "HEAD^1" };
  const staged = tryGit(["diff", "--cached", "--name-only"]) ?? "";
  if (staged.trim()) return { "kind": "hook", "pr": null, "base": "HEAD" };
  return { "kind": "push", "pr": null,
    "base": hasParent() ? "HEAD^1" : null };
};

// The diff's arguments: the index against HEAD in the hook, else the
// base against HEAD.
const range = (change) => (change.kind === "hook"
  ? ["--cached", change.base] : [change.base, "HEAD"]);

// The files the change adds or modifies.
export const touched = (change) => {
  if (!change.base) return [];
  return git(["diff", "--name-only", "--diff-filter=AMR", ...range(change)])
    .split("\n").filter(Boolean);
};

// The lines of `file` the change adds or changes, as a Set of numbers.
export const changedLines = (change, file) => {
  const lines = new Set();
  const diff = git(["diff", "-U0", ...range(change), "--", file]);
  for (const hunk of diff.matchAll(/^@@ [^+]*\+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let n = start; n < start + count; n += 1) lines.add(n);
  }
  return lines;
};

// A file's text at the base, or null when the base lacks it.
export const atBase = (change, file) =>
  (change.base ? tryGit(["show", `${change.base}:${file}`]) : null);
