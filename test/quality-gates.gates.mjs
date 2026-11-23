// Criteria tests for #782 (quality gates in the build for new and
// changed code), steps 1, 2 and 4 of the proposal
// (issuecomment-7075114694), written before the implementation:
//
//   1. Lint every script and stylesheet; today's warnings fixed;
//      unused directives an error (closes #769, Stylelint skips the
//      top-level stylesheets).
//   2. The 17 zero-finding core rules and the nine small ones, fixed:
//      "errors everywhere at once".
//   4. ShellCheck in `npm run lint`, its 6 fixed: "whole repository,
//      after the fixes".
//
// Each test checks the gate, not the fix: what the lint run reads,
// what it treats as an error, and that a seeded violation fails it.
// Seeds are written beside the code for one run and removed after.
// Held out of runs as quality-gates.criteria.mjs until the implementer
// renames it to quality-gates.test.mjs.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import stylelint from "stylelint";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), "quality-gates-"));
const tag = `zz-criteria-${process.pid}`;

// The 17 core rules with no finding on next (the proposal's
// "Correctness" row; the list is its trial config's core set less the
// rules that found something).
const ZERO_FINDING_RULES = [
  "array-callback-return",
  "default-case-last",
  "guard-for-in",
  "no-eval",
  "no-implied-eval",
  "no-inner-declarations",
  "no-new-func",
  "no-new-wrappers",
  "no-return-assign",
  "no-self-compare",
  "no-sequences",
  "no-throw-literal",
  "no-unmodified-loop-condition",
  "no-unreachable-loop",
  "no-unused-expressions",
  "no-useless-assignment",
  "prefer-promise-reject-errors",
];

// The nine small rules and their 66 findings: eqeqeq 6,
// consistent-return 10, no-promise-executor-return 30, no-loop-func 8,
// no-extend-native 4, no-param-reassign 4, no-alert 2, radix 1,
// no-duplicate-imports 1.
const SMALL_RULES = [
  "eqeqeq",
  "consistent-return",
  "no-promise-executor-return",
  "no-loop-func",
  "no-extend-native",
  "no-param-reassign",
  "no-alert",
  "radix",
  "no-duplicate-imports",
];

// One violation of each rule, as text ESLint reads; nothing here is
// ever run or imported. no-inner-declarations has none: with
// its defaults it reports nothing in strict code, and every script
// here is strict, so only the config check holds it.
const ZERO_FINDING_SEED = `import { a as one } from "node:fs";
export const mapped = [1].map(() => {
  one;
});
export function lastCase(x) {
  switch (x) {
    default:
      break;
    case 1:
      break;
  }
}
export function forIn(o, out) {
  for (const k in o) {
    out.push(k);
  }
}
export const evaled = eval("1");
setTimeout("lastCase(1)", 1);
export const made = new Function("a", "return a");
export const wrapped = new String("a");
export function assigns(a) {
  return a.b = 1;
}
export const same = (a) => a === a;
export function sequence(a, b) {
  a.x++, b.x++;
}
export function throws() {
  throw "x";
}
export function spins(a, out) {
  while (a) {
    out.push(1);
  }
}
export function once(a) {
  for (const x of a) {
    return x;
  }
  return null;
}
export function bare(a) {
  a.b;
}
export function useless() {
  let a = 1;
  a = 2;
  return a;
}
export const rejected = Promise.reject("x");
`;

const SMALL_SEED = `import { a } from "node:fs";
import { b } from "node:fs";
export const loose = (x) => x == a;
export function sometimes(x) {
  if (x) {
    return 1;
  }
  return;
}
export const executor = new Promise((r) => r);
export function closures() {
  const fns = [];
  let total = 0;
  for (let i = 0; i !== 3; i++) {
    total += i;
    fns.push(() => total);
  }
  return fns;
}
Object.prototype.seeded = b;
export function reassigns(x) {
  x = 1;
  return x;
}
alert("x");
export const parsed = parseInt("1");
`;

