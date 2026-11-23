// The criteria tests for the `pages` input of e2e.yml (#615), one per
// acceptance criterion and named for it, written from the criteria
// before the input existed. The implementer may change how a test
// runs (the helpers, the parsing, the way a step is run), never what
// it expects (~/.claude/CLAUDE.md, "Tests and implementation come from
// different agents").
//
// Held out of `npm test` until the input exists: `npm test` runs
// test/**/*.test.mjs and this file is *.criteria.mjs. Run it on
// purpose with
//   node --import ./test/setup.mjs --test test/e2e-pages-input.criteria.mjs
// and turn it on by renaming it to test/e2e-pages-input.test.mjs.
//
// Criterion 7 (bin/nff e2e sends the pages) is in
// test/e2e-dispatch-pages.criteria.mjs.
//
// Criteria 5 and 6 are shown only by real runs. These are the recorded
// checks, for the coordinator to run on the implementer's pushed
// branch (BRANCH) and to link on the pull request. Read each run's
// tests from its shard job's log (the list reporter prints one line
// per test, with its project).
//
// - 6 (recorded). Without pages, a run behaves exactly as today.
//     A: gh workflow run e2e.yml --ref BRANCH
//          -f specs="e2e/keyboard.spec.mjs"
//     A0: the same dispatch on the commit BRANCH is based on (after
//          #609; a passing keyboard-only run of that commit will do).
//   Passes when both pass, list the same tests (title and project) in
//   the same number, and show the same jobs: plan, narrow's one shard,
//   e2e-named and e2e-burn-in-named, with full and burn-in skipped.
// - 5 (recorded). With specs="e2e/keyboard.spec.mjs" and
//   pages="/about/", the walk runs for /about/ only, at both widths,
//   on the projects it runs on today.
//     B: gh workflow run e2e.yml --ref BRANCH
//          -f specs="e2e/keyboard.spec.mjs" -f pages="/about/"
//   Passes when B passes and its per-page walk tests are exactly
//   "keyboard at 1280px (#197) › /about/ tabs cleanly" and
//   "keyboard at 390px (#197) › /about/ tabs cleanly", each on every
//   project that ran per-page walk tests in A, and no other
//   "<path> tabs cleanly" test ran. (The cart walk, the account walk
//   and the Escape tests still run; see the question on #615.) This
//   is also the run #615's last "Done when" box asks for.
//
// The contract these tests fix, and nothing beyond it:
//
// - e2e.yml declares `pages` under on.workflow_dispatch.inputs, a
//   string that is not required.
// - The plan job checks it. These tests run the plan job's own `run:`
//   steps, in order, under bash as Actions does (`bash --noprofile
//   --norc -eo pipefail`), from the repository's root, with each
//   step's `env:` as written. The checks may be inline in the step or
//   in a script the step calls; either is tested the same way. A step's
//   `env:` may use `${{ inputs.<name> }}`, `${{ github.event.inputs.
//   <name> }}`, `${{ github.ref }}` and `${{ steps.<id>.outputs.<name>
//   }}`; anything else stops the test and names the expression (add it
//   to `context` below if it is safe). A plan step that is a `uses:`
//   other than actions/checkout stops the test the same way. A refused
//   dispatch is a plan step that exits non-zero with an `::error`
//   annotation.
// - The job that runs named specs is the job calling e2e-run.yml whose
//   `with.args` comes from the plan's specs. It passes `pages` to
//   e2e-run.yml in `with:`.
// - e2e-run.yml declares `pages` under on.workflow_call.inputs, and the
//   step that runs Playwright gets `E2E_PAGES: ${{ inputs.pages }}` in
//   its `env:` (or its job's). No `run:` body in either file holds an
//   expression naming pages.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseYaml } from "./workflow-yaml.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOWS = join(ROOT, ".github/workflows");
const workflow = (name) => parseYaml(
  readFileSync(join(WORKFLOWS, name), "utf8"));

const LANE = "refs/heads/lane/pages-input";
const KEYBOARD = "e2e/keyboard.spec.mjs";

const words = (text) => String(text ?? "").split(/\s+/).filter(Boolean);
const squash = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const callsRun = (job) => /(^|\/)e2e-run\.yml$/.test(job.uses || "");
const jobsOf = (wf) => Object.entries(wf.jobs);

// --- GitHub expressions, only the plain paths the tests allow --------

const evaluate = (text, context) => String(text ?? "").replace(
  /\$\{\{\s*(.*?)\s*\}\}/g,
  (whole, expr) => {
    if (!/^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/.test(expr)) {
      throw new Error(`the test can't evaluate ${whole}`);
    }
    const [head, ...rest] = expr.split(".");

    if (!(head in context)) throw new Error(`the test can't evaluate ${whole}`);

    const value = rest.reduce((at, key) => at?.[key], context[head]);

    return String(value ?? "");
  },
);

