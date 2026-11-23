// Criteria tests for #782 step 3 (quality gates in the build): the
// legacy lists themselves, written before the fix. Security's review
// of #1009 (the frame's implementation) found a dodge: ESLint's config
// turns off whatever rule any quality/legacy/<rule>.txt is named for,
// for the files that list names; check:touched skips a list its base
// lacks, and check:exceptions does not treat a list as an exclusion. So
// a pull request could add quality/legacy/no-eval.txt naming a file and
// turn no-eval off for it, cited nowhere, with both checks passing.
// These tests close it, from the coordinator's brief of 2026-11-23:
// 1. only the four limits can have a legacy list;
// 2. no list can be added once the frame is in place;
// 3. a list is an exclusion, and is cited.
// The frame's other criteria are in quality-frame.criteria.mjs, whose
// header holds for this file too.
//
// PROVISIONAL, for the implementer to change in how these tests run,
// never in what they expect:
// - the scripts' names, check:touched and check:exceptions; a test
//   passes when either fails and names the list (frame);
// - where the lists live, quality/legacy/<rule>.txt (LISTS);
// - the config's own table of limits, the export LIMITS of
//   bin/quality/lists.mjs, which eslint.config.js reads (TABLE); the
//   four names come from there, never from this file;
// - the push run's base, NFF_QUALITY_PUSH_BEFORE (PUSH_BASE), as in
//   quality-frame.criteria.mjs.
//
// PROVISIONAL, for James to overrule:
// - how "the frame is being switched on" is told from "a list is being
//   smuggled in": a change may add a list only when its base has none
//   of the four. A base with one or more of them has the frame in
//   place, so any list it lacks is refused, even one of the four (a
//   list once emptied and deleted never comes back);
// - the citation a list carries is the form every exclusion carries,
//   "#791 c<id>" (CITED), on each list file (as a # comment line, which
//   the lists' reader skips) or beside the block of eslint.config.js
//   that reads them, within NEAR lines of it.
//
// Held out of runs as quality-frame-lists.criteria.mjs until the
// implementer renames it to quality-frame-lists.test.mjs.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync,
  mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const TOUCHED = "check:touched";
const EXCEPTIONS = "check:exceptions";
const LISTS = "quality/legacy";
const TABLE = "bin/quality/lists.mjs";
const CONFIG = "eslint.config.js";
const PUSH_BASE = "NFF_QUALITY_PUSH_BEFORE";
const PR = 1234;
const CITED = /#791 c\d+/;
const NEAR = 8;
const MODES = ["hook", "ci", "push"];

const run = (cwd, command, args, extra = {}) => spawnSync(command, args, {
  cwd, "encoding": "utf8", "maxBuffer": 64 * 1024 * 1024,
  "env": { "PATH": process.env.PATH, "HOME": process.env.HOME,
    "npm_config_script_shell": "/bin/sh", ...extra },
});

const said = (result) => `${result.stdout}\n${result.stderr}`;
const shown = (result) =>
  `exit ${result.status}\n${said(result)}`.slice(-4000);

const GIT = ["-c", "user.name=criteria", "-c",
  "user.email=criteria@example.invalid", "-c", "commit.gpgsign=false",
  "-c", "core.hooksPath=/dev/null"];
