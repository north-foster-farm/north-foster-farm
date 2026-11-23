// The criteria tests for bin/nff e2e's verdict (#623), one per
// acceptance criterion and named for it, written from the criteria
// before the fix. The implementer may change how a test runs, never
// what it expects (~/.claude/CLAUDE.md, "Tests and implementation come
// from different agents").
//
// Held out of `npm test` until the fix lands: `npm test` runs
// test/**/*.test.mjs and this file is *.criteria.mjs. Run it on
// purpose with
//   node --import ./test/setup.mjs --test test/e2e-verdict.criteria.mjs
// and turn it on by renaming it to test/e2e-verdict.test.mjs.
//
// The contract these tests fix, beside test/e2e-dispatch.test.mjs's:
//
// - e2eCommand resolves to one of four exit codes, and never rejects
//   once it has dispatched:
//     0  the run passed
//     1  the run failed (it finished with any conclusion but success)
//     2  nothing was dispatched: a bad argument, spec, page, base or
//        branch (the codes test/e2e-dispatch-*.test.mjs assert today)
//     3  no verdict: the run was dispatched, but the command could not
//        find out how it ended (GitHub would not answer, or the run was
//        still going when the command stopped waiting)
// - GitHub is reached only through the `gh` command, as realDeps.api
//   does today: these tests leave `api` to its real default and put a
//   stand-in `gh` first on PATH (fixtures/github/fake-gh.mjs), which
//   answers from recordings and refuses, as gh 2.104.0 does, an answer
//   holding an escape character unless --allow-escape-sequences is
//   given. How the real seam gets the log past that refusal is the
//   implementer's: the flag, or another `gh` call that returns the
//   same bytes.
// - bin/e2e/dispatch.mjs exports LOOK_TRIES, a whole number of at
//   least 2: the most looks at the run in a row whose answer may fail
//   (a 404, or gh failing any other way) before the command gives up
//   on a verdict. A look that answers resets the count. Each look after
//   the first follows a call to wait(), the bullpen's limit on how
//   often a lane asks GitHub.
//
// Recordings: fixtures/github/e2e-verdict.json says where each came
// from; the run that lost its verdict, its jobs and its failed shard's
// log with escape sequences (e2e-verdict-escapes.txt), gh's refusal of
// that log, a 404 for a run that does not exist, and gh failing to
// connect. The dispatch, the queued look and a passed run are
// e2e-dispatch.json's, recorded for #610. The stand-in only puts a
// run's id into them.

import assert from "node:assert/strict";
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import * as dispatch from "../bin/e2e/dispatch.mjs";

// Read by name, so a missing LOOK_TRIES fails criterion 2 alone.
const { LOOK_TRIES, e2eCommand } = dispatch;

const fixture = (name) => new URL(`fixtures/github/${name}`, import.meta.url);
const V = JSON.parse(readFileSync(fixture("e2e-verdict.json"), "utf8"));
const F = JSON.parse(readFileSync(fixture("e2e-dispatch.json"), "utf8"));
const ESCAPES_LOG = fileURLToPath(fixture("e2e-verdict-escapes.txt"));
const FAILED_LOG = fileURLToPath(fixture("e2e-dispatch-failed.txt"));
const FAKE_GH = fileURLToPath(fixture("fake-gh.mjs"));

const REPO = "repos/north-foster-farm/north-foster-farm";
const BRANCH = "lane/e2e-cmd-tests";
const SPEC = "e2e/skeletons.spec.mjs";
// eslint-disable-next-line no-control-regex -- #791 c7105461370: the point
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

// The failing tests in e2e-verdict-escapes.txt's closing list. Their
// names hold no site path, so there is no page to report.
const ESCAPES_FAILURES = [
  { file: "e2e/payment.spec.mjs",
    title: "a card pays for a market occurrence, stored with it and "
      + "named in the emails",
    projects: ["desktop"], not: ["phone"] },
  { file: "e2e/skeletons.spec.mjs",
    title: "the account page fails with Try again",
    projects: ["desktop", "phone"], not: [] },
  { file: "e2e/skeletons.spec.mjs",
    title: "a request that never answers gives up after ten seconds",
    projects: ["desktop", "phone"], not: [] },
];

