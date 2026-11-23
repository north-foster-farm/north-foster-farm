// Criteria tests for #647, written by a test agent from the issue's
// spec and "Done when" list before the fix: `bin/nff e2e` records its
// run for James's status line through ~/.bin/report_run, when that
// script is there and executable, once, and with its exit status,
// verdict and output unchanged. One test per box, named for it.
//
// Held out of `npm test` until the fix lands: `npm test` runs
// test/**/*.test.mjs and this file is *.criteria.mjs. Run it with
//   node --import ./test/setup.mjs --test test/e2e-report-run.criteria.mjs
// and turn it on by renaming it to test/e2e-report-run.test.mjs.
//
// Never the real report_run, never James's run records: each run of
// `bin/nff e2e` here has HOME set to a folder of the test's own, and
// ~/.bin/report_run there, when a test puts one, is a stand-in that
// behaves as the real one's header says (read with James's leave,
// 2026-11-20, header only):
//
//   report_run KIND [--] COMMAND...   KIND is build, test or e2e
//   report_run -c 'COMMAND'           as npm's script shell
//
// - It runs the command from the current folder, its output, input
//   and exit status passing through untouched, and exits as it did.
// - It records "running" when the command starts and "passed" or
//   "failed" with the exit status when it ends, against the current
//   folder's repository; outside a git repository it records nothing.
// - As npm's script shell (-c) it records only a script named build,
//   test, test:NAME or e2e (test:e2e as e2e), by npm_lifecycle_event;
//   every other one just runs.
// - It sets no variable of its own for the command: the header names
//   none, so the stand-in gives nothing the real one may not.
// Its records go to a file in the test's folder, one JSON line each.
//
// The rest of the world is what test/e2e-verdict.test.mjs uses: GitHub
// through a stand-in `gh` first on PATH (fixtures/github/fake-gh.mjs),
// answering from e2e-dispatch.json and e2e-verdict.json's recordings,
// the run already finished at the first look, so the command never
// waits. `bin/nff` runs by its absolute path from a scratch git
// repository of the test's own, on a lane branch, as a lane runs it
// from its worktree.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NFF = join(ROOT, "bin", "nff");
const fixture = (name) => new URL(`fixtures/github/${name}`, import.meta.url);
const F = JSON.parse(readFileSync(fixture("e2e-dispatch.json"), "utf8"));
const V = JSON.parse(readFileSync(fixture("e2e-verdict.json"), "utf8"));
const FAILED_LOG = fileURLToPath(fixture("e2e-dispatch-failed.txt"));
const FAKE_GH = fileURLToPath(fixture("fake-gh.mjs"));

const REPO = "repos/north-foster-farm/north-foster-farm";
const BRANCH = "lane/report-run-647";
const SPEC = "e2e/skeletons.spec.mjs";

// The stand-in for ~/.bin/report_run (see the header). `records` is
// the file it writes to.
const standInSource = (records) => `#!${process.execPath}
// A stand-in for ~/.bin/report_run, written by
// test/e2e-report-run.criteria.mjs (#647).
const { spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");

const RECORDS = ${JSON.stringify(records)};
const args = process.argv.slice(2);
let kind = null;
let run;

if (args[0] === "-c") {
  const event = process.env.npm_lifecycle_event || "";

  if (event === "test:e2e") kind = "e2e";
  else if (event === "build" || event === "e2e") kind = event;
  else if (event === "test" || event.startsWith("test:")) kind = "test";
  run = () => spawnSync("/bin/sh", ["-c", args[1]], { stdio: "inherit" });
} else {
  kind = args[0];
  const command = args[1] === "--" ? args.slice(2) : args.slice(1);

  run = () => spawnSync(command[0], command.slice(1), { stdio: "inherit" });
}

const inRepo = spawnSync("git", ["rev-parse", "--show-toplevel"],
  { encoding: "utf8" });
const repo = inRepo.status === 0 ? inRepo.stdout.trim() : null;
const record = (fields) => {
  if (!kind || !repo) return;
  appendFileSync(RECORDS, JSON.stringify({ kind, repo, ...fields }) + "\\n");
};

record({ state: "running" });
const done = run();
const status = done.status === null ? 1 : done.status;

record({ state: status === 0 ? "passed" : "failed", status });
process.exit(status);
`;

