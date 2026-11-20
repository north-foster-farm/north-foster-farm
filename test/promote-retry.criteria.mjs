/* eslint-disable camelcase -- GitHub names its fields its way */
// Criteria tests for #693 (retry failing e2e tests automatically),
// boxes 1 to 3 of its "Done when" list, one test each, named for it:
//
//   1. `bin/nff promote main` accepts a run whose only failures passed
//      on a retry, names them as flaky, and still refuses a run with a
//      test that failed every try
//   2. it ships a run with failing tests only when each failure is
//      listed with a reason on the release pull request it reads,
//      refuses one that is not listed, and logs what it shipped past
//   3. a flaky test in a run is filed as an issue in the Next release
//      milestone, or added to its open one
//
// Box 4, the verdict of `bin/nff e2e`, is test/e2e-retry-verdict.
// criteria.mjs. Written by the e2e-cmd-tests lane from the boxes
// before anything was built. The implementer may change how a test
// runs, never what it expects (~/.claude/CLAUDE.md, "Tests and
// implementation come from different agents"). Held out of `npm test`
// by its name; turn it on with
//
//   git mv test/promote-retry.criteria.mjs test/promote-retry.test.mjs
//
// THE CONTRACT
//
// Box 1. With Playwright's retries on, a test that fails and then
// passes on a retry is flaky, and Playwright ends the run green: the
// staging run concludes `success`. Promotion judges that run as today
// (stagingSuite), and also reads the log of its `e2e-staging` job
// (`api("repos/north-foster-farm/north-foster-farm/actions/jobs/ID/
// logs")`) for Playwright's closing `  N flaky` list. Before the push
// it prints, with `out`, exactly one line per flaky test, holding the
// word "flaky" and the test's name, `SPEC › TITLE` (no project, line
// or column; once even when it was flaky in both projects), as the
// exemption lines of #654 name a test. The wording around them is the
// implementer's. The run's `html_url` is printed too, and main moves.
// A run with a test that failed every try concludes `failure`, and
// without an override (box 2) it is refused: promote rejects with an
// Error whose message starts "Refused", and nothing is pushed. No line
// calls that test flaky.
//
// Box 2. The override is written in the body of the release pull
// request promote reads (the open one into main whose head is the
// commit, with the LGTM label), under a line that is exactly
//   ## Failing tests shipped past
// one Markdown list item per failing test, up to the next heading or
// the end of the body:
//   - `SPEC › TITLE`: REASON
// the name as box 1 gives it, in backticks, and a reason that is not
// blank. A test is listed only by such an item. The failing tests are
// those of the judged run's closing `  N failed` list, each failed on
// every try. Then:
//   - every one listed: promote prints one line per test naming it
//     and its reason, moves main, and once main has moved logs one line
//     through netlify/functions/lib/log.mjs:
//       log.info({ event: "promote.override", by: "cli",
//         target: "main", before: <main's sha before>, after: <the
//         pushed sha>, stagingRun: RUN,
//         failures: [{ spec, title, reason }] })
//     with RUN as GitHub's number and failures in closing-list order;
//   - any not listed, or listed with no reason: refused, the Error's
//     message starting "Refused" and naming that test `SPEC › TITLE`;
//     nothing is pushed or logged;
//   - the override replaces neither the LGTM label nor the green
//     checks: with every test listed, a pull request without the label
//     is still refused;
//   - a dry run pushes and logs nothing.
//
// Box 3. Each flaky test of the run promote accepts is filed on
// GitHub, through `api(path, { fields })` as promote opens a pull
// request today, in the open milestone titled "Next release" (from
// `GET repos/REPO/milestones`, number 8 when recorded). When an open
// issue in that milestone already names the test, `SPEC › TITLE`, in
// its title, the run is added to it as a comment
// (`repos/REPO/issues/N/comments`, a body holding the run's
// `html_url`), and no issue is opened. Otherwise one issue is opened
// (`repos/REPO/issues`) whose title holds the name, whose milestone is
// that milestone's number, and whose body holds the run's `html_url`.
// A dry run writes nothing to GitHub.
//
// THE FAKES
//
// The staging runs are NOT YET RECORDED. No recorded run holds a flaky
// test: every workflow has passed `--retries=0` since the suite began
// (0d987f2b, 848be37e, d68af8b1), and Playwright reports "flaky" only
// with retries on. The tests read test/fixtures/github/e2e-retry.json
// and fail, saying so, until it is recorded. The recording, proposed
// to the coordinator 2026-11-20:
//
// 1. A scratch branch `scratch/retry-fixture` from next, pushed and
//    deleted after, never merged, holding two specs:
//      e2e/zz-retry-flaky.spec.mjs, one test titled
//        "fails on its first try and passes on a retry"
//        that fails while testInfo.retry is 0;
//      e2e/zz-retry-fails.spec.mjs, one test titled
//        "fails on every try".
//    Its copy of e2e-staging.yml (a scratch branch's own file runs on
//    a push to it) adds the branch to `on.push.branches`, runs only the
//    zz-retry specs with `--retries=2`, and drops the Alert step, so
//    no ping reaches James's monitor. Two pushes: the flaky spec alone
//    (a green run, `flaky`), then both (a failed run, `failed`).
// 2. Each run, its jobs and the e2e-staging job's log recorded with
//    gh, read-only, as e2e-exempt.json's `_source` lists:
//      GET repos/.../actions/runs/RUN, GET .../runs/RUN/jobs,
//      GET .../actions/jobs/JOB/logs (gh api --allow-escape-sequences)
//    into e2e-retry.json, logs byte for byte beside it:
//      { "_source": {...},
//        "staging": {
//          "flaky":  { "runs": { "total_count": 1,
//                                "workflow_runs": [RUN] },
//                      "jobs": { "total_count": 1, "jobs": [...] },
//                      "logs": { "JOB": "e2e-retry-staging-RUN.txt" } },
//          "failed": { the same } },
//        "local": { see test/e2e-retry-verdict.criteria.mjs } }
//
// Recorded 2026-11-20, read-only: e2e-flaky-issues.json, the open
// milestones, three open issues of Next release, issue #693 and a
// comment (its `_source` lists the requests). No issue was created to
// record a POST, so GET's answers stand in for POST's: GitHub returns
// the same issue and comment objects from both.
//
// COMPOSED, and only this:
//   - `atCommit()` moves a recorded scratch run and its jobs to commit
//     1471cc85 on e2e/staging-full (`head_sha`, `head_branch`), the
//     commit whose staging push, green checks and pull request
//     e2e-exempt.json and check-runs-green.json recorded for #654;
//   - box 3's open issue that names the flaky test is a recorded issue
//     of the milestone with its title changed (`naming()`).
// The pull request, its body and its LGTM timeline are hand-shaped as
// in test/promote.test.mjs's world: no real pull request held them.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { promote } from "../bin/promote.mjs";
import { shipLog } from "../bin/ship-log.mjs";
import { flush } from "../netlify/functions/lib/log.mjs";

