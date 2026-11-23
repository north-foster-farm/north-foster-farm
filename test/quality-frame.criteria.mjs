// Criteria tests for #782 (quality gates in the build for new and
// changed code), step 3 of the proposal (issuecomment-7075114694),
// written before the implementation: "The frame: quality/legacy/,
// check:touched, check:exceptions, the stall marker, the parity test;
// then James's four core limits on it (function length, nesting,
// parameters, file length)". Section 2 of the proposal, "How a file is
// held", is the spec. Where it differs from James's rulings, the
// rulings win:
// - the issue body (2026-11-21 and 11-22): new code is always held; a
//   modified file is held to every rule, the whole file; the stall
//   valve, which holds only the modified lines, is the one exception
//   and is logged on #791;
// - the limits (2026-11-22): a function at most 25 lines, a file at
//   most 300, nesting at most 2 levels, at most 4 parameters;
// - issuecomment-7095277804 (2026-11-23): in test/ and e2e/ function
//   and file length are off, nesting and parameters hold; server files
//   (netlify/, bin/) get no standing exemption.
// Cognitive complexity is step 7's and is not tested here.
//
// PROVISIONAL, for the implementer to change in how these tests run
// (the constants below), never in what they expect:
// - the scripts' names, check:touched and check:exceptions (TOUCHED,
//   EXCEPTIONS);
// - where the lists live, quality/legacy/<gate>.txt (LISTS). A seeded
//   legacy file is written into every list there, so one list or one
//   per rule both work, and the check may name the gate by the list's
//   name or its path;
// - the marker's exact form, " # stall PR-<number> c<comment id>"
//   after the file's path on its line (stallMarker);
// - the directive forms of section 2, "-- #791 c<id>: reason" (cite);
// - how a change is found. CI runs npm run lint under env -i (ci.yml,
//   lint-and-test), so no GitHub variable reaches the check: the tests
//   give it git state alone. In the hook the change is what is staged.
//   In CI it is a pull request's merge commit, whose first parent is
//   the base, with the ref refs/remotes/pull/<number>/merge at it, as
//   actions/checkout leaves it; the number comes from that ref;
// - the parity test, read as "a test fails when a gate's script exists
//   that npm run lint does not call" (the coordinator's reading of
//   section 2). A gate's script is here one that runs a linter or
//   analyzer of section 1 that runs in lint (GATE_TOOLS), or one of the
//   frame's own two;
// - the limits are ESLint's core rules, as section 1 names them:
//   max-lines-per-function, max-lines, max-depth and max-params
//   (LIMITS), and their findings are read from ESLint's JSON output.
//
// Two cases the coordinator settled for the implementer on 2026-11-23
// (PROVISIONAL, for James to overrule), tested at the end of the file:
// - a run with no pull request ref (a push to next, staging or main):
//   check:touched compares HEAD with its first parent and is not
//   skipped. A touched, listed file with a stall marker has its findings
//   accepted on the changed lines when the marker cites its entry on
//   #791 and refused when it cites none; a touched, listed file with no
//   marker meets every limit as a whole file, as on a pull request. The
//   tests give it a commit on a branch named next, with
//   refs/remotes/origin/next at it, and no pull ref ("push" in stage);
// - the commit hook: a staged change that itself adds a stall marker is
//   accepted by the hook though no pull request number exists yet; the
//   entry on #791 is required in CI, where the number is known. The
//   marker the hook sees, before a number exists, is " # stall" after
//   the path (pendingMarker), also provisional in its form.
// The run tells hook, pull request and push apart by git state alone:
// a pull ref at HEAD is a pull request, else staged changes are the
// hook, else it is a push.
//
// Each case runs in a scratch copy of the working tree (tracked and
// untracked files, not ignored ones) committed once as "base" in a git
// repository of its own under the system's temporary folder, with this
// checkout's node_modules linked in. The real checkout, its index and
// its branches are never touched. Every git and npm run there gets
// PATH and HOME alone, as the hook and CI give them.
//
// Held out of runs as quality-frame.criteria.mjs until the implementer
// renames it to quality-frame.test.mjs. Step 3 stacks on step 1, which
// lints every script (bin/ included) and makes unused directives an
// error.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync,
  mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const TOUCHED = "check:touched";