// Directives that suppress nothing.
const UNUSED_ESLINT_DIRECTIVE_SEED = `// eslint-disable-next-line no-debugger
export const quiet = 1;
`;
const NEEDLESS_STYLELINT_DIRECTIVE_SEED =
  `// stylelint-disable-next-line color-no-invalid-hex
.zz-criteria-seed {
  color: #fff;
}
`;

// Today's only warning-level rule is indent; this seed breaks it and
// nothing else.
const WARNING_SEED = `export function indented() {
    return 1;
}
`;

// An info-level ShellCheck finding (SC2086, an unquoted expansion).
// The proposal's six include three notes, so a note must fail the run.
const SHELL_SEED = `#!/bin/bash
echo $1
`;

// The rules this config already turns off on next. #769: "no rule is
// turned off to get there".
const STYLELINT_OFF_ON_NEXT = [
  "no-empty-source",
  "scss/at-extend-no-missing-placeholder",
];

const tracked = () => execFileSync("git", ["ls-files", "-z"], {
  "cwd": root, "encoding": "utf8",
}).split("\0").filter((f) => f && existsSync(join(root, f)));

const firstLine = (file) => {
  const abs = join(root, file);
  if (!statSync(abs).isFile()) return "";
  return readFileSync(abs, "utf8").split("\n", 1)[0];
};

