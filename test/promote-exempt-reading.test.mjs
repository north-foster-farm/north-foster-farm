// The implementer's own tests for bin/staging-exempt.mjs (#654): the
// edges of reading a log and a record that the criteria tests in
// test/promote-exempt.test.mjs do not reach. Additions only; they
// replace none of those.
//
// Every log here is a recording (test/fixtures/github/, recorded
// 2026-11-18 for #654). Where one is changed, the change is named
// beside it as COMPOSED and touches only the lines it says. The staging
// runs of the stood-down case are #502's recording,
// e2e-staging-runs.json.

/* eslint-disable camelcase -- GitHub names its fields its way */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  EXEMPTIONS, failedInLog, failedOnlyInRun, judgedJob, passedIn,
  passesInLog, stagingExemption,
} from "../bin/staging-exempt.mjs";
import { STAGING_E2E } from "../bin/promote.mjs";

const REPO = "north-foster-farm/north-foster-farm";
const DIR = new URL("fixtures/github/", import.meta.url);
const text = (name) => readFileSync(new URL(name, DIR), "utf8");
const CHALLENGED = text("e2e-exempt-staging-44396830525.txt");
const MIXED = text("e2e-exempt-staging-44379156341.txt");
const LOCAL = text("e2e-exempt-local-44260592026.txt");
const OLD_RUNS = JSON.parse(text("e2e-staging-runs.json"));
const REC = JSON.parse(text("e2e-exempt.json"));

// COMPOSED helpers: each maps the recorded lines.
const lines = (log) => log.split("\n");
const stamp = (line) => line.match(/^\S+ /)[0];
const replaceLine = (log, find, make) => lines(log)
  .map((l) => (l.includes(find) ? make(l) : l)).join("\n");
const afterLine = (log, find, add) => lines(log)
  .flatMap((l) => (l.includes(find) ? [l, ...add(l)] : [l])).join("\n");
const afterFirst = (log, find, add) => {
  const all = lines(log);
  const at = all.findIndex((l) => l.includes(find));

  assert.ok(at >= 0, `no recorded line holds ${find}`);

  return [...all.slice(0, at + 1), ...add(all[at]), ...all.slice(at + 1)]
    .join("\n");
};

const WALK = "e2e/overflow.spec.mjs:92:5 › at 375px (#185) › every page fits";
const FIRST_ERROR = "Error: 19 request(s), first /news/fall-update/";