const EXCEPTIONS = "check:exceptions";
const LISTS = "quality/legacy";
const PR = 1234;
const ENTRY = "c7075001234";
const stallMarker = (pr, entry) =>
  ` # stall PR-${pr}${entry ? ` ${entry}` : ""}`;
const pendingMarker = " # stall";
const cite = `#791 ${ENTRY}: criteria seed`;

const LIMITS = {
  "max-lines-per-function": 25,
  "max-lines": 300,
  "max-depth": 2,
  "max-params": 4,
};
const LENGTHS = ["max-lines-per-function", "max-lines"];
const SHAPES = ["max-depth", "max-params"];

// The linters and analyzers of section 1 that run inside npm run lint
// (the built pages, the workflows and Semgrep run in jobs of their own).
const GATE_TOOLS = ["eslint", "stylelint", "jscpd", "shellcheck",
  "prettier", "knip", "depcruise", "tsc", "markdownlint-cli2"];

const env = () => ({
  "PATH": process.env.PATH,
  "HOME": process.env.HOME,
  "npm_config_script_shell": "/bin/sh",
});

const run = (cwd, command, args) => spawnSync(command, args, {
  cwd, "encoding": "utf8", "env": env(), "maxBuffer": 64 * 1024 * 1024,
});

const said = (result) => `${result.stdout}\n${result.stderr}`;
const shown = (result) =>
  `exit ${result.status}\n${said(result)}`.slice(-4000);

const GIT = ["-c", "user.name=criteria", "-c",
  "user.email=criteria@example.invalid", "-c", "commit.gpgsign=false",
  "-c", "core.hooksPath=/dev/null"];