const REPO = "north-foster-farm/north-foster-farm";
const DIR = new URL("fixtures/github/", import.meta.url);
const text = (name) => readFileSync(new URL(name, DIR), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
const EXEMPT = JSON.parse(text("e2e-exempt.json"));
const CHECKS = JSON.parse(text("check-runs-green.json")).response;
const ISSUES = JSON.parse(text("e2e-flaky-issues.json"));
const RETRY_FILE = "e2e-retry.json";

const SHA = "1471cc858676dcc3bb4cad29ccc2c6ffca34f377";
const OLD = "b".repeat(40);
const NEXT_RELEASE = 8;

const FLAKY = { spec: "e2e/zz-retry-flaky.spec.mjs",
  title: "fails on its first try and passes on a retry" };
const FAILS = { spec: "e2e/zz-retry-fails.spec.mjs",
  title: "fails on every try" };
const name = (t) => `${t.spec} › ${t.title}`;
const REASON = "fails on purpose, to record the fixture (#693)";
const HEADING = "## Failing tests shipped past";

// The recording, or a failure that says it is still to be made.
const recorded = () => {
  assert.ok(existsSync(new URL(RETRY_FILE, DIR)), "test/fixtures/github/"
    + `${RETRY_FILE} is not recorded yet: see this file's header`);

  return JSON.parse(text(RETRY_FILE)).staging;
};

// COMPOSED: a recorded scratch run and its jobs, moved to SHA on
// e2e/staging-full.
const atCommit = (run) => {
  const moved = clone(run);

  for (const r of moved.runs.workflow_runs) {
    r.head_sha = SHA;
    r.head_branch = "e2e/staging-full";
  }
  for (const j of moved.jobs.jobs) {
    j.head_sha = SHA;
    j.head_branch = "e2e/staging-full";
  }

  return moved;
};

// COMPOSED: the milestone's recorded open issues, the first renamed so
// its title names `test`.
const naming = (test) => {
  const issues = clone(ISSUES.issues);

  issues[0].title = `Flaky e2e test: ${name(test)}`;

  return issues;
};

// Git, GitHub and the audit for one promotion of SHA to main, judged
// on the staging run `staging`. `body` is the release pull request's
// body, `labeled` whether it carries LGTM, `issues` the milestone's
// open issues. Every POST is kept in `posts` as { path, fields }.
const world = (staging, {
  body = "", labeled = true, issues = ISSUES.issues,
} = {}) => {
  const heads = { next: SHA, staging: SHA, main: OLD };
  const calls = [];
  const lines = [];
  const posts = [];
  const [run] = staging.runs.workflow_runs;
  const sh = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "rev-parse") return heads[args[1].replace("origin/", "")];

    return "";
  };
  const api = async (path, { fields } = {}) => {
    if (fields) {
      posts.push({ path, fields });
      if (/\/issues\/\d+\/comments$/.test(path)) return clone(ISSUES.comment);
      if (/\/issues$/.test(path)) return clone(ISSUES.issue);
      throw new Error(`no recording for a POST to ${path}`);
    }
    if (path.includes("/actions/workflows/e2e-staging.yml/runs")) {
      return clone(staging.runs);
    }
    if (path.includes(`/actions/runs/${run.id}/jobs`)) {
      return clone(staging.jobs);
    }

    const logOf = path.match(/\/actions\/jobs\/(\d+)\/logs/);

    if (logOf && staging.logs[logOf[1]]) return text(staging.logs[logOf[1]]);
    if (path.includes("/check-runs")) return clone(CHECKS);
    if (path.includes("/activity?")) return clone(EXEMPT.activity);
    if (path.includes("/milestones")) return clone(ISSUES.milestones);
    if (/\/issues\?/.test(path) && path.includes("milestone=")) {
      return clone(issues);
    }
    // Hand-shaped, as in test/promote.test.mjs: see the header.
    if (path.includes("/pulls")) {
      return [{
        number: 7, body,
        head: { sha: SHA, ref: "staging", repo: { full_name: REPO } },
        labels: labeled ? [{ name: "LGTM" }] : [],
      }];
    }
    if (path.includes("/timeline")) {
      return labeled ? [{
        event: "labeled", label: { name: "LGTM" },
        created_at: "2026-11-18T23:00:00Z",
      }] : [];
    }

    throw new Error(`no recording for ${path}`);
  };
  const show = async (at, path, list) => {
    if (list) return ".github/workflows/ci.yml";
    if (path === "security/exceptions.json") return "[]";
    if (path.endsWith("ci.yml")) return "jobs: {}";
    if (path === "e2e/staging-exempt.json") {
      return JSON.stringify({ exemptions: [] });
    }

    return "{}";
  };
  const audit = async () => ({ vulnerabilities: {} });

  return {
    run, calls, lines, posts, out: (l) => lines.push(String(l)),
    deps: { sh, api, show, audit },
  };
};