describe("reading a staging job's log for the exemption (#654)", () => {
  it("reads the recorded failures and which met the challenge alone",
    () => {
      const failed = failedInLog(CHALLENGED);

      assert.equal(failed.length, 9);
      assert.deepEqual(failed.filter((f) => f.challenge).length, 8);
      assert.deepEqual(failed.filter((f) => !f.challenge)
        .map((f) => f.spec), ["e2e/membership.spec.mjs"]);
      assert.ok(failedInLog(MIXED).every((f) => !f.challenge));
    });

  it("cannot read a list of nothing, a miscount or two lists", () => {
    // COMPOSED: the count changed, or the closing line repeated.
    for (const n of ["0", "8", "10"]) {
      assert.equal(failedInLog(replaceLine(CHALLENGED, "   9 failed",
        (l) => l.replace("9 failed", `${n} failed`))), null, n);
    }
    assert.equal(failedInLog(afterLine(CHALLENGED, "Function calls:",
      (l) => [`${stamp(l)}  9 failed`])), null);
    assert.equal(failedInLog(null), null);
    assert.equal(failedInLog(LOCAL), null);
  });

  it("does not take a challenge when a test's report is found twice",
    () => {
      // COMPOSED: the first report's header and message repeated before
      // the reports begin.
      const header = lines(CHALLENGED).find((l) => l.includes(`1) [desktop] › ${
        WALK}`));
      const message = lines(CHALLENGED).find((l) => l.includes(FIRST_ERROR));
      const twice = afterLine(CHALLENGED, "Function calls:",
        () => [header, message]);
      const walk = failedInLog(twice).find((f) => f.title
        === "at 375px (#185) › every page fits");

      assert.equal(walk.challenge, false);
    });

  // Finding 3 of #656's security review: a report is the challenge alone
  // only when every line of it has a shape the recorded challenge
  // reports have, in their order.
  describe("a challenge report holds nothing but the challenge", () => {
    const walkOf = (log) => failedInLog(log).find((f) => f.title
      === "at 375px (#185) › every page fits");
    const message = lines(CHALLENGED).find((l) => l.includes(FIRST_ERROR))
      .replace(/^\S+ +/, "");
    // COMPOSED: lines added to the first walk's report, after the last
    // line of its stack, or after its message.
    const after = (find, ...added) => afterFirst(CHALLENGED, find,
      (l) => added.map((a) => `${stamp(l)}    ${a}`));
    const STACK_END = "netlifyChallenge.auto (/__w/";

    it("takes the recorded report as it is", () => {
      assert.equal(walkOf(CHALLENGED).challenge, true);
    });

    it("refuses an error of another name after the challenge", () => {
      for (const second of ["TypeError: Cannot read properties of null",
        "Error: expect(received).toBe(expected)",
        "TimeoutError: page.goto: Timeout 30000ms exceeded."]) {
        assert.equal(walkOf(after(STACK_END, "", second)).challenge, false,
          second);
      }
    });

    it("refuses a timeout, a teardown or an interruption after it", () => {
      for (const second of ["Test timeout of 30000ms exceeded.",
        "Tearing down \"page\" exceeded the test timeout of 30000ms.",
        "Test was interrupted."]) {
        assert.equal(walkOf(after(STACK_END, "", second)).challenge, false,
          second);
      }
    });

    it("refuses a retry, even one that met the challenge again", () => {
      assert.equal(walkOf(after(STACK_END, "", `Retry #1 ${"─".repeat(20)}`,
        "", message)).challenge, false);
    });

    it("ends a report only at the header of a listed test", () => {
      // #656 review, round 2: a header naming no listed test, then a
      // second error, used to end the walk's report before the error.
      const unlisted = after(STACK_END, "",
        "99) [desktop] › e2e/nothing.spec.mjs:1:1 › not a failure", "",
        "TypeError: Cannot read properties of undefined");
      // A copy of the walk's own header gives it two reports.
      const header = lines(CHALLENGED).find((l) => l.includes(`1) [desktop] › ${
        WALK}`)).replace(/^\S+ +/, "");
      const copied = after(STACK_END, "", header, "TypeError: x");

      for (const log of [unlisted, copied]) {
        const read = failedInLog(log);

        assert.equal(walkOf(log).challenge, false);
        // The other walks keep their own reports.
        assert.equal(read.filter((f) => f.challenge).length, 7);
      }
    });

    it("refuses a recorded shape out of its place", () => {
      // A code frame before where the challenge threw, a second message
      // after the stack, and a screenshot path with no header.
      assert.equal(walkOf(after(FIRST_ERROR, "12 | await page.goto(url);"))
        .challenge, false);
      assert.equal(walkOf(after(STACK_END, "", message)).challenge, false);
      assert.equal(walkOf(after(STACK_END, "",
        "test-results/e2e/x/test-failed-1.png")).challenge, false);
    });
  });

  // Finding 1 of #656's security review: the summary holds nothing but
  // the failed list, the skipped and passed counts and the step's end,
  // and they add up to the tests Playwright said it would run.
  describe("the summary under the failed list", () => {
    // COMPOSED: run 44396830525's log without the membership failure (its
    // ✘ line, its report and its closing-list line), recounted: "9
    // failed" becomes "8 failed" and "Running 1176 tests" "Running 1175
    // tests", so the test is gone from the run, not passed in it.
    const walksOnly = (() => {
      const out = [];
      let inReport = false;

      for (const line of lines(CHALLENGED)) {
        if (line.includes("  9) [phone] › e2e/membership.spec.mjs:120:3")) {
          inReport = true;
        }
        if (inReport && line.endsWith("  9 failed")) inReport = false;
        if (inReport) continue;
        if (line.includes("e2e/membership.spec.mjs:120:3")
          && /✘| {4}\[phone\]/.test(line)) continue;
        out.push(line.replace(/ {2}9 failed$/, "  8 failed")
          .replace("Running 1176 tests", "Running 1175 tests"));
      }

      return out.join("\n");
    })();
    const read = (log) => failedInLog(log);
    const allChallenge = (log) => read(log)?.length === 8
      && read(log).every((f) => f.challenge);
    // COMPOSED: summary lines added after one of the recorded ones.
    const after = (find, ...added) => afterFirst(walksOnly, find,
      (l) => added.map((a) => `${stamp(l)}${a}`));
    const WALK_LINE = "    [desktop] › e2e/overflow.spec.mjs:105:5 › at 1440px";

    it("reads the recorded summary, recounted", () => {
      assert.ok(allChallenge(walksOnly));
    });

    it("cannot read a run with interrupted, flaky or unrun tests", () => {
      assert.equal(read(after(WALK_LINE, "  1 interrupted",
        "    [phone] › e2e/account.spec.mjs:10:3 › signs in")), null);
      assert.equal(read(after(WALK_LINE, "  1 flaky",
        "    [phone] › e2e/account.spec.mjs:10:3 › signs in")), null);
      assert.equal(read(after("  94 skipped", "  40 did not run")), null);
    });

    it("cannot read a run with errors outside a test", () => {
      for (const n of ["1 error was", "2 errors were"]) {
        assert.equal(read(after("  1073 passed",
          `  ${n} not a part of any test, see above for details`)), null, n);
      }
    });

    it("cannot read a summary that does not end the Run step", () => {
      assert.equal(read(replaceLine(walksOnly, "Process completed with exit",
        (l) => `${stamp(l)}  more output`)), null);
    });

    it("cannot read counts that do not add up to the tests run", () => {
      // The criteria tests' composed log, not recounted, and the
      // recording itself told it ran one test more or two lines.
      assert.equal(read(replaceLine(walksOnly, "Running 1175 tests",
        (l) => l.replace("1175", "1176"))), null);
      assert.equal(read(replaceLine(CHALLENGED, "Running 1176 tests",
        (l) => l.replace("1176", "1177"))), null);
      assert.equal(read(after("Running 1175 tests",
        "Running 1175 tests using 2 workers")), null);
    });
  });

  it("takes a pass only for the exact title, perhaps with a duration",
    () => {
      const passes = passesInLog(LOCAL);
      const walk = (title) => ({ spec: "e2e/overflow.spec.mjs", title });

      assert.ok(passedIn(passes, "desktop",
        walk("at 375px (#185) › every page fits")));
      // A title that only begins another's is not passed by it.
      assert.ok(!passedIn(passes, "desktop", walk("at 375px (#185) › every")));
      assert.ok(!passedIn(passes, "phone",
        walk("at 375px (#185) › every page fits")));
      assert.ok(!passedIn(passes, "desktop",
        walk("at 375px (#185) › every page fits before")));
    });
});