const answer = (value) => ({ stdout: JSON.stringify(value) });
const failedAnswer = (recorded) => ({
  stdout: recorded.stdout, stderr: recorded.stderr,
  exitCode: recorded.exitCode,
});
const NOT_FOUND = failedAnswer(V.notFound);
const UNREACHABLE = failedAnswer(V.unreachable);

let home;
let bin;
let oldPath;

// The stand-in, named gh, first on PATH; each world points it at its
// own plan.
before(() => {
  home = mkdtempSync(join(tmpdir(), "e2e-verdict-"));
  bin = join(home, "bin");
  mkdirSync(bin);
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${oldPath}`;
});

after(() => {
  process.env.PATH = oldPath;
  rmSync(home, { recursive: true, force: true });
});

// A world: GitHub as gh answers it, for one dispatch of SPEC. `looks`
// are the answers to GET <run>, in turn, the last repeating. The
// dispatch names `run`; its jobs and logs answer as recorded.
const world = ({ run, looks, jobs, logs = {} }) => {
  const dir = mkdtempSync(join(home, "world-"));
  const runPath = `${REPO}/actions/runs/${run.id}`;
  const named = { id: run.id, url: run.url, html_url: run.html_url };
  const plan = {
    routes: [
      { method: "POST",
        path: `${REPO}/actions/workflows/e2e.yml/dispatches`,
        answers: [answer({ ...F.dispatch.response, workflow_run_id: run.id,
          run_url: run.url, html_url: run.html_url })] },
      { method: "GET", path: runPath,
        answers: looks.map((look) => {
          if (look === "queued") return answer({ ...F.runQueued, ...named });
          if (look === "done") return answer(run);

          return look;
        }) },
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

  const lines = [];
  const calls = () => readFileSync(join(dir, "calls.log"), "utf8")
    .split("\n").filter(Boolean);
  const runLooks = () => calls().filter((c) => c === `GET ${runPath}`);
  const waitsAt = [];

  return {
    run, lines, runLooks, waitsAt,
    io: { flags: {}, out: (line) => lines.push(String(line)) },
    deps: {
      branch: async () => BRANCH,
      changed: async () => [],
      wait: async () => {
        waitsAt.push(runLooks().length);
      },
    },
    go() {
      return e2eCommand([SPEC], this.io, this.deps);
    },
  };
};

const lastLines = (w, n) => w.lines.slice(-n).join("\n");

describe("bin/nff e2e's verdict (#623 acceptance criteria)", () => {
  it("1. a failed job whose log holds terminal escape sequences is read "
    + "and reported as any other: each failing test's file, name, page "
    + "and projects, and the run's URL, with no control character "
    + "printed", async () => {
    const w = world({
      run: V.run,
      looks: ["queued", "done"],
      jobs: V.jobs,
      logs: { [V.failedJobId]: ESCAPES_LOG },
    });

    const code = await w.go();

    assert.equal(code, 1, `the run failed:\n${w.lines.join("\n")}`);
    const printed = w.lines.join("\n");

    assert.ok(printed.includes(V.run.html_url), "the run's URL");
    for (const f of ESCAPES_FAILURES) {
      const lines = w.lines.filter((l) => l.includes(f.title));

      assert.equal(lines.length, 1, `one line for "${f.title}"`);
      assert.ok(lines[0].includes(f.file), `${f.file} on its line`);
      for (const p of f.projects) {
        assert.match(lines[0], new RegExp(`\\b${p}\\b`), `${p} on its line`);
      }
      for (const p of f.not) {
        assert.doesNotMatch(lines[0], new RegExp(`\\b${p}\\b`),
          `not ${p}: it passed there`);
      }
    }
    for (const line of w.lines) {
      assert.doesNotMatch(line, CONTROL, `a control character in ${
        JSON.stringify(line)}`);
    }
  });

  it("2. a single failed or 404 answer while waiting does not end the "
    + "command: it looks again, a bounded number of times, and says so "
    + "in one line", async () => {
    assert.ok(Number.isInteger(LOOK_TRIES) && LOOK_TRIES >= 2,
      `LOOK_TRIES is a whole number of at least 2: ${LOOK_TRIES}`);

    const passed = { run: F.runPassed };
    const plain = world({ ...passed, looks: ["queued", "queued", "done"] });

    assert.equal(await plain.go(), 0, plain.lines.join("\n"));

    for (const [why, looks] of [
      ["a 404 while queued", ["queued", NOT_FOUND, "done"]],
      ["a 404 at the first look", [NOT_FOUND, "queued", "done"]],
      ["gh failing to connect", ["queued", UNREACHABLE, "done"]],
    ]) {
      const w = world({ ...passed, looks });
      const code = await w.go();
      const extra = w.lines.filter((l) => !plain.lines.includes(l));

      assert.equal(code, 0, `${why}: the verdict still comes:\n${
        w.lines.join("\n")}`);
      assert.equal(w.runLooks().length, 3, `${why}: looked again`);
      assert.equal(w.lines.length, plain.lines.length + 1,
        `${why}: one line more than with no failure:\n${w.lines.join("\n")}`);
      assert.equal(extra.length, 1, `${why}: the one line says so`);
      assert.doesNotMatch(extra[0], CONTROL, `${why}: printed safely`);
      for (let n = 1; n < w.runLooks().length; n += 1) {
        assert.ok(w.waitsAt.includes(n), `${why}: waited after look ${n}`);
      }
    }

    // Failures not in a row never add up to the bound.
    const apart = [];

    for (let i = 0; i <= LOOK_TRIES; i += 1) apart.push(NOT_FOUND, "queued");
    const spread = world({ ...passed, looks: [...apart, "done"] });

    assert.equal(await spread.go(), 0,
      `${LOOK_TRIES + 1} failures, never two in a row:\n${
        spread.lines.join("\n")}`);

    // The bound: after LOOK_TRIES failures in a row it stops looking.
    const lost = world({ ...passed, looks: ["queued", NOT_FOUND] });
    const code = await lost.go();

    assert.equal(lost.runLooks().length, 1 + LOOK_TRIES,
      `the queued look, then ${LOOK_TRIES} that failed`);
    assert.notEqual(code, 0, "no pass claimed");
  });

  it("3. when it cannot get a verdict it says so plainly, gives the run's "
    + "URL and exits 3, not the 1 of a failed run", async () => {
    const plainly = /verdict|could not|couldn't|cannot|can't|unable|unknown/i;

    // The run failed: 1.
    const failed = world({
      run: F.runFailed,
      looks: ["queued", "done"],
      jobs: F.jobsFailed,
      logs: { [F.failedJobId]: FAILED_LOG },
    });

    assert.equal(await failed.go(), 1, failed.lines.join("\n"));

    // GitHub stops answering: 3.
    for (const [why, gone] of [["404s", NOT_FOUND],
      ["gh failing to connect", UNREACHABLE]]) {
      const w = world({ run: F.runPassed, looks: ["queued", gone] });
      const code = await w.go();
      const end = lastLines(w, 3);

      assert.equal(code, 3, `${why}: no verdict:\n${w.lines.join("\n")}`);
      assert.ok(end.includes(F.runPassed.html_url),
        `${why}: the run's URL at the end:\n${end}`);
      assert.match(end, plainly, `${why}: says it has no verdict:\n${end}`);
      for (const line of w.lines) {
        assert.doesNotMatch(line, CONTROL, `${why}: printed safely`);
      }
    }

    // The run never finishes while it waits: 3.
    const slow = world({ run: F.runPassed, looks: ["queued"] });
    const code = await slow.go();
    const end = lastLines(slow, 3);

    assert.equal(code, 3, `still queued: no verdict:\n${
      slow.lines.join("\n")}`);
    assert.ok(end.includes(F.runPassed.html_url),
      `still queued: the run's URL at the end:\n${end}`);
    assert.match(end, plainly, `still queued: says so:\n${end}`);
  });
});