const pushes = (calls) => calls.filter((c) => c.startsWith("push"));
const pushedMain = [`push origin ${SHA}:refs/heads/main`];

const refused = async (w, opts, check) => {
  await assert.rejects(promote("main", { out: w.out, ...opts }, w.deps),
    (error) => {
      assert.match(error.message, /^Refused/, `refused: ${error.message}`);
      check?.(error.message);

      return true;
    });
  assert.deepEqual(pushes(w.calls), [], "nothing is pushed");
};

// The lines the run left for bin/nff to ship, as shipped.
const AXIOM = { AXIOM_TOKEN: "t", AXIOM_DATASET: "nff-site" };
const shipped = async () => {
  const bodies = [];

  await shipLog({
    env: AXIOM,
    fetchImpl: async (url, init) => {
      bodies.push(init.body);

      return { ok: true, status: 200 };
    },
  });

  return bodies.flatMap((b) => JSON.parse(b))
    .map((l) => ({ ...l, ...l.data }));
};
const overrides = async () => (await shipped())
  .filter((l) => l.event === "promote.override");

const listing = (items) => ["Release notes.", "", HEADING, "",
  ...items, "", "## After", "", `- \`${name(FAILS)}\`: not this one`]
  .join("\n");

describe("bin/nff promote main and retried tests (#693 criteria)", () => {
  it("1. accepts a run whose only failures passed on a retry, names them "
    + "as flaky, and still refuses a run with a test that failed every "
    + "try", async () => {
    const { flaky, failed } = recorded();

    const green = world(atCommit(flaky));

    await promote("main", { out: green.out }, green.deps);
    const printed = green.lines.join("\n");

    assert.deepEqual(pushes(green.calls), pushedMain,
      `main moves:\n${printed}`);
    assert.ok(printed.includes(green.run.html_url),
      `the run's URL:\n${printed}`);
    const named = green.lines.filter((l) => l.includes(name(FLAKY)));

    assert.equal(named.length, 1,
      `one line names ${name(FLAKY)}:\n${printed}`);
    assert.match(named[0], /flaky/i, "and calls it flaky");

    const red = world(atCommit(failed));

    await refused(red);
    for (const line of red.lines) {
      assert.ok(!(line.includes(name(FAILS)) && /flaky/i.test(line)),
        `a test that failed every try is not flaky: ${line}`);
    }
  });

  it("2. ships a run with failing tests only when each failure is listed "
    + "with a reason on the release pull request it reads, refuses one "
    + "that is not listed, and logs what it shipped past", async () => {
    const { failed } = recorded();
    const run = atCommit(failed);
    const runId = run.runs.workflow_runs[0].id;
    const listed = listing([`- \`${name(FAILS)}\`: ${REASON}`]);

    // Not listed: no heading, then the test only past the section.
    await flush({ env: {} });
    for (const [why, body] of [
      ["no list", "Release notes."],
      ["listed only after the section", listing([])],
      ["listed with no reason", listing([`- \`${name(FAILS)}\`:  `])],
    ]) {
      await refused(world(run, { body }), {}, (message) => {
        assert.ok(message.includes(name(FAILS)),
          `${why}: names the test: ${message}`);
      });
    }
    // Listed, but the pull request has no LGTM: still refused.
    await refused(world(run, { body: listed, labeled: false }));
    // Listed, as a dry run: nothing pushed.
    const dry = world(run, { body: listed });

    await promote("main", { dryRun: true, out: dry.out }, dry.deps);
    assert.deepEqual(pushes(dry.calls), [], "a dry run pushes nothing");
    assert.deepEqual(await overrides(), [],
      "no refusal and no dry run logs an override");

    // Listed: shipped, named with its reason, logged.
    const w = world(run, { body: listed });

    await promote("main", { out: w.out }, w.deps);
    const printed = w.lines.join("\n");

    assert.deepEqual(pushes(w.calls), pushedMain, `main moves:\n${printed}`);
    assert.ok(w.lines.some((l) => l.includes(name(FAILS))
      && l.includes(REASON)), `a line names the test and its reason:\n${
      printed}`);
    const logged = await overrides();

    assert.equal(logged.length, 1, "one override line");
    const [l] = logged;

    assert.equal(l.by, "cli");
    assert.equal(l.target, "main");
    assert.equal(l.before, OLD);
    assert.equal(l.after, SHA);
    assert.equal(l.stagingRun, runId);
    assert.deepEqual(l.failures, [{ ...FAILS, reason: REASON }]);
  });

  it("3. files a flaky test in a run as an issue in the Next release "
    + "milestone, or adds it to its open one", async () => {
    const { flaky } = recorded();
    const run = atCommit(flaky);
    const url = run.runs.workflow_runs[0].html_url;

    // None open names it: one issue opened.
    const fresh = world(run);

    await promote("main", { out: fresh.out }, fresh.deps);
    const opened = fresh.posts.filter((p) => /\/issues$/.test(p.path));

    assert.equal(fresh.posts.length, 1, `one write:\n${
      JSON.stringify(fresh.posts, null, 2)}`);
    assert.equal(opened.length, 1, "an issue is opened");
    assert.equal(opened[0].path, `repos/${REPO}/issues`);
    assert.ok(String(opened[0].fields.title).includes(name(FLAKY)),
      `its title names the test: ${opened[0].fields.title}`);
    assert.equal(Number(opened[0].fields.milestone), NEXT_RELEASE,
      "in Next release");
    assert.ok(String(opened[0].fields.body).includes(url),
      "its body links the run");

    // One open names it: the run added to it, no issue opened.
    const known = naming(FLAKY);
    const again = world(run, { issues: known });

    await promote("main", { out: again.out }, again.deps);
    assert.deepEqual(again.posts.map((p) => p.path),
      [`repos/${REPO}/issues/${known[0].number}/comments`],
      "one comment on the open issue, no new issue");
    assert.ok(String(again.posts[0].fields.body).includes(url),
      "the comment links the run");

    // A dry run writes nothing.
    const dry = world(run);

    await promote("main", { dryRun: true, out: dry.out }, dry.deps);
    assert.deepEqual(dry.posts, [], "a dry run files nothing");
  });
});