describe("judging a failed staging run (#654)", () => {
  // The staging API from #502's recording, made the runs of `sha`.
  const SHA = "a".repeat(40);
  const api = (runs = OLD_RUNS.runs.workflow_runs) => async (path) => {
    if (path.includes("/workflows/e2e-staging.yml/runs")) {
      return { workflow_runs: runs.map((r) => ({ ...r, head_sha: SHA })) };
    }

    const jobs = path.match(/\/actions\/runs\/(\d+)\/jobs/);

    if (jobs) return OLD_RUNS.jobs[jobs[1]];
    throw new Error(`no recording for ${path}`);
  };
  const judge = (deps) => stagingExemption({
    repo: REPO, staging: STAGING_E2E, sha: SHA, refusal: "today's refusal",
    show: async () => {
      throw new Error("no record read before the log");
    },
    ...deps,
  });

  it("refuses a failed run beside a stood-down one when its log cannot "
    + "be read", async () => {
    const [stoodDown, failed] = OLD_RUNS.runs.workflow_runs;

    await assert.rejects(judge({ api: api([stoodDown, failed]) }), {
      message: `Refused: the failed tests of run ${failed.id} cannot be `
        + "read from its log.",
    });
  });

  // Finding 2 of #656's security review: the job failed in Run and in
  // no other step.
  it("judges a job only when Run is the one step that failed", () => {
    const steps = (job) => job.jobs[0].steps;
    const recorded = [
      ...Object.values(REC.staging).map((s) => steps(s.jobs)),
      steps(OLD_RUNS.jobs[40600000002]),
    ];
    // COMPOSED: one recorded step's status or conclusion changed.
    const changed = (list, name, change) => list.map((s) => (s.name === name
      ? { ...s, ...change } : s));
    const [first] = recorded;

    for (const list of recorded) assert.ok(failedOnlyInRun(list, "Run"));
    assert.ok(!failedOnlyInRun(steps(OLD_RUNS.jobs[40600000001]), "Run"));
    assert.ok(!failedOnlyInRun(steps(OLD_RUNS.jobs[40600000003]), "Run"));
    for (const [name, change] of [
      ["Sweep the suite's leftovers", { conclusion: "failure" }],
      ["Install", { conclusion: "skipped" }],
      ["Wait for the deploy", { conclusion: "cancelled" }],
      ["Summary", { conclusion: "failure" }],
      ["Alert", { status: "in_progress", conclusion: null }],
      ["Run", { status: "in_progress", conclusion: null }],
    ]) {
      assert.ok(!failedOnlyInRun(changed(first, name, change), "Run"),
        `${name}: ${JSON.stringify(change)}`);
    }
    assert.ok(failedOnlyInRun(changed(first, "Failure screenshots",
      { conclusion: "skipped" }), "Run"));
    assert.ok(!failedOnlyInRun([...first, first[9]], "Run"));
    assert.ok(!failedOnlyInRun(undefined, "Run"));
  });

  // #656 review, round 2: the staging job is the run's one job of its
  // name, and every other job of the run succeeded or was skipped.
  it("judges a run only by its one staging job, the others green",
    () => {
      const recorded = REC.staging[44396830525].jobs.jobs;
      const [job] = recorded;
      // COMPOSED: the recorded job copied, renamed or concluded
      // otherwise, as a second job of the same run.
      const twin = { ...structuredClone(job), id: job.id + 1 };
      const other = (change) => ({
        ...structuredClone(job), id: job.id + 2, name: "lint", ...change,
      });

      assert.equal(judgedJob(recorded, STAGING_E2E), job);
      assert.equal(judgedJob(OLD_RUNS.jobs[40600000002].jobs, STAGING_E2E),
        OLD_RUNS.jobs[40600000002].jobs[0]);
      assert.equal(judgedJob([job, twin], STAGING_E2E), null);
      for (const change of [{ conclusion: "failure" },
        { conclusion: "cancelled" },
        { status: "in_progress", conclusion: null }]) {
        assert.equal(judgedJob([job, other(change)], STAGING_E2E), null,
          JSON.stringify(change));
      }
      for (const conclusion of ["success", "skipped"]) {
        assert.equal(judgedJob([job, other({ conclusion })], STAGING_E2E),
          job, conclusion);
      }
      assert.equal(judgedJob([], STAGING_E2E), null);
      assert.equal(judgedJob(undefined, STAGING_E2E), null);
    });

  it("gives today's refusal when another job of the run failed",
    async () => {
      const [, failed] = OLD_RUNS.runs.workflow_runs;
      // COMPOSED: #502's recorded job, and beside it the same job failed
      // under another name.
      const jobs = structuredClone(OLD_RUNS.jobs[failed.id]);

      jobs.jobs.push({ ...structuredClone(jobs.jobs[0]), id: 90000000009,
        name: "lint" });
      jobs.total_count = 2;

      await assert.rejects(judge({
        api: async (path) => (path.includes(`/runs/${failed.id}/jobs`)
          ? jobs : api([failed])(path)),
      }), { message: "Refused: today's refusal." });
    });

  // #656 review, after the go: one page of jobs is read, so it must be
  // all of them.
  it("gives today's refusal when the jobs read are not all the run's",
    async () => {
      const [, failed] = OLD_RUNS.runs.workflow_runs;
      const answer = (change) => async (path) => (path
        .includes(`/runs/${failed.id}/jobs`)
        ? { ...structuredClone(OLD_RUNS.jobs[failed.id]), ...change }
        : api([failed])(path));
      const unread = `Refused: the failed tests of run ${failed.id} cannot `
        + "be read from its log.";

      // As recorded (total_count 1, one job): judged, then its log.
      await assert.rejects(judge({ api: answer({}) }), { message: unread });
      // COMPOSED: the recorded answer saying the run has more jobs than
      // it holds, or not saying how many.
      for (const change of [{ total_count: 2 }, { total_count: 101 },
        { total_count: undefined }, { total_count: "1" }]) {
        await assert.rejects(judge({ api: answer(change) }),
          { message: "Refused: today's refusal." }, JSON.stringify(change));
      }
    });

  it("gives today's refusal when the sweep failed beside Run", async () => {
    const [, failed] = OLD_RUNS.runs.workflow_runs;
    // COMPOSED: #502's recorded job, its sweep made a failure.
    const job = structuredClone(OLD_RUNS.jobs[failed.id]);

    job.jobs[0].steps.find((s) => s.name === "Sweep the suite's leftovers")
      .conclusion = "failure";

    await assert.rejects(judge({
      api: async (path) => (path.includes(`/runs/${failed.id}/jobs`)
        ? job : api([failed])(path)),
    }), { message: "Refused: today's refusal." });
  });

  it("gives today's refusal when no failed run counts", async () => {
    const [stoodDown, failed] = OLD_RUNS.runs.workflow_runs;

    for (const runs of [[stoodDown], [{ ...failed, id: "../../x" }],
      [{ ...failed, event: "workflow_dispatch" }],
      [{ ...failed, head_branch: "e2e/staging" }]]) {
      await assert.rejects(judge({ api: api(runs) }),
        { message: "Refused: today's refusal." });
    }
  });

  it("refuses a record that is not JSON, and reads a commit without one "
    + "as no exemptions", async () => {
    const [, failed] = OLD_RUNS.runs.workflow_runs;
    const logged = async (path) => (path.endsWith(`/jobs/${
      OLD_RUNS.jobs[failed.id].jobs[0].id}/logs`)
      ? CHALLENGED : api([failed])(path));

    await assert.rejects(judge({ api: logged, show: async () => "{" }),
      { message: `Refused: ${EXEMPTIONS}: not valid JSON.` });
    await assert.rejects(judge({
      api: logged,
      show: async () => {
        throw new Error(`fatal: path '${EXEMPTIONS}' exists on disk, but `
          + `not in '${SHA}'`);
      },
    }), /^Error: Refused: no exemption names these failed tests of run /);
    await assert.rejects(judge({
      api: logged,
      show: async () => {
        throw new Error("fatal: bad object");
      },
    }), { message: "fatal: bad object" });
  });
});