// --- The plan job, run for real ---------------------------------------

// Each output file is GitHub's format: name=value, or name<<DELIM ...
// DELIM for many lines.
const readOutputs = (file) => {
  const out = {};
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];

  for (let i = 0; i < lines.length; i += 1) {
    const many = lines[i].match(/^([^=]+)<<(.+)$/);

    if (many) {
      const body = [];

      for (i += 1; i < lines.length && lines[i] !== many[2]; i += 1) {
        body.push(lines[i]);
      }
      out[many[1]] = body.join("\n");
    } else if (lines[i].includes("=")) {
      const at = lines[i].indexOf("=");

      out[lines[i].slice(0, at)] = lines[i].slice(at + 1);
    }
  }

  return out;
};

// The plan job for one dispatch: { ok, log, outputs }. `outputs` is the
// job's outputs as e2e.yml maps them. `pages` left out is a dispatch
// that does not set it (GitHub then passes the default).
const plan = ({ specs = "", pages, ref = LANE } = {}) => {
  const wf = workflow("e2e.yml");
  const declared = wf.on.workflow_dispatch.inputs;
  const inputs = Object.fromEntries(Object.entries(declared)
    .map(([name, spec]) => [name, spec?.default ?? ""]));

  inputs.specs = specs;
  if (pages !== undefined) inputs.pages = pages;

  const steps = {};
  const dir = mkdtempSync(join(tmpdir(), "e2e-plan-"));
  let log = "";

  try {
    for (const [n, step] of wf.jobs.plan.steps.entries()) {
      if (step.uses) {
        if (/^actions\/checkout@/.test(step.uses)) continue;
        throw new Error(`the test can't run the plan step ${step.uses}`);
      }
      if (step.if) throw new Error(`the test can't evaluate if: ${step.if}`);

      const context = {
        inputs, github: { ref, event: { inputs } }, steps,
      };
      const env = Object.fromEntries(Object.entries(step.env || {})
        .map(([name, value]) => [name, evaluate(value, context)]));
      const script = join(dir, `step-${n}.sh`);
      const output = join(dir, `output-${n}`);

      writeFileSync(script, step.run);
      writeFileSync(output, "");
      const result = spawnSync("bash",
        ["--noprofile", "--norc", "-eo", "pipefail", script], {
          cwd: ROOT,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            GITHUB_OUTPUT: output,
            GITHUB_REF: ref,
            RUNNER_TEMP: dir,
            ...env,
          },
        });

      log += result.stdout + result.stderr;
      if (step.id) steps[step.id] = { outputs: readOutputs(output) };
      if (result.status !== 0) return { ok: false, log, outputs: null };
    }

    const outputs = Object.fromEntries(
      Object.entries(wf.jobs.plan.outputs || {}).map(([name, value]) =>
        [name, evaluate(value, { steps })]));

    return { ok: true, log, outputs, inputs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const errors = (log) => log.split("\n").filter((l) => l.includes("::error"));

// The job that runs named specs, and what it hands e2e-run.yml.
const narrowJob = (wf = workflow("e2e.yml")) => {
  const named = jobsOf(wf).filter(([, job]) => callsRun(job)
    && /needs\.plan\.outputs\.specs/.test(job.with?.args || ""));

  assert.equal(named.length, 1,
    "one job runs the named specs, with args from the plan's specs");

  return named[0][1];
};
const handed = (job, run) => Object.fromEntries(
  Object.entries(job.with || {}).map(([name, value]) => [name,
    evaluate(value, {
      needs: { plan: { outputs: run.outputs } },
      inputs: run.inputs,
      github: { event: { inputs: run.inputs } },
    })]));

// A refused plan runs no tests: every job that runs the suite waits on
// the plan and has no condition that runs it after a failure.
const assertRefusalRunsNoTests = () => {
  const wf = workflow("e2e.yml");
  const runners = jobsOf(wf).filter(([, job]) => callsRun(job));

  assert.ok(runners.length > 0, "e2e.yml calls e2e-run.yml");
  for (const [name, job] of runners) {
    const needs = [].concat(job.needs || []).join(" ");

    assert.match(needs, /\bplan\b/, `${name} needs plan`);
    assert.doesNotMatch(String(job.if || ""),
      /always\(\)|failure\(\)|cancelled\(\)/,
      `${name} must not run when plan fails`);
  }
};

const runBodies = (wf) => jobsOf(wf).flatMap(([name, job]) =>
  (job.steps || []).filter((s) => s.run)
    .map((s) => ({ where: `${name}: ${s.name || s.id || "step"}`,
      run: s.run })));

describe("e2e.yml: the pages input (#615)", () => {
  it("1. e2e.yml takes a pages input: a space-separated list of site "
    + "paths", () => {
    const input = workflow("e2e.yml").on.workflow_dispatch.inputs.pages;

    assert.ok(input, "on.workflow_dispatch.inputs.pages");
    assert.equal(input.type, "string");
    assert.notEqual(String(input.required), "true", "pages is optional");
    assert.equal(input.default ?? "", "", "empty by default");
    assert.match(String(input.description || ""), /space/i,
      "the description says the list is space-separated");
    assert.match(String(input.description || ""), /\bpaths?\b|\bpages?\b/i,
      "the description says the words are site paths");
  });

  it("2. pages is valid only together with specs: a dispatch with pages "
    + "and no specs is refused by the plan job, with a message that says "
    + "why", () => {
    for (const pages of ["/about/", "/about/ /"]) {
      const run = plan({ specs: "", pages });

      assert.equal(run.ok, false, `pages="${pages}" without specs`);
      const said = errors(run.log);

      assert.ok(said.length > 0, "an ::error annotation");
      assert.ok(said.some((l) => /pages/i.test(l) && /spec/i.test(l)),
        `the message names pages and specs: ${said.join(" | ")}`);
    }
    // Refused on a promoted branch too, where an empty specs is the
    // full run.
    assert.equal(plan({ specs: "", pages: "/about/",
      ref: "refs/heads/next" }).ok, false);
    assertRefusalRunsNoTests();
  });

  it("3. the plan job checks each word of pages against "
    + "^/[A-Za-z0-9._/-]*$ and refuses any word holding .. or //; a "
    + "refused dispatch runs no tests", () => {
    const narrow = narrowJob();
    const good = [
      ["/about/", ["/about/"]],
      ["/", ["/"]],
      ["/404.html", ["/404.html"]],
      ["/news/2026-11-18_a.post/", ["/news/2026-11-18_a.post/"]],
      ["/about/ /order/", ["/about/", "/order/"]],
      ["  /about/\t/  ", ["/about/", "/"]],
    ];

    for (const [pages, want] of good) {
      const run = plan({ specs: KEYBOARD, pages });

      assert.equal(run.ok, true, `pages=${JSON.stringify(pages)}\n${run.log}`);
      assert.deepEqual(words(handed(narrow, run).pages), want,
        `the named-specs job gets ${want.join(" ")}`);
    }

    const marker = join(mkdtempSync(join(tmpdir(), "e2e-pages-")), "ran");
    const bad = [
      // Not a site path, and one bad word refuses the list
      "about/", "/about/ about",
      // Holding ..
      "/..", "/../etc/", "/a/../b/", "/a..b/",
      // Holding //
      "//", "//evil.example/", "/a//b/",
      // Outside the pattern
      "/a b?c", "/a?x=1", "/a#x", "/a;b", "/a|b", "/a&b", "/*",
      "/a\\b", "/é/", "/a'b", "/a\"b", "/~a", "/a%2e",
      `/$(touch ${marker})/`, `/\`touch ${marker}\`/`, "/${HOME}/",
    ];

    for (const pages of bad) {
      const run = plan({ specs: KEYBOARD, pages });

      assert.equal(run.ok, false, `pages=${JSON.stringify(pages)} refused`);
      assert.ok(errors(run.log).length > 0,
        `pages=${JSON.stringify(pages)}: an ::error annotation`);
    }
    assert.equal(existsSync(marker), false, "no word was run as a command");
    rmSync(join(marker, ".."), { recursive: true, force: true });
    assertRefusalRunsNoTests();
  });

  it("4. the list reaches e2e-run.yml as an input and is exported to the "
    + "Run step as E2E_PAGES, through the environment only", () => {
    const run = plan({ specs: KEYBOARD, pages: "/about/ /" });

    assert.equal(run.ok, true, run.log);
    assert.deepEqual(words(handed(narrowJob(), run).pages), ["/about/", "/"],
      "the named-specs job passes pages to e2e-run.yml");

    const called = workflow("e2e-run.yml");
    const input = called.on.workflow_call.inputs.pages;

    assert.ok(input, "e2e-run.yml: on.workflow_call.inputs.pages");
    assert.equal(input.type, "string");
    assert.notEqual(String(input.required), "true",
      "the other callers need not pass it");

    const runners = jobsOf(called).flatMap(([, job]) => (job.steps || [])
      .filter((s) => /playwright test/.test(s.run || ""))
      .map((s) => ({ job, step: s })));

    assert.ok(runners.length > 0, "a step runs Playwright");
    for (const { job, step } of runners) {
      const env = { ...job.env, ...step.env };

      assert.equal(squash(env.E2E_PAGES), "${{ inputs.pages }}",
        `${step.name}: E2E_PAGES comes from the pages input, through env`);
      assert.doesNotMatch(step.run, /\$\{?E2E_PAGES\b/,
        `${step.name}: E2E_PAGES is not put on the command line`);
    }

    for (const [file, wf] of [["e2e.yml", workflow("e2e.yml")],
      ["e2e-run.yml", called]]) {
      for (const { where, run: body } of runBodies(wf)) {
        assert.doesNotMatch(body, /\$\{\{[^}]*pages[^}]*\}\}/i,
          `${file}, ${where}: no expression naming pages in a run body`);
      }
    }
  });

  it("6. without pages, a run behaves exactly as it does today", () => {
    const wf = workflow("e2e.yml");
    const narrow = narrowJob(wf);

    // Named specs: the same list, one shard, one pass, no pages.
    for (const run of [plan({ specs: KEYBOARD }),
      plan({ specs: KEYBOARD, pages: "" })]) {
      assert.equal(run.ok, true, run.log);
      assert.equal(run.outputs.specs, KEYBOARD);
      const to = handed(narrow, run);

      assert.deepEqual(words(to.args), [KEYBOARD]);
      assert.equal(to.passes, "1");
      assert.equal(to.shards, "[1]");
      assert.equal(to.total, "1");
      assert.equal(to.pages ?? "", "", "no pages handed on");
    }

    // No specs: the full suite and the burn-in, handed no pages.
    const full = plan({});

    assert.equal(full.ok, true, full.log);
    assert.equal(full.outputs.specs, "");
    for (const [name, job] of jobsOf(wf).filter(([, j]) => callsRun(j))) {
      if (job === narrow) continue;
      assert.equal(handed(job, full).pages ?? "", "",
        `${name} is handed no pages`);
    }

    // The refusals of today, unchanged.
    const badSpec = plan({ specs: "e2e/../x.spec.mjs" });

    assert.equal(badSpec.ok, false);
    assert.ok(errors(badSpec.log).some((l) =>
      l.includes("::error title=specs::Not a spec path under e2e/.")));
    for (const branch of ["next", "staging", "main"]) {
      const promoted = plan({ specs: KEYBOARD, ref: `refs/heads/${branch}` });

      assert.equal(promoted.ok, false, `named specs refused on ${branch}`);
      assert.ok(errors(promoted.log).some((l) =>
        l.includes("::error title=specs::Named specs run on lane")));
      assert.equal(plan({ ref: `refs/heads/${branch}` }).ok, true,
        `the full run still starts on ${branch}`);
    }

    // Callers of e2e-run.yml that pass no pages give the Run step an
    // empty E2E_PAGES, which the keyboard spec reads as unset.
    const input = workflow("e2e-run.yml").on.workflow_call.inputs.pages;

    assert.equal(input?.default ?? "", "", "pages defaults to empty");
    for (const file of ["e2e-burn-in.yml", "e2e-soak.yml"]) {
      for (const [name, job] of jobsOf(workflow(file))) {
        if (callsRun(job)) {
          assert.equal(job.with?.pages, undefined,
            `${file}, ${name}: no pages passed`);
        }
      }
    }
  });

  // From the notes on #615: the staging run falls back to one
  // whole-site test and throws when E2E_PAGES is set.
  it("note: e2e-staging.yml does not get the pages input", () => {
    const text = readFileSync(join(WORKFLOWS, "e2e-staging.yml"), "utf8");
    const wf = parseYaml(text);

    assert.equal(wf.on.workflow_dispatch?.inputs?.pages, undefined);
    assert.doesNotMatch(text, /E2E_PAGES|inputs\.pages/);
  });

  it("8. docs/cloud-lanes.md says how to run one page", () => {
    const doc = readFileSync(join(ROOT, "docs/cloud-lanes.md"), "utf8");
    // Code spans may wrap across lines.
    const flat = doc.replace(/\s*\n\s*/g, " ");
    const gh = /gh workflow run e2e\.yml[^`]*/g;
    const byHand = (flat.match(gh) || []).some((call) =>
      /-f specs="?e2e\//.test(call) && /-f pages="?\//.test(call));
    const byCommand =
      /bin\/nff e2e[^`]*\se2e\/[^`\s]+\.spec\.mjs[^`]*\s\/[^`\s]*/.test(flat);

    assert.ok(byHand || byCommand,
      "a dispatch that names a spec and a page, by gh or by bin/nff e2e");
    for (const stale of [/takes no pages/i, /prints pages without/i,
      /until `?e2e\.yml`? takes a `?pages`? input/i]) {
      assert.doesNotMatch(flat, stale, "nothing still says pages aren't sent");
    }
  });
});