const git = (cwd, args) => {
  const result = run(cwd, "git", [...GIT, ...args]);
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${shown(result)}`);
  return result.stdout;
};

// The package scripts, and the ones a script reaches through npm run.
const scriptsOf = (dir) =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts ?? {};

const reached = (all, start) => {
  const found = new Set();
  const queue = [start];
  for (let name = queue.shift(); name; name = queue.shift()) {
    if (found.has(name) || !all[name]) continue;
    found.add(name);
    const pattern = /npm\s+(?:run|run-script)\s+(?:-\S+\s+)*([\w:.-]+)/g;
    queue.push(...[...all[name].matchAll(pattern)].map((m) => m[1]));
  }
  return found;
};

const runsTool = (command) => GATE_TOOLS.some((tool) =>
  new RegExp(`(^|[\\s;&|(])(npx\\s+)?${tool}(\\s|$)`).test(command));

// The parity test: every gate's script that npm run lint does not reach.
const orphanGates = (all) => {
  const fromLint = reached(all, "lint");
  return Object.keys(all)
    .filter((name) => runsTool(all[name]) ||
      [TOUCHED, EXCEPTIONS].includes(name))
    .filter((name) => !fromLint.has(name));
};

// The scratch copy.
const copyEntry = (dir, file) => {
  const from = join(root, file);
  const to = join(dir, file);
  mkdirSync(dirname(to), { "recursive": true });
  if (lstatSync(from).isSymbolicLink()) {
    symlinkSync(readlinkSync(from), to);
    return;
  }
  copyFileSync(from, to);
};

const makeScratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "nff-frame-"));
  const files = git(root, ["ls-files", "-co", "--exclude-standard", "-z"])
    .split("\0").filter((file) => file && existsSync(join(root, file)));
  for (const file of files) copyEntry(dir, file);
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  git(dir, ["init", "-q", "-b", "scratch"]);
  appendFileSync(join(dir, ".git/info/exclude"), "node_modules\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["tag", "base"]);
  return dir;
};

let scratch;

const reset = () => {
  git(scratch, ["checkout", "-q", "-f", "--detach", "base"]);
  git(scratch, ["clean", "-fdq"]);
  const refs = git(scratch, ["for-each-ref", "--format=%(refname)",
    "refs/remotes", "refs/heads/pr", "refs/heads/next"]);
  for (const ref of refs.split("\n").filter(Boolean)) {
    git(scratch, ["update-ref", "-d", ref]);
  }
};

// Files and lists in the scratch copy.
const put = (path, text) => {
  const abs = join(scratch, path);
  mkdirSync(dirname(abs), { "recursive": true });
  writeFileSync(abs, text.endsWith("\n") ? text : `${text}\n`);
};

const add = (path, text) => {
  const abs = join(scratch, path);
  const old = readFileSync(abs, "utf8");
  writeFileSync(abs, `${old}${old.endsWith("\n") ? "" : "\n"}${text}\n`);
};

const lists = () => {
  const folder = join(scratch, LISTS);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => name.endsWith(".txt"))
    .map((name) => `${LISTS}/${name}`);
};

const requireLists = () => {
  const found = lists();
  assert.notDeepEqual(found, [], `no list under ${LISTS}/`);
  return found;
};

const entryOf = (line) => line.split(" #")[0].trim();

const editLines = (list, edit) => {
  const abs = join(scratch, list);
  const lines = readFileSync(abs, "utf8").split("\n");
  const kept = lines.flatMap(edit);
  writeFileSync(abs, kept.join("\n"));
};

const listFile = (path) => {
  for (const list of requireLists()) add(list, path);
};

const unlistFile = (path) => {
  for (const list of requireLists()) {
    editLines(list, (line) => (entryOf(line) === path ? [] : [line]));
  }
};

const markFile = (path, mark) => {
  for (const list of requireLists()) {
    editLines(list, (line) =>
      [entryOf(line) === path ? `${path}${mark}` : line]);
  }
};

// The seeds. Each meets every rule of today's eslint.config.js but the
// limit it is written to break.
const name = (key) => `zzCriteria${key}`;

const longFunction = (key, lines) => [
  `export const ${name(key)} = (value) => {`,
  "  let total = value;",
  ...Array.from({ "length": lines - 4 }, (_, i) => `  total += ${i + 1};`),
  "  return total;",
  "};",
].join("\n");

const pad = (depth) => "  ".repeat(depth);

const deepFunction = (key, depth) => {
  const opens = Array.from({ "length": depth }, (_, i) =>
    [`${pad(i + 1)}if (value > ${i}) {`, `${pad(i + 2)}total += ${i + 1};`]);
  const closes = Array.from({ "length": depth }, (_, i) =>
    `${pad(depth - i)}}`);
  return [
    `export const ${name(key)} = (value) => {`,
    "  let total = 0;",
    ...opens.flat(),
    ...closes,
    "  return total;",
    "};",
  ].join("\n");
};

const paramsFunction = (key, count) => {
  const args = Array.from({ "length": count }, (_, i) => `a${i + 1}`);
  return `export const ${name(key)} = (${args.join(", ")}) => ` +
    `a1 + a${count};`;
};

const longFile = (key, lines) => Array.from({ "length": lines }, (_, i) =>
  `export const ${name(key)}${i} = ${i};`).join("\n");

const small = (key) => `export const ${name(key)} = (value) => value + 1;`;

// Breaks three limits at once (a function of 30 lines, nesting 3 deep,
// 5 parameters), and with breaksAllFile the fourth too: 301 lines.
const breaksAll = (key) => [
  longFunction(`${key}Long`, 30),
  deepFunction(`${key}Deep`, 3),
  paramsFunction(`${key}Params`, 5),
].join("\n");
const breaksAllFile = (key) => {
  const head = breaksAll(key);
  const lines = head.split("\n").length;
  return `${head}\n${longFile(`${key}Pad`, 301 - lines)}`;
};

const compliant = (key) => [small(`${key}A`), small(`${key}B`)].join("\n");

// The change, as the hook or CI sees it. `before` writes and commits
// the state the change starts from; `change` writes the change.
const stage = (mode, { before, change, pr = PR }) => {
  reset();
  if (before) {
    before();
    git(scratch, ["add", "-A"]);
    git(scratch, ["commit", "-q", "--allow-empty", "-m", "before"]);
  }
  change?.();
  git(scratch, ["add", "-A"]);
  if (mode === "hook") return;
  if (mode === "push") {
    git(scratch, ["commit", "-q", "--allow-empty", "-m", "change"]);
    git(scratch, ["checkout", "-q", "-B", "next"]);
    git(scratch, ["update-ref", "refs/remotes/origin/next", "HEAD"]);
    return;
  }
  const parent = git(scratch, ["rev-parse", "HEAD"]).trim();
  git(scratch, ["checkout", "-q", "-b", "pr"]);
  git(scratch, ["commit", "-q", "--allow-empty", "-m", "change"]);
  git(scratch, ["checkout", "-q", "--detach", parent]);
  git(scratch, ["merge", "-q", "--no-ff", "pr", "-m",
    `Merge pr into ${parent}`]);
  git(scratch, ["update-ref", `refs/remotes/pull/${pr}/merge`, "HEAD"]);
  git(scratch, ["update-ref", "refs/heads/next", parent]);
};

// The gates on a change: the frame's two scripts, ESLint over the
// paths named, and Stylelint over the stylesheets named.
const script = (scriptName) => {
  assert.ok(scriptsOf(scratch)[scriptName],
    `package.json has a ${scriptName} script`);
  return run(scratch, "npm", ["run", "--silent", scriptName]);
};

const eslint = (paths) => {
  if (!paths.length) return { "findings": [], "log": "" };
  const result = run(scratch, join(scratch, "node_modules/.bin/eslint"),
    ["--format", "json", ...paths]);
  let reports;
  try {
    reports = JSON.parse(result.stdout);
  } catch {
    assert.fail(`ESLint gave no JSON\n${shown(result)}`);
  }
  const findings = reports.flatMap((report) => report.messages.map((m) => ({
    "file": relative(scratch, report.filePath),
    "rule": m.ruleId,
    "line": m.line,
    "text": m.message,
  })));
  return { findings, "log": JSON.stringify(findings, null, 1) };
};

const stylelint = (paths) => {
  if (!paths.length) return { "failed": false, "log": "" };
  const result = run(scratch, join(scratch, "node_modules/.bin/stylelint"),
    paths);
  return { "failed": result.status !== 0, "log": shown(result) };
};

const gates = ({ scripts = [], styles = [] } = {}) => {
  const touched = script(TOUCHED);
  const exceptions = script(EXCEPTIONS);
  const lint = eslint(scripts);
  const styled = stylelint(styles);
  return {
    touched, exceptions, "findings": lint.findings,
    "failed": touched.status !== 0 || exceptions.status !== 0 ||
      lint.findings.length > 0 || styled.failed,
    "log": [`${TOUCHED}: ${shown(touched)}`,
      `${EXCEPTIONS}: ${shown(exceptions)}`,
      `eslint: ${lint.log}`, `stylelint: ${styled.log}`].join("\n"),
  };
};

const passes = (result) => assert.ok(!result.failed,
  `the change passes every gate\n${result.log}`);

const rulesOn = (result, path) => new Set(result.findings
  .filter((f) => f.file === path).map((f) => f.rule));

const namesRules = (result, path, rules) => {
  const found = rulesOn(result, path);
  const missing = rules.filter((rule) => !found.has(rule));
  assert.deepEqual(missing, [],
    `ESLint names ${path} with each rule\n${result.log}`);
};

const namesNoRule = (result, path, rules) => {
  const found = rulesOn(result, path);
  const held = rules.filter((rule) => found.has(rule));
  assert.deepEqual(held, [], `rules that should not hold ${path}\n` +
    `${result.log}`);
};

const gateNames = () => lists().flatMap((list) =>
  [list, list.split("/").pop().replace(/\.txt$/, "")]);

const failsNaming = (result, path, words) => {
  const text = said(result);
  assert.notEqual(result.status, 0, `the check fails\n${shown(result)}`);
  assert.ok(text.includes(path), `it names ${path}\n${shown(result)}`);
  if (!words) return;
  assert.ok(words.some((word) => text.includes(word)),
    `it names one of ${words.join(", ")}\n${shown(result)}`);
};

const MODES = ["hook", "ci"];
const LEGACY = "assets/scripts/zz-criteria-legacy.js";
const OTHER = "assets/scripts/zz-criteria-other.js";
const FRESH = "assets/scripts/zz-criteria-new.js";

const legacyBefore = () => {
  put(LEGACY, breaksAll("Legacy"));
  put(OTHER, compliant("Other"));
  listFile(LEGACY);
};

before(() => {
  scratch = makeScratch();
});

after(() => {
  if (scratch) rmSync(scratch, { "recursive": true, "force": true });
});

describe("#782 step 3: where the frame runs", () => {
  it("every new gate goes inside npm run lint, so the hook and CI run " +
    "one list", () => {
    const all = scriptsOf(root);
    const fromLint = reached(all, "lint");
    const fromHook = reached(all, "check");
    const missing = [TOUCHED, EXCEPTIONS].flatMap((gate) => [
      ...fromLint.has(gate) ? [] : [`${gate} from npm run lint`],
      ...fromHook.has(gate) ? [] : [`${gate} from npm run check`],
    ]);
    assert.deepEqual(missing, [], "frame scripts the hook or CI never run");
  });

  it("a test fails when a gate's script exists that npm run lint does " +
    "not call (provisional reading)", () => {
    assert.deepEqual(orphanGates(scriptsOf(root)), [],
      "gate scripts npm run lint does not reach");
    const seeded = { ...scriptsOf(root),
      "lint:zz-criteria": "eslint assets/scripts" };
    assert.deepEqual(orphanGates(seeded), ["lint:zz-criteria"],
      "the parity test catches a gate's script lint does not call");
  });
});

describe("#782 step 3: one list per gate", () => {
  for (const mode of MODES) {
    it(`a file on a legacy list is not held until it is touched (${mode})`,
      () => {
        stage(mode, {
          "before": legacyBefore,
          "change": () => add(OTHER, small("OtherC")),
        });
        const result = gates({ "scripts": [LEGACY, OTHER] });
        passes(result);
      });
  }

  it("the gate's config excludes exactly the listed files, from that " +
    "gate only", () => {
    stage("hook", {
      "before": () => {
        legacyBefore();
        add(LEGACY, "var zzCriteriaVar = 1;\nexport { zzCriteriaVar };");
      },
    });
    const result = gates({ "scripts": [LEGACY] });
    namesNoRule(result, LEGACY, Object.keys(LIMITS));
    namesRules(result, LEGACY, ["no-var"]);
  });

  it("everything else is checked on every run, untouched files too",
    () => {
      stage("hook", {
        "before": () => put(LEGACY, breaksAllFile("Slipped")),
        "change": () => put(OTHER, compliant("Other")),
      });
      const result = gates({ "scripts": [LEGACY, OTHER] });
      namesRules(result, LEGACY, Object.keys(LIMITS));
    });
});

describe("#782 step 3: touching a file takes it off the lists", () => {
  for (const mode of MODES) {
    it(`check:touched fails when a touched file is on a list, naming the ` +
      `file and the gate (${mode})`, () => {
      stage(mode, {
        "before": legacyBefore,
        "change": () => add(LEGACY, small("LegacyAdded")),
      });
      failsNaming(script(TOUCHED), LEGACY, gateNames());
    });

    it(`the fix is to bring the whole file up and delete its line ` +
      `(${mode})`, () => {
      stage(mode, {
        "before": legacyBefore,
        "change": () => {
          put(LEGACY, compliant("Legacy"));
          unlistFile(LEGACY);
        },
      });
      passes(gates({ "scripts": [LEGACY] }));
    });
  }

  it("a touched file brought up but left on its list still fails", () => {
    stage("hook", {
      "before": legacyBefore,
      "change": () => put(LEGACY, compliant("Legacy")),
    });
    failsNaming(script(TOUCHED), LEGACY, gateNames());
  });

  it("a touched file is held to every limit as a whole file, not only " +
    "the lines touched, and the check names the file and the rule", () => {
    stage("hook", {
      "before": () => {
        put(LEGACY, breaksAllFile("Legacy"));
        listFile(LEGACY);
      },
      "change": () => {
        add(LEGACY, small("LegacyAdded"));
        unlistFile(LEGACY);
      },
    });
    const result = gates({ "scripts": [LEGACY] });
    assert.ok(result.failed, `the change fails\n${result.log}`);
    namesRules(result, LEGACY, Object.keys(LIMITS));
  });
});

describe("#782 step 3: new code is always held", () => {
  it("a new file that breaks a limit fails, named with each rule", () => {
    stage("hook", { "change": () => put(FRESH, breaksAllFile("New")) });
    const result = gates({ "scripts": [FRESH] });
    assert.ok(result.failed, `the change fails\n${result.log}`);
    namesRules(result, FRESH, Object.keys(LIMITS));
  });

  it("a new file cannot be put on a list", () => {
    stage("hook", {
      "change": () => {
        put(FRESH, breaksAll("New"));
        listFile(FRESH);
      },
    });
    const result = gates({ "scripts": [FRESH] });
    assert.ok(result.failed, `the change fails\n${result.log}`);
  });

  it("each limit holds at James's figure and not below it", () => {
    const files = {
      "assets/scripts/zz-criteria-fn-25.js": longFunction("Fn", 25),
      "assets/scripts/zz-criteria-fn-26.js": longFunction("Fn", 26),
      "assets/scripts/zz-criteria-file-300.js": longFile("File", 300),
      "assets/scripts/zz-criteria-file-301.js": longFile("File", 301),
      "assets/scripts/zz-criteria-depth-2.js": deepFunction("Depth", 2),
      "assets/scripts/zz-criteria-depth-3.js": deepFunction("Depth", 3),
      "assets/scripts/zz-criteria-params-4.js": paramsFunction("Params", 4),
      "assets/scripts/zz-criteria-params-5.js": paramsFunction("Params", 5),
    };
    stage("hook", {
      "change": () => Object.entries(files).forEach(([p, t]) => put(p, t)),
    });
    const result = gates({ "scripts": Object.keys(files) });
    const at = (path) => [...rulesOn(result, path)].sort();
    const got = Object.fromEntries(Object.keys(files).map((p) =>
      [p.split("zz-criteria-")[1], at(p)]));
    assert.deepEqual(got, {
      "fn-25.js": [], "fn-26.js": ["max-lines-per-function"],
      "file-300.js": [], "file-301.js": ["max-lines"],
      "depth-2.js": [], "depth-3.js": ["max-depth"],
      "params-4.js": [], "params-5.js": ["max-params"],
    }, `findings per seed\n${result.log}`);
  });
});

describe("#782 step 3: tests, and the server", () => {
  const TESTS = ["test/zz-criteria-helpers.mjs", "e2e/zz-criteria-helpers.mjs"];

  it("function and file length are off under test/ and e2e/", () => {
    stage("hook", {
      "change": () => TESTS.forEach((p) => put(p, [
        longFunction("TestLong", 40),
        longFile("TestPad", 320),
      ].join("\n"))),
    });
    const result = gates({ "scripts": TESTS });
    for (const path of TESTS) namesNoRule(result, path, LENGTHS);
    passes(result);
  });

  it("nesting and parameters still hold under test/ and e2e/", () => {
    stage("hook", {
      "change": () => TESTS.forEach((p) => put(p, [
        deepFunction("TestDeep", 3),
        paramsFunction("TestParams", 5),
      ].join("\n"))),
    });
    const result = gates({ "scripts": TESTS });
    for (const path of TESTS) namesRules(result, path, SHAPES);
  });

  const SERVER = ["netlify/functions/lib/zz-criteria-server.mjs",
    "bin/zz-criteria-server.mjs"];

  it("a new file under netlify/ or bin/ is held like any other", () => {
    stage("hook", {
      "change": () => SERVER.forEach((p) => put(p, breaksAllFile("Server"))),
    });
    const result = gates({ "scripts": SERVER });
    for (const path of SERVER) namesRules(result, path, Object.keys(LIMITS));
  });

  for (const path of SERVER) {
    it(`a listed file under ${path.split("/")[0]}/ has no standing ` +
      "exemption: touching it fails like any other", () => {
      stage("hook", {
        "before": () => {
          put(path, breaksAll("Server"));
          listFile(path);
        },
        "change": () => add(path, small("ServerAdded")),
      });
      failsNaming(script(TOUCHED), path, gateNames());
    });
  }
});

describe("#782 step 3: a list may only shrink", () => {
  for (const mode of MODES) {
    it(`a change that adds a line to a list fails (${mode})`, () => {
      stage(mode, {
        "before": legacyBefore,
        "change": () => listFile(OTHER),
      });
      const result = gates({ "scripts": [OTHER] });
      assert.ok(result.failed, `the change fails\n${result.log}`);
      const text = said(result.touched) + said(result.exceptions);
      assert.ok(lists().some((list) => text.includes(list)) ||
        text.includes(OTHER), `the failure names the list or the file\n` +
        `${result.log}`);
    });
  }
});

describe("#782 step 3: the stall valve", () => {
  const marked = (pr, entry) => () => {
    legacyBefore();
    markFile(LEGACY, stallMarker(pr, entry));
  };

  it("a stall marker for the pull request holds only the lines it adds " +
    "or changes: old findings pass", () => {
    stage("ci", {
      "before": legacyBefore,
      "change": () => {
        markFile(LEGACY, stallMarker(PR, ENTRY));
        add(LEGACY, small("LegacyAdded"));
      },
    });
    passes(gates({ "scripts": [LEGACY] }));
  });

  it("a stall marker for the pull request holds only the lines it adds " +
    "or changes: new findings fail, naming the file and the rule", () => {
    stage("ci", {
      "before": legacyBefore,
      "change": () => {
        markFile(LEGACY, stallMarker(PR, ENTRY));
        add(LEGACY, longFunction("LegacyAddedLong", 30));
      },
    });
    failsNaming(script(TOUCHED), LEGACY, ["max-lines-per-function"]);
  });

  it("the marker counts for that pull request alone", () => {
    stage("ci", {
      "before": marked(PR, ENTRY),
      "change": () => add(LEGACY, small("LegacyAdded")),
      "pr": PR + 1,
    });
    failsNaming(script(TOUCHED), LEGACY, gateNames());
  });

  it("check:exceptions fails on a stall marker with no entry on #791",
    () => {
      stage("ci", {
        "before": legacyBefore,
        "change": () => {
          markFile(LEGACY, stallMarker(PR, ""));
          add(LEGACY, small("LegacyAdded"));
        },
      });
      const result = script(EXCEPTIONS);
      assert.notEqual(result.status, 0, `the check fails\n${shown(result)}`);
      const text = said(result);
      assert.ok(text.includes(LEGACY) ||
        lists().some((list) => text.includes(list)),
      `it names the file or its list\n${shown(result)}`);
    });
});

describe("#782 step 3: exceptions", () => {
  it("check:exceptions passes on the repository as it stands", () => {
    stage("hook", {});
    const result = script(EXCEPTIONS);
    assert.equal(result.status, 0, shown(result));
  });

  it("an exception in the one form, citing its entry, passes", () => {
    stage("hook", {
      "change": () => put(FRESH, [
        `// eslint-disable-next-line max-params -- ${cite}`,
        paramsFunction("Cited", 5),
      ].join("\n")),
    });
    passes(gates({ "scripts": [FRESH] }));
  });

  const refused = {
    "a directive that names no rule": {
      "assets/scripts/zz-criteria-bare.js":
        `// eslint-disable-next-line -- ${cite}\n${paramsFunction("B", 5)}`,
      "assets/styles/components/_zz-criteria-bare.scss":
        `.zz-criteria {\n  /* stylelint-disable-next-line -- ${cite} */\n` +
        "  color: #000 !important;\n}",
    },
    "a directive with no #791 c<id>": {
      "assets/scripts/zz-criteria-uncited.js":
        `// eslint-disable-next-line max-params -- reason\n${
          paramsFunction("U", 5)}`,
      "assets/styles/components/_zz-criteria-uncited.scss":
        ".zz-criteria {\n  /* stylelint-disable-next-line " +
        "declaration-no-important -- reason */\n  color: #000 !important;\n}",
      "assets/scripts/zz-criteria-uncited-ts.js":
        "// @ts-expect-error TS2345 -- reason\nexport const zzCriteriaTs = 1;",
      "bin/zz-criteria-uncited.sh":
        "#!/bin/sh\n# shellcheck disable=SC2034 # reason\nzz_unused=1",
    },
    "any @ts-ignore or @ts-nocheck, even cited": {
      "assets/scripts/zz-criteria-ignore.js":
        `// @ts-ignore -- ${cite}\nexport const zzCriteriaIgnore = 1;`,
      "assets/scripts/zz-criteria-nocheck.js":
        `// @ts-nocheck -- ${cite}\nexport const zzCriteriaNocheck = 1;`,
    },
  };

  for (const [what, seeds] of Object.entries(refused)) {
    it(`check:exceptions fails on ${what}`, () => {
      const passed = [];
      for (const [path, text] of Object.entries(seeds)) {
        stage("hook", { "change": () => put(path, text) });
        const result = script(EXCEPTIONS);
        if (result.status === 0 || !said(result).includes(path)) {
          passed.push(`${path}\n${shown(result)}`);
        }
      }
      assert.deepEqual(passed, [], "seeds check:exceptions let through");
    });
  }

  const CONFIG = "eslint.config.js";
  const exclude = (comment) => add(CONFIG, [
    ...comment ? [comment] : [],
    `module.exports.push({ "ignores": ["${FRESH}"] });`,
  ].join("\n"));

  it("check:exceptions fails on an exclusion in a config with no " +
    "citation beside it", () => {
    stage("hook", { "change": () => exclude("") });
    failsNaming(script(EXCEPTIONS), CONFIG);
  });

  it("an exclusion in a config with its citation beside it passes", () => {
    stage("hook", { "change": () => exclude(`// ${cite}`) });
    const result = script(EXCEPTIONS);
    assert.equal(result.status, 0, shown(result));
  });

  it("a directive that no longer suppresses anything fails", () => {
    const js = "assets/scripts/zz-criteria-needless.js";
    const style = "assets/styles/components/_zz-criteria-needless.scss";
    const failed = [];
    for (const [path, text] of [
      [js, `// eslint-disable-next-line max-params -- ${cite}\n${
        paramsFunction("Needless", 2)}`],
      [style, ".zz-criteria {\n  /* stylelint-disable-next-line " +
        `color-no-invalid-hex -- ${cite} */\n  color: #000;\n}`],
    ]) {
      stage("hook", { "change": () => put(path, text) });
      const result = gates(path === js ?{ "scripts": [path] } :
        { "styles": [path] });
      if (!result.failed) failed.push(`${path}\n${result.log}`);
    }
    assert.deepEqual(failed, [], "needless directives that pass");
  });
});