const trackedScripts = () => tracked().filter((f) =>
  /\.(js|mjs|cjs)$/.test(f) ||
  (!extname(f) && /^#!.*\bnode\b/.test(firstLine(f))));

const trackedStylesheets = () => tracked().filter((f) =>
  /\.(scss|css)$/.test(f));

const trackedShellScripts = () => tracked().filter((f) =>
  /\.(sh|bash)$/.test(f) ||
  (!extname(f) && /^#!.*\b(sh|bash|dash)\b/.test(firstLine(f))));

const seeds = [];
const seed = (path, text) => {
  const abs = join(root, path);
  writeFileSync(abs, text);
  seeds.push(abs);
  return abs;
};
const unseed = () => {
  for (const abs of seeds.splice(0)) rmSync(abs, { "force": true });
};
process.on("exit", unseed);

// Run an npm script the way the hook and CI do. The script shell is
// plain sh so a nested run is not recorded as one of the Mac's own.
const npm = (args, env = {}) => spawnSync("npm", args, {
  "cwd": root,
  "encoding": "utf8",
  "env": { ...process.env, "npm_config_script_shell": "/bin/sh", ...env },
  "maxBuffer": 64 * 1024 * 1024,
});

const ran = (result) =>
  `exit ${result.status}\n${result.stdout}\n${result.stderr}`.slice(-4000);

const severity = (value) => {
  const level = Array.isArray(value) ? value[0] : value;
  return { "off": 0, "warn": 1, "error": 2 }[level] ?? level ?? 0;
};

const relativeToRoot = (path) => relative(root, path);

// Every rule in names is at error level in ESLint's resolved config
// for every tracked script. Returns one line per rule that is not:
// "rule: N scripts, e.g. file (level)".
const notErrors = async (names) => {
  const eslint = new ESLint({ "cwd": root });
  const misses = new Map();
  for (const file of trackedScripts()) {
    const config = await eslint.calculateConfigForFile(join(root, file));
    for (const name of names) {
      const level = config ? severity(config.rules?.[name]) : "no config";
      if (level === 2) continue;
      const miss = misses.get(name) ?? { "count": 0, "first": "" };
      miss.count += 1;
      miss.first ||= `${file} (${level})`;
      misses.set(name, miss);
    }
  }
  return [...misses].map(([name, { count, first }]) =>
    `${name}: ${count} scripts, e.g. ${first}`);
};

const messagesFor = (results, abs) =>
  results.find((r) => r.filePath === abs)?.messages ?? [];

const missingSeverity2 = (messages, names) => names.filter((name) =>
  !messages.some((m) => m.ruleId === name && m.severity === 2));

describe("#782 step 1: lint every script and stylesheet", () => {
  let scripts;
  let styles;
  let unusedDirective;
  let needlessDirective;
  let zeroSeed;
  let smallSeed;

  before(() => {
    unusedDirective = seed(`test/${tag}-unused.mjs`,
      UNUSED_ESLINT_DIRECTIVE_SEED);
    zeroSeed = seed(`test/${tag}-zero.mjs`, ZERO_FINDING_SEED);
    smallSeed = seed(`test/${tag}-small.mjs`, SMALL_SEED);
    needlessDirective = seed(`assets/styles/components/_${tag}.scss`,
      NEEDLESS_STYLELINT_DIRECTIVE_SEED);
    try {
      const eslintOut = join(scratch, "eslint.json");
      const eslintRun = npm(["run", "--silent", "lint:scripts", "--",
        "--format", "json", "--output-file", eslintOut]);
      assert.ok(existsSync(eslintOut), ran(eslintRun));
      scripts = JSON.parse(readFileSync(eslintOut, "utf8"));

      const styleOut = join(scratch, "stylelint.json");
      const styleRun = npm(["run", "--silent", "lint:styles", "--",
        "--formatter", "json", "--output-file", styleOut]);
      assert.ok(existsSync(styleOut), ran(styleRun));
      styles = JSON.parse(readFileSync(styleOut, "utf8"));
    } finally {
      unseed();
    }
  });

  it("npm run lint lints every tracked script", () => {
    const linted = new Set(scripts.map((r) => relativeToRoot(r.filePath)));
    const skipped = trackedScripts().filter((f) => !linted.has(f));
    assert.deepEqual(skipped, [], "tracked scripts ESLint never reads");
  });

  it("npm run lint lints every tracked stylesheet (#769)", () => {
    const linted = new Set(styles.map((r) => relativeToRoot(r.source)));
    const skipped = trackedStylesheets().filter((f) => !linted.has(f));
    assert.deepEqual(skipped, [], "tracked stylesheets Stylelint never reads");
  });

  it("an unused eslint-disable directive is a lint error", () => {
    const unused = messagesFor(scripts, unusedDirective)
      .filter((m) => /unused eslint-disable/i.test(m.message));
    assert.equal(unused.length, 1, "the seeded directive is reported");
    assert.equal(unused[0].severity, 2, "and reported as an error");
  });

  it("a needless stylelint-disable directive is a lint error", () => {
    const result = styles.find((r) => r.source === needlessDirective);
    assert.ok(result, "Stylelint reads the seeded stylesheet");
    const needless = result.warnings
      .filter((w) => /needless/i.test(w.rule));
    assert.equal(needless.length, 1, "the seeded directive is reported");
    assert.equal(needless[0].severity, "error", "and reported as an error");
  });

  it("no Stylelint rule is turned off to pass (#769)", async () => {
    const on = (v) => v !== null && v !== undefined &&
      !(Array.isArray(v) && v[0] === null);
    const turnedOff = [];
    for (const file of trackedStylesheets()) {
      const abs = join(root, file);
      const preset = await stylelint.resolveConfig(abs, {
        "config": { "extends": "stylelint-config-standard-scss" },
        "configBasedir": root,
      });
      const repo = await stylelint.resolveConfig(abs, { "cwd": root });
      for (const [name, value] of Object.entries(preset.rules)) {
        if (!on(value) || STYLELINT_OFF_ON_NEXT.includes(name)) continue;
        if (!on(repo.rules?.[name])) turnedOff.push(`${file}: ${name}`);
      }
    }
    assert.deepEqual(turnedOff, [], "preset rules the config turns off");
  });

  it("the _global.scss comment on .zip-note-warning says what uses it " +
    "(#769)", () => {
    const text = readFileSync(join(root, "assets/styles/_global.scss"),
      "utf8");
    const lines = text.split("\n");
    const at = lines.findIndex((l) => /^\.zip-note-warning\s*\{/.test(l));
    assert.ok(at > 0, ".zip-note-warning is still defined");
    const comment = [];
    for (let i = at - 1; i >= 0 && /^\s*\/\//.test(lines[i]); i--) {
      comment.unshift(lines[i]);
    }
    const said = comment.join(" ");
    assert.doesNotMatch(said, /countdown/i,
      "the countdown has its own data-urgency rule");
    assert.match(said, /sign-in/i, "the sign-in page uses it");
    assert.match(said, /invite/i, "the invite page uses it");
  });

  // Step 2 reads the same run, so its tests live in this block.
  describe("#782 step 2: the zero-finding and small core rules", () => {
    it("the 17 zero-finding core rules are errors everywhere",
      async () => {
        assert.deepEqual(await notErrors(ZERO_FINDING_RULES), [],
          "scripts where a zero-finding rule is not an error");
        const seeded = ZERO_FINDING_RULES
          .filter((r) => r !== "no-inner-declarations");
        assert.deepEqual(
          missingSeverity2(messagesFor(scripts, zeroSeed), seeded), [],
          "seeded violations the lint run does not fail on");
      });

    it("the nine small core rules are errors everywhere", async () => {
      assert.deepEqual(await notErrors(SMALL_RULES), [],
        "scripts where a small rule is not an error");
      assert.deepEqual(
        missingSeverity2(messagesFor(scripts, smallSeed), SMALL_RULES), [],
        "seeded violations the lint run does not fail on");
    });
  });
});

describe("#782 step 1: today's warnings fail the run", () => {
  it("a lint warning fails npm run lint", () => {
    seed(`test/${tag}-warning.mjs`, WARNING_SEED);
    let run;
    try {
      run = npm(["run", "--silent", "lint:scripts"]);
    } finally {
      unseed();
    }
    assert.match(`${run.stdout}${run.stderr}`, new RegExp(`${tag}-warning`),
      `the run reports the seeded file\n${ran(run)}`);
    assert.notEqual(run.status, 0, `the run fails\n${ran(run)}`);
  });
});

describe("#782 step 4: ShellCheck in npm run lint", () => {
  const log = join(scratch, "shellcheck.log");
  const seedPath = join(scratch, "seed.sh");
  let run;
  let calls;

  // A stand-in shellcheck first on PATH records each call, adds the
  // seed to it, and runs the real ShellCheck.
  before(() => {
    const real = spawnSync("sh", ["-c", "command -v shellcheck"], {
      "encoding": "utf8",
    }).stdout.trim();
    assert.ok(real, "ShellCheck is installed");
    writeFileSync(seedPath, SHELL_SEED);
    const bin = join(scratch, "bin");
    execFileSync("mkdir", ["-p", bin]);
    const shim = join(bin, "shellcheck");
    writeFileSync(shim, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const asks = args.some((a) => ["-V", "--version", "-h", "--help"]
  .includes(a));
const full = asks ? args : [...args, ${JSON.stringify(seedPath)}];
const r = spawnSync(${JSON.stringify(real)}, full, { stdio: "inherit" });
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  cwd: process.cwd(), args, status: r.status,
}) + "\\n");
process.exit(r.status ?? 1);
`);
    chmodSync(shim, 0o755);
    run = npm(["run", "--silent", "lint"],
      { "PATH": `${bin}:${process.env.PATH}` });
    calls = existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l))
      : [];
  });

  it("npm run lint checks every tracked shell script with ShellCheck",
    () => {
      const checked = new Set();
      for (const call of calls) {
        for (const arg of call.args) {
          const abs = isAbsolute(arg) ? arg : resolve(call.cwd, arg);
          if (existsSync(abs)) checked.add(relativeToRoot(abs));
        }
      }
      const skipped = trackedShellScripts().filter((f) => !checked.has(f));
      assert.deepEqual(skipped, [],
        `tracked shell scripts ShellCheck never reads\n${ran(run)}`);
    });

  it("a ShellCheck finding fails npm run lint", () => {
    assert.ok(calls.some((c) => c.status !== 0),
      `ShellCheck reports the seeded note\n${ran(run)}`);
    assert.notEqual(run.status, 0, `the run fails\n${ran(run)}`);
  });
});

after(() => {
  unseed();
  rmSync(scratch, { "recursive": true, "force": true });
});