let home;
let repo;

before(() => {
  home = mkdtempSync(join(tmpdir(), "e2e-report-run-"));
  repo = join(home, "repo");
  mkdirSync(repo);
  // HOME and the global config off, so none of James's git settings
  // (a hook path, a signing key) reach the scratch repository.
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });

    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  };

  git("init", "-q", "-b", BRANCH);
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty",
    "-m", "scratch");
  repo = realpathSync(repo);
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

const answer = (value) => ({ stdout: JSON.stringify(value) });

// The three ends a run can come to: passed, failed, or a dispatch
// GitHub could not be reached for.
const OUTCOMES = {
  passed: { run: F.runPassed },
  failed: { run: F.runFailed, jobs: F.jobsFailed,
    logs: { [F.failedJobId]: FAILED_LOG } },
  "dispatch error": { dispatch: {
    stdout: V.unreachable.stdout, stderr: V.unreachable.stderr,
    exitCode: V.unreachable.exitCode,
  } },
};

// A world: its own HOME, with or without a stand-in report_run, and
// its own GitHub, as gh answers it, for one dispatch of SPEC.
// `reportRun` is "executable", "not executable" or absent.
const world = ({ outcome = "passed", reportRun } = {}) => {
  const dir = mkdtempSync(join(home, "world-"));
  const bin = join(dir, "bin");
  const own = join(dir, "home");
  const records = join(dir, "records.jsonl");
  const standIn = join(own, ".bin", "report_run");
  const { run = F.runPassed, jobs, logs = {}, dispatch } = OUTCOMES[outcome];
  const runPath = `${REPO}/actions/runs/${run.id}`;

  mkdirSync(bin);
  mkdirSync(join(own, ".bin"), { recursive: true });
  if (reportRun) {
    writeFileSync(standIn, standInSource(records));
    chmodSync(standIn, reportRun === "executable" ? 0o755 : 0o644);
  }

  const plan = {
    routes: [
      { method: "POST",
        path: `${REPO}/actions/workflows/e2e.yml/dispatches`,
        answers: [dispatch || answer({ ...F.dispatch.response,
          workflow_run_id: run.id, html_url: run.html_url })] },
      { method: "GET", path: runPath, answers: [answer(run)] },
      ...(jobs ? [{ method: "GET", path: `${runPath}/jobs`,
        answers: [answer(jobs)] }] : []),
      ...Object.entries(logs).map(([id, file]) => ({
        method: "GET", path: `${REPO}/actions/jobs/${id}/logs`,
        answers: [{ stdoutFile: file }] })),
    ],
  };

  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  writeFileSync(join(dir, "calls.log"), "");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec "${process.execPath}" `
    + `"${FAKE_GH}" "${dir}" "$@"\n`);
  chmodSync(join(bin, "gh"), 0o755);

  // The environment a lane's shell gives it, minus anything of npm's.
  const env = { ...process.env, HOME: own, GIT_CONFIG_NOSYSTEM: "1",
    PATH: [bin, dirname(process.execPath), process.env.PATH]
      .join(delimiter) };

  for (const name of Object.keys(env)) {
    if (name.startsWith("npm_")) delete env[name];
  }

  const ran = (r) => ({ code: r.status, stdout: r.stdout, stderr: r.stderr,
    signal: r.signal });

  return {
    run,
    standIn,
    // Runs bin/nff e2e with these words, as a lane types it.
    nff(...words) {
      return ran(spawnSync(process.execPath, [NFF, "e2e", ...words],
        { cwd: repo, env, encoding: "utf8", timeout: 60000 }));
    },
    // A shell command run as npm runs a script named `script`: through
    // its script shell, the stand-in.
    npmRun(script, command) {
      return ran(spawnSync(standIn, ["-c", command], {
        cwd: repo, encoding: "utf8", timeout: 60000,
        env: { ...env, npm_lifecycle_event: script,
          npm_config_script_shell: standIn, npm_command: "run-script" },
      }));
    },
    records() {
      if (!existsSync(records)) return [];

      return readFileSync(records, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
};

const shown = (r) => `exit ${r.code}${r.signal ? ` (${r.signal})` : ""}\n`
  + `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`;

// The line that says how the run ended: the last one printed.
const verdictLine = (r) => {
  const lines = `${r.stdout}`.trimEnd().split("\n");

  return lines[lines.length - 1];
};

// A world's records as states, with the status of a finished one.
const states = (w) => w.records().map((r) => (r.status === undefined
  ? `${r.kind} ${r.state}` : `${r.kind} ${r.state} ${r.status}`));

describe("bin/nff e2e records its run (#647 acceptance criteria)",
  { timeout: 300000 }, () => {
    it("1. with an executable ~/.bin/report_run present, bin/nff e2e "
      + "<spec> records one e2e run: running at the start, then passed "
      + "or failed matching the command's exit status", async (t) => {
      const run = ([outcome, code, state]) =>
        t.test(`a run that ${outcome}`, () => {
          const w = world({ outcome, reportRun: "executable" });
          const r = w.nff(SPEC);

          assert.equal(r.code, code, shown(r));
          assert.deepEqual(states(w),
            ["e2e running", `e2e ${state} ${code}`], shown(r));
          for (const record of w.records()) {
            assert.equal(record.repo, repo,
              "recorded against the folder it was run from");
          }
        });

      for (const row of [
        ["passed", 0, "passed"], ["failed", 1, "failed"],
      ]) {
        await run(row);
      }
    });

    it("2. without the script (CI, cloud runs), bin/nff e2e runs as it "
      + "does today and records nothing", async (t) => {
      await t.test("no ~/.bin/report_run", () => {
        const w = world({ outcome: "passed" });
        const r = w.nff(SPEC);

        assert.equal(r.code, 0, shown(r));
        assert.equal(verdictLine(r), `Passed: ${w.run.html_url}`, shown(r));
        assert.deepEqual(w.records(), []);
      });

      await t.test("a ~/.bin/report_run that is not executable", () => {
        const w = world({ outcome: "passed", reportRun: "not executable" });
        const r = w.nff(SPEC);

        assert.equal(r.code, 0, shown(r));
        assert.equal(verdictLine(r), `Passed: ${w.run.html_url}`, shown(r));
        assert.deepEqual(w.records(), [], "the script was not run");
      });
    });

    it("3. bin/nff e2e --dry-run records nothing", () => {
      const w = world({ reportRun: "executable" });
      const r = w.nff(SPEC, "--dry-run");

      assert.equal(r.code, 0, shown(r));
      assert.match(r.stdout, /^Specs \(1\): e2e\/skeletons\.spec\.mjs$/m,
        `the choice is printed:\n${shown(r)}`);
      assert.deepEqual(w.records(), []);
    });

    it("4. a run started through npm run e2e, or otherwise already under "
      + "report_run, is recorded once, not twice", () => {
      const w = world({ outcome: "passed", reportRun: "executable" });
      const r = w.npmRun("e2e",
        `"${process.execPath}" "${NFF}" e2e ${SPEC}`);

      assert.equal(r.code, 0, shown(r));
      assert.deepEqual(states(w), ["e2e running", "e2e passed 0"],
        shown(r));
    });

    it("5. the exit status and the verdict line of bin/nff e2e are the "
      + "same as before the change, for a pass, a failure and a dispatch "
      + "error", async (t) => {
      // As today: the code each ends with, and a line of its verdict.
      const today = {
        passed: { code: 0, line: `Passed: ${F.runPassed.html_url}` },
        failed: { code: 1, line: `Failed: ${F.runFailed.html_url}` },
        "dispatch error": { code: 1, line: null },
      };

      for (const [outcome, want] of Object.entries(today)) {
        await t.test(`a ${outcome}`, () => {
          const without = world({ outcome }).nff(SPEC);
          const w = world({ outcome, reportRun: "executable" });
          const r = w.nff(SPEC);

          assert.equal(without.code, want.code, shown(without));
          if (want.line) {
            assert.ok(without.stdout.split("\n").includes(want.line),
              `the verdict without report_run:\n${shown(without)}`);
          }
          assert.ok(w.records().length,
            `report_run was used:\n${shown(r)}`);
          assert.equal(r.code, without.code, shown(r));
          assert.equal(verdictLine(r), verdictLine(without), shown(r));
          assert.equal(r.stdout, without.stdout, "the output is the same");
          assert.equal(r.stderr, without.stderr,
            "the error output is the same");
        });
      }
    });
  });