let scratch;
const git = (args, cwd = scratch) => {
  const result = run(cwd, "git", [...GIT, ...args]);
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${shown(result)}`);
  return result.stdout;
};

// The scratch copy: the working tree, committed once as "base".
const makeScratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "nff-lists-")));
  const files = git(["ls-files", "-co", "--exclude-standard", "-z"], root)
    .split("\0").filter((file) => file && existsSync(join(root, file)));
  for (const file of files) {
    const from = join(root, file);
    const to = join(dir, file);
    mkdirSync(dirname(to), { "recursive": true });
    if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);
  }
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  git(["init", "-q", "-b", "scratch"], dir);
  appendFileSync(join(dir, ".git/info/exclude"), "node_modules\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "base"], dir);
  git(["tag", "base"], dir);
  return dir;
};

const reset = () => {
  git(["checkout", "-q", "-f", "--detach", "base"]);
  git(["clean", "-fdq"]);
  const refs = git(["for-each-ref", "--format=%(refname)", "refs/remotes",
    "refs/heads/pr", "refs/heads/next"]);
  for (const ref of refs.split("\n").filter(Boolean)) {
    git(["update-ref", "-d", ref]);
  }
};

const read = (path) => readFileSync(join(scratch, path), "utf8");
const put = (path, text) => {
  const abs = join(scratch, path);
  mkdirSync(dirname(abs), { "recursive": true });
  writeFileSync(abs, text.endsWith("\n") ? text : `${text}\n`);
};
const rev = (ref) => git(["rev-parse", ref]).trim();

// Lists at the base, as paths, from the commit tagged base.
const baseLists = () => git(["ls-tree", "--name-only", `base:${LISTS}`])
  .split("\n").filter((name) => name.endsWith(".txt"))
  .map((name) => `${LISTS}/${name}`);

const restore = (paths) => git(["checkout", "base", "--", ...paths]);
const remove = (paths) => git(["rm", "-q", "-r", "--", ...paths]);

// The change, as the hook, a pull request or a push sees it; returns the
// environment the run gets (a push is given its base).
const stage = (mode, { before: start, change }) => {
  reset();
  start?.();
  git(["add", "-A"]);
  git(["commit", "-q", "--allow-empty", "-m", "before"]);
  const parent = rev("HEAD");
  change?.();
  git(["add", "-A"]);
  if (mode === "hook") return {};
  if (mode === "push") {
    git(["commit", "-q", "--allow-empty", "-m", "change"]);
    git(["checkout", "-q", "-B", "next"]);
    git(["update-ref", "refs/remotes/origin/next", "HEAD"]);
    return { [PUSH_BASE]: parent };
  }
  git(["checkout", "-q", "-b", "pr"]);
  git(["commit", "-q", "--allow-empty", "-m", "change"]);
  git(["checkout", "-q", "--detach", parent]);
  git(["merge", "-q", "--no-ff", "pr", "-m", `Merge pr into ${parent}`]);
  git(["update-ref", `refs/remotes/pull/${PR}/merge`, "HEAD"]);
  git(["update-ref", "refs/heads/next", parent]);
  return {};
};

const script = (name, extra) => run(scratch, "npm",
  ["run", "--silent", name], extra);

// The frame's two checks on the staged change.
const frame = (extra) => {
  const results = [TOUCHED, EXCEPTIONS].map((name) =>
    ({ name, "result": script(name, extra) }));
  return {
    "failed": results.some(({ result }) => result.status !== 0),
    "text": results.map(({ result }) => said(result)).join("\n"),
    "log": results.map(({ name, result }) => `${name}: ${shown(result)}`)
      .join("\n"),
  };
};

const failsNaming = (checks, path) => {
  assert.ok(checks.failed, `the frame fails\n${checks.log}`);
  assert.ok(checks.text.includes(path), `it names ${path}\n${checks.log}`);
};

const eslintRules = (path) => {
  const result = run(scratch, join(scratch, "node_modules/.bin/eslint"),
    ["--format", "json", path]);
  let reports;
  try {
    reports = JSON.parse(result.stdout);
  } catch {
    assert.fail(`ESLint gave no JSON\n${shown(result)}`);
  }
  return new Set(reports
    .filter((report) => relative(scratch, report.filePath) === path)
    .flatMap((report) => report.messages.map((m) => m.ruleId)));
};

// The four names, from the config's own table.
const got = {};
const readTable = async () => {
  const file = join(root, TABLE);
  assert.ok(existsSync(file), `${TABLE} holds the config's table of limits`);
  const table = (await import(pathToFileURL(file).href)).LIMITS;
  assert.ok(table && typeof table === "object",
    `${TABLE} exports LIMITS`);
  return Object.keys(table);
};

// The four lists at the base, each one the table names.
const frameLists = () => {
  const found = baseLists();
  const wanted = got.limits.map((rule) => `${LISTS}/${rule}.txt`);
  assert.deepEqual([...found].sort(), [...wanted].sort(),
    `the base holds exactly the four lists under ${LISTS}/`);
  return found;
};

before(() => {
  scratch = makeScratch();
});

after(() => {
  if (scratch) rmSync(scratch, { "recursive": true, "force": true });
});

const EVAL = "assets/scripts/zz-criteria-eval.js";
const evalFile = () => put(EVAL,
  "export const zzCriteriaEval = (text) => eval(text);");

