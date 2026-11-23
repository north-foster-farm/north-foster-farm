// Criteria test for #782 step 3's push range (PR #1009), from
// security's review: a push base equal to HEAD is not a range. Ruled
// by the coordinator on 2026-11-23 (PROVISIONAL, for James): the check
// on touched files falls back to HEAD's first parent and says it fell
// back, exactly as for a base that is unset or unusable, so a commit
// that breaks a limit still fails. Today a base of HEAD checks zero
// files and says nothing.
//
// The seam, as test/quality-frame.test.mjs has it: `npm run
// check:touched` in a scratch copy of the working tree, on a branch
// named next with refs/remotes/origin/next at it and no pull ref (a
// push), the base in NFF_QUALITY_PUSH_BEFORE, and only PATH and HOME
// besides; a listed file that a change touches meets every limit as a
// whole file, and a fallback is said in "fell back" or "falls back".
//
// Held out of runs as quality-frame-range.criteria.mjs until the
// implementer renames it to quality-frame-range.test.mjs.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync,
  mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LISTS = "quality/legacy";
const PUSH_BASE = "NFF_QUALITY_PUSH_BEFORE";
const FELL_BACK = /fell back|falls back|falling back/i;
// A listed file that breaks max-params (5 parameters, the limit 4).
const LISTED = "assets/scripts/zz-range-listed.js";
const BROKEN = "export const zzRangeParams = (a, b, c, d, e) => a + e;\n";
const TOUCH = "export const zzRangeAdded = (value) => value + 1;\n";

const runIn = (cwd, command, args, more = {}) => spawnSync(command, args, {
  cwd, "encoding": "utf8", "maxBuffer": 64 * 1024 * 1024,
  "env": { "PATH": process.env.PATH, "HOME": process.env.HOME,
    "npm_config_script_shell": "/bin/sh", ...more },
});
const output = (r) => `${r.stdout}\n${r.stderr}`;
const report = (r) => `exit ${r.status}\n${output(r)}`.slice(-4000);
const GIT_CONFIG = ["-c", "user.name=criteria", "-c",
  "user.email=criteria@example.invalid", "-c", "commit.gpgsign=false",
  "-c", "core.hooksPath=/dev/null"];
const gitIn = (cwd, args) => {
  const r = runIn(cwd, "git", [...GIT_CONFIG, ...args]);

  assert.equal(r.status, 0, `git ${args.join(" ")}\n${report(r)}`);

  return r.stdout.trim();
};

// The working tree, tracked and untracked files but not ignored ones,
// committed once in a repository of its own; node_modules linked in.
const copyTree = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "nff-range-")));
  const paths = gitIn(root, ["ls-files", "-co", "--exclude-standard", "-z"])
    .split("\0").filter((p) => p && existsSync(join(root, p)));

  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { "recursive": true });
    if (lstatSync(join(root, p)).isSymbolicLink()) {
      symlinkSync(readlinkSync(join(root, p)), join(dir, p));
    } else {
      copyFileSync(join(root, p), join(dir, p));
    }
  }
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  gitIn(dir, ["init", "-q", "-b", "next"]);
  appendFileSync(join(dir, ".git/info/exclude"), "node_modules\n");

  return dir;
};

const commitAll = (dir, message) => {
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "--allow-empty", "-m", message]);
};

// The tree with LISTED on every list, then one commit that touches it,
// pushed to next.
const seed = (dir) => {
  writeFileSync(join(dir, LISTED), BROKEN);
  const lists = readdirSync(join(dir, LISTS)).filter((f) => f.endsWith(".txt"));

  assert.notDeepEqual(lists, [], `no list under ${LISTS}/`);
  for (const list of lists) {
    const path = join(dir, LISTS, list);
    const text = readFileSync(path, "utf8");

    writeFileSync(path, `${text}${text.endsWith("\n") ? "" : "\n"}${LISTED}\n`);
  }
  commitAll(dir, "before");
  appendFileSync(join(dir, LISTED), TOUCH);
  commitAll(dir, "change");
  gitIn(dir, ["update-ref", "refs/remotes/origin/next", "HEAD"]);
};

let scratch;

before(() => {
  scratch = copyTree();
  seed(scratch);
});

after(() => {
  if (scratch) rmSync(scratch, { "recursive": true, "force": true });
});

const touchedWith = (base) => runIn(scratch, "npm",
  ["run", "--silent", "check:touched"], { [PUSH_BASE]: base });

const failsAndFallsBack = (r, how) => {
  assert.notEqual(r.status, 0, `${how}: the check fails\n${report(r)}`);
  assert.ok(output(r).includes(LISTED), `${how}: it names ${LISTED}\n` +
    `${report(r)}`);
  assert.ok(FELL_BACK.test(output(r)), `${how}: it says it fell back to ` +
    `the first parent\n${report(r)}`);
};

describe("#782 step 3: a push base equal to HEAD is not a range", () => {
  it("a push base equal to HEAD falls back to the first parent and says " +
    "so, so a commit that breaks a limit still fails", () => {
    failsAndFallsBack(touchedWith(gitIn(scratch, ["rev-parse", "HEAD"])),
      "HEAD's full id");
    failsAndFallsBack(touchedWith(gitIn(scratch,
      ["rev-parse", "--short", "HEAD"])), "HEAD's abbreviated id");
  });
});