// The coordinator's two cases of 2026-11-23 (provisional, see the header).
// Each sub-case is staged in turn and every miss is reported at once.
const verdicts = (cases) => {
  const wrong = [];
  for (const [what, { mode, change, ok }] of Object.entries(cases)) {
    stage(mode, { "before": legacyBefore, change });
    const result = gates({ "scripts": [LEGACY, OTHER] });
    if (ok === result.failed) {
      wrong.push(`${what}: wanted ${ok ? "a pass" : "a failure"}\n` +
        `${result.log}`);
    }
  }
  return wrong;
};

const stalled = (mark) => () => {
  markFile(LEGACY, mark);
  add(LEGACY, small("LegacyAdded"));
};

describe("#782 step 3: runs with no pull request number", () => {
  it("a run with no pull request ref compares HEAD with its first " +
    "parent, holds a stall marker's file to its changed lines only when " +
    "the marker cites its #791 entry, and is not skipped", () => {
    assert.deepEqual(verdicts({
      "an untouched listed file, touched only before the first parent": {
        "mode": "push", "change": () => add(OTHER, small("OtherC")),
        "ok": true,
      },
      "a marker citing its entry, compliant lines added": {
        "mode": "push", "change": stalled(stallMarker(PR, ENTRY)),
        "ok": true,
      },
      "a marker citing its entry, a long function added": {
        "mode": "push",
        "change": () => {
          markFile(LEGACY, stallMarker(PR, ENTRY));
          add(LEGACY, longFunction("LegacyAddedLong", 30));
        },
        "ok": false,
      },
      "a marker citing no entry": {
        "mode": "push", "change": stalled(stallMarker(PR, "")),
        "ok": false,
      },
      "a touched listed file with no marker": {
        "mode": "push", "change": () => add(LEGACY, small("LegacyAdded")),
        "ok": false,
      },
    }), [], "push runs judged wrongly");
  });

  it("the hook accepts a staged change that adds a stall marker though " +
    "no pull request number exists yet, and CI requires its entry on " +
    "#791", () => {
    assert.deepEqual(verdicts({
      "the hook, a marker with no number yet": {
        "mode": "hook", "change": stalled(pendingMarker), "ok": true,
      },
      "the hook, a marker with a number and no entry": {
        "mode": "hook", "change": stalled(stallMarker(PR, "")), "ok": true,
      },
      "CI, a marker with no number": {
        "mode": "ci", "change": stalled(pendingMarker), "ok": false,
      },
      "CI, a marker with the number and no entry": {
        "mode": "ci", "change": stalled(stallMarker(PR, "")), "ok": false,
      },
      "CI, a marker with the number and its entry": {
        "mode": "ci", "change": stalled(stallMarker(PR, ENTRY)), "ok": true,
      },
    }), [], "hook and CI runs judged wrongly");
  });
});