describe("#782 step 3: only the four limits can have a legacy list", () => {
  it("the config's table names exactly the four limits", async () => {
    got.limits = await readTable();
    assert.deepEqual([...got.limits].sort(), ["max-depth", "max-lines",
      "max-lines-per-function", "max-params"], `the table in ${TABLE}`);
  });

  for (const mode of MODES) {
    it(`a list named for any other rule fails the gate, and that rule ` +
      `stays on for the file it names (${mode})`, async () => {
      got.limits ??= await readTable();
      for (const rule of ["no-eval", "max-statements"]) {
        assert.ok(!got.limits.includes(rule), `${rule} is not one of the four`);
        const list = `${LISTS}/${rule}.txt`;
        const extra = stage(mode, {
          "before": evalFile,
          "change": () => put(list, EVAL),
        });
        failsNaming(frame(extra), list);
        if (rule === "no-eval") {
          assert.ok(eslintRules(EVAL).has("no-eval"),
            `ESLint still reports no-eval on ${EVAL}`);
        }
      }
    });
  }

  it("a list named for another rule fails even when the base already " +
    "has it, on a change that touches nothing near it", async () => {
    got.limits ??= await readTable();
    const list = `${LISTS}/no-eval.txt`;
    const extra = stage("ci", {
      "before": () => {
        evalFile();
        put(list, EVAL);
      },
      "change": () => put("assets/scripts/zz-criteria-other.js",
        "export const zzCriteriaOther = 1;"),
    });
    failsNaming(frame(extra), list);
    assert.ok(eslintRules(EVAL).has("no-eval"),
      `ESLint still reports no-eval on ${EVAL}`);
  });
});

describe("#782 step 3: no list can be added once the frame is in place",
  () => {
    for (const mode of MODES) {
      it(`a change that adds one of the four lists, which a base with ` +
        `the others lacks, fails (${mode})`, async () => {
        got.limits ??= await readTable();
        const [list] = frameLists().sort();
        const extra = stage(mode, {
          "before": () => remove([list]),
          "change": () => restore([list]),
        });
        failsNaming(frame(extra), list);
      });

      it(`the commit that first writes the four lists passes, since its ` +
        `base has none of them (${mode})`, async () => {
        got.limits ??= await readTable();
        const all = frameLists();
        const extra = stage(mode, {
          "before": () => remove([LISTS]),
          "change": () => restore(all),
        });
        const checks = frame(extra);
        assert.ok(!checks.failed, `switching the frame on passes\n` +
          `${checks.log}`);
      });
    }
  });

// Where the lists' citation is: on every list file, or beside the block
// of the config that reads them. Returns the file to strip it from and
// the line to strip, or fails when neither carries one.
const citation = () => {
  const all = frameLists();
  if (all.every((list) => CITED.test(read(list)))) {
    return { "path": all.sort()[0], "line": null };
  }
  const lines = read(CONFIG).split("\n");
  const anchor = lines.findLastIndex((line) =>
    /readLists\s*\(|["'`]quality\/legacy/.test(line));
  assert.ok(anchor >= 0, `${CONFIG} reads the lists`);
  const near = lines.map((line, i) => ({ line, i }))
    .filter(({ line, i }) => CITED.test(line) && Math.abs(i - anchor) <= NEAR);
  assert.notDeepEqual(near, [], "each list, or the block of " +
    `${CONFIG} that reads them, carries a #791 citation`);
  return { "path": CONFIG, "line": near[0].i };
};

const strip = ({ path, line }) => {
  const lines = read(path).split("\n");
  const uncite = (text) => text.replace(new RegExp(CITED.source, "g"),
    "#791");
  const kept = lines.map((text, i) =>
    (line === null || i === line ? uncite(text) : text));
  put(path, kept.join("\n"));
};

describe("#782 step 3: a list is an exclusion, and is cited", () => {
  it("each list, or the block that reads them, carries its citation",
    async () => {
      got.limits ??= await readTable();
      reset();
      citation();
    });

  it("check:exceptions fails when the lists' citation is taken away",
    async () => {
      got.limits ??= await readTable();
      reset();
      const where = citation();
      stage("hook", { "change": () => strip(where) });
      const result = script(EXCEPTIONS);
      assert.notEqual(result.status, 0, `the check fails\n${shown(result)}`);
      const text = said(result);
      assert.ok(text.includes(where.path) || text.includes(LISTS),
        `it names ${where.path} or the lists\n${shown(result)}`);
    });
});
