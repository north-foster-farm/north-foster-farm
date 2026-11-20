/* eslint-disable camelcase -- GitHub names its fields its way */
// Criteria test for #693 (retry failing e2e tests automatically), box
// 4: `bin/nff e2e`'s verdict names a test that passed on a retry as
// flaky. Boxes 1 to 3 are test/promote-retry.criteria.mjs. Written by
// the e2e-cmd-tests lane from the issue's "Done when" list before
// anything was built. The
// implementer may change how the test runs, never what it expects
// (~/.claude/CLAUDE.md, "Tests and implementation come from different
// agents"). Held out of `npm test` by its name; turn it on with
//
//   git mv test/e2e-retry-verdict.criteria.mjs \
//     test/e2e-retry-verdict.test.mjs
//
// THE CONTRACT
//
// With Playwright's retries on, a test that fails and then passes on a
// retry is flaky. The verdict reads the logs of the run's shard jobs
// (`api("repos/north-foster-farm/north-foster-farm/actions/jobs/ID/
// logs")`) for Playwright's closing `  N flaky` list, in a passed run
// as in a failed one, and prints exactly one line per flaky test that
// holds the word "flaky", its spec file and its title (once even when
// it was flaky in both projects), with no control character. The
// wording around them is the implementer's. A passed run still exits
// 0 and prints its URL; a failed run still exits 1 and still names
// each test that failed every try, on a line that does not call it
// flaky.
//
// GitHub is reached through the `gh` stand-in of test/e2e-verdict.
// test.mjs (fixtures/github/fake-gh.mjs), first on PATH, answering
// from recordings.
//
// THE FAKES, NOT YET RECORDED
//
// No recorded run holds a flaky test: every workflow has passed
// `--retries=0` since the suite began, and Playwright reports "flaky"
// only with retries on. The test reads test/fixtures/github/
// e2e-retry.json and fails, saying so, until it is recorded. The
// recording, proposed to the coordinator 2026-11-20, on the scratch
// branch of test/promote-retry.criteria.mjs (its specs, titles and
// e2e-staging.yml change are there):
//
// 1. That branch's copy of e2e-run.yml runs `--retries=2` in place of
//    `--retries=0`. Two dispatches of its e2e.yml with named specs:
//    `-f specs=e2e/zz-retry-flaky.spec.mjs` (a passed run, `flaky`),
//    then both zz-retry specs (a failed run, `failed`).
// 2. Each run, its jobs and every shard job's log recorded with gh,
//    read-only (GET .../actions/runs/RUN, GET .../runs/RUN/jobs,
//    GET .../actions/jobs/JOB/logs with --allow-escape-sequences),
//    under `local` in e2e-retry.json, logs byte for byte beside it:
//      "local": {
//        "flaky":  { "run": RUN, "jobs": { "total_count": N,
//                    "jobs": [...] },
//                    "logs": { "JOB": "e2e-retry-local-RUN.txt", ... } },
//        "failed": { the same } }
//
// The dispatch and the queued look are e2e-dispatch.json's, recorded
// for #610, with the recorded run's id put into them, as
// test/e2e-verdict.test.mjs does.

import assert from "node:assert/strict";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { e2eCommand } from "../bin/e2e/dispatch.mjs";

const fixture = (name) => new URL(`fixtures/github/${name}`, import.meta.url);
const F = JSON.parse(readFileSync(fixture("e2e-dispatch.json"), "utf8"));
const FAKE_GH = fileURLToPath(fixture("fake-gh.mjs"));
const RETRY_FILE = "e2e-retry.json";

const REPO = "repos/north-foster-farm/north-foster-farm";
const BRANCH = "lane/e2e-cmd-tests";
const SPEC = "e2e/skeletons.spec.mjs";
const CONTROL = /[\x00-\x1f\x7f-\x9f]/; // eslint-disable-line no-control-regex

const FLAKY = { file: "e2e/zz-retry-flaky.spec.mjs",
  title: "fails on its first try and passes on a retry" };
const FAILS = { file: "e2e/zz-retry-fails.spec.mjs",
  title: "fails on every try" };

// The recording, or a failure that says it is still to be made.
const recorded = () => {
  assert.ok(existsSync(fixture(RETRY_FILE)), "test/fixtures/github/"
    + `${RETRY_FILE} is not recorded yet: see this file's header`);

  return JSON.parse(readFileSync(fixture(RETRY_FILE), "utf8")).local;
};

const answer = (value) => ({ stdout: JSON.stringify(value) });

let home;
let bin;
let oldPath;

before(() => {
  home = mkdtempSync(join(tmpdir(), "e2e-retry-"));
  bin = join(home, "bin");
  mkdirSync(bin);
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${oldPath}`;
});

after(() => {
  process.env.PATH = oldPath;
  rmSync(home, { recursive: true, force: true });
});

// GitHub as gh answers it, for one dispatch that names the recorded
// run: queued once, then done; its jobs and logs as recorded.
const world = ({ run, jobs, logs }) => {
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
        answers: [answer({ ...F.runQueued, ...named }), answer(run)] },
      { method: "GET", path: `${runPath}/jobs`, answers: [answer(jobs)] },
      ...Object.entries(logs).map(([id, file]) => ({
        method: "GET", path: `${REPO}/actions/jobs/${id}/logs`,
        answers: [{ stdoutFile: fileURLToPath(fixture(file)) }] })),
    ],
  };

  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  writeFileSync(join(dir, "calls.log"), "");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec "${process.execPath}" `
    + `"${FAKE_GH}" "${dir}" "$@"\n`);
  chmodSync(join(bin, "gh"), 0o755);

  const lines = [];

  return {
    lines,
    go: () => e2eCommand([SPEC],
      { flags: {}, out: (line) => lines.push(String(line)) },
      { branch: async () => BRANCH, changed: async () => [],
        wait: async () => {} }),
  };
};

const linesOf = (w, t) => w.lines
  .filter((l) => l.includes(t.title) && l.includes(t.file));

describe("bin/nff e2e's verdict and retried tests (#693 criteria)", () => {
  it("4. names a test that passed on a retry as flaky", async () => {
    const { flaky, failed } = recorded();

    const green = world(flaky);
    const greenCode = await green.go();
    const greenOut = green.lines.join("\n");

    assert.equal(greenCode, 0, `the run passed:\n${greenOut}`);
    assert.ok(greenOut.includes(flaky.run.html_url), "the run's URL");
    assert.equal(linesOf(green, FLAKY).length, 1,
      `one line names the flaky test:\n${greenOut}`);
    assert.match(linesOf(green, FLAKY)[0], /flaky/i, "and calls it flaky");

    const red = world(failed);
    const redCode = await red.go();
    const redOut = red.lines.join("\n");

    assert.equal(redCode, 1, `the run failed:\n${redOut}`);
    assert.equal(linesOf(red, FLAKY).length, 1,
      `one line names the flaky test:\n${redOut}`);
    assert.match(linesOf(red, FLAKY)[0], /flaky/i, "and calls it flaky");
    assert.equal(linesOf(red, FAILS).length, 1,
      `one line names the test that failed every try:\n${redOut}`);
    assert.doesNotMatch(linesOf(red, FAILS)[0], /flaky/i,
      "and does not call it flaky");

    for (const line of [...green.lines, ...red.lines]) {
      assert.doesNotMatch(line, CONTROL, `a control character in ${
        JSON.stringify(line)}`);
    }
  });
});
