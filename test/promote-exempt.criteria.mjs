/* eslint-disable camelcase -- GitHub names its fields its way */
// Criteria tests for #654: a recorded exemption that lets `bin/nff
// promote main` accept a full staging run whose only failures are
// Netlify's bot challenge on named tests that passed against a local
// build on the same commit. Written by the exempt-tests lane from the
// issue's "Done when" list before anything was built; one test per box,
// named for it. Held out of `npm test` by its name. To turn it on:
//
//   git mv test/promote-exempt.criteria.mjs test/promote-exempt.test.mjs
//
// THE CONTRACT
//
// The record. `e2e/staging-exempt.json`, committed, exported from
// bin/promote.mjs as `EXEMPTIONS` (that path, as a string). It always
// exists, with an empty list when nothing is exempt:
//
//   { "exemptions": [
//     { "spec": "e2e/overflow.spec.mjs",
//       "title": "at 375px (#185) › every page fits",
//       "reason": "…", "date": "2026-11-18", "approver": "James" } ] }
//
// `spec` is the spec file as Playwright prints it; `title` is the rest
// of the test's name as Playwright's list reporter prints it after
// `spec:line:col › `: describe titles and the test title joined by
// " › ", no project, no line or column. An entry names a test in every
// project. Promotion reads the record from the commit under test
// (`show(tested, EXEMPTIONS)`), never the working tree; a commit
// without the file has no exemptions.
//
// `exemptionProblems(record)`, exported, -> an array of strings, empty
// when the record is good. A record with no `exemptions` array gives
// `e2e/staging-exempt.json: no exemptions list`. Each entry missing
// a field gives `e2e/staging-exempt.json entry N: no FIELD`, N counting
// from 1, FIELD in the order spec, title, reason, date, approver, one
// string per missing field. Missing means absent, not a string, or
// blank after trimming; a date is missing too unless it is a real
// calendar date written YYYY-MM-DD.
//
// Which staging run is judged. Unchanged when a green full run counts
// (stagingSuite today): the record is then not read. Otherwise the
// judged run is the newest run of e2e-staging.yml for the commit that
// is on `e2e/staging-full`, by `push`, `completed` with conclusion
// `failure`, whose job `e2e-staging` has its step `Run` concluded
// `failure`. With none, today's refusal stands ("the full e2e suite
// has not passed against staging on SHA. Push it to …").
//
// What failed in it, and why, from the log of its `e2e-staging` job:
// `api("repos/north-foster-farm/north-foster-farm/actions/jobs/ID/logs")`
// resolves to the log's text, as `gh api --allow-escape-sequences`
// prints it. Read each line without its leading timestamp and space,
// with escape sequences removed (`printable()` in bin/e2e/dispatch.mjs
// does this). The failed tests are Playwright's closing list: the line
// `  N failed` and the N lines after it, each
// `[PROJECT] › SPEC:LINE:COL › TITLE`, with any trailing run of `─`
// and spaces dropped. When there is no such list, or it holds other
// than N tests, the failed tests cannot be read. Each failed test's
// reason is the first non-blank line after its numbered report header
// `K) [PROJECT] › SPEC:LINE:COL › TITLE`. A failure is the bot
// challenge when that line, trimmed, matches
//   /^Error: .*: \d{3} from Netlify's bot challenge, not the site
//    \(staging's bot protection; e2e\/support\/challenge\.mjs\)$/
// (one line; the message `challengeError()` in e2e/support/
// challenge.mjs throws).
//
// The local-build pass. `api("repos/north-foster-farm/north-foster-
// farm/actions/workflows/e2e.yml/runs?head_sha=SHA&per_page=100")`. A
// run counts only when its own `head_sha` is the commit under test,
// `status` is `completed` and `conclusion` is `success`. For each, its
// jobs (`…/actions/runs/ID/jobs?per_page=100`); from each job whose
// name ends in `shard N` and whose conclusion is `success`, its log
// (`…/actions/jobs/ID/logs`), read as above. A test passed in a project
// when a line matches `✓ <number> [PROJECT] › SPEC:LINE:COL › TITLE`,
// optionally followed by ` (DURATION)`. An exempt test needs a pass in
// every project it failed in on staging; the run named is the newest
// counted run that has them all. Fetch no other job's log.
//
// The verdict, checks in this order, the first that fails refusing.
// Each refusal is an Error whose message is exactly the line shown,
// and nothing is pushed. A test is named `SPEC › TITLE`, once even
// when it failed in two projects, in the order of the closing list,
// and a list of them is joined by "; ".
//
//   1. the log is unreadable:
//      Refused: the failed tests of run RUN cannot be read from its log.
//   2. the record has a problem: Refused: PROBLEM. (the first one)
//   3. a failed test no entry names:
//      Refused: no exemption names these failed tests of run RUN: LIST.
//   4. a named test whose failure is not the challenge:
//      Refused: these tests of run RUN failed with something other
//      than Netlify's bot challenge: LIST.
//   5. a named test with no local pass:
//      Refused: these exempt tests have no pass in a green e2e.yml run
//      on SHA: LIST.
//
// (4 and 5 are one line each; they are wrapped here.)
//
// Accepted, it prints with `out`, before the push: one line per
// exempt test, in closing-list order,
//   exemption used: SPEC › TITLE: Netlify's bot challenge in staging
//   run RUN, passed in e2e.yml run LOCAL
// (one line) and then
//   full e2e failed on staging at SHA only on exempt tests: HTML_URL
// with HTML_URL the judged run's `html_url`, in place of today's
// "full e2e passed on staging at …" line. Then, unless it is a dry
// run, it logs one line through netlify/functions/lib/log.mjs (which
// bin/nff ships at the end of the run), and pushes:
//   log.info({ event: "promote.exemptions", by: "cli", target: "main",
//     before: <main's sha before the push>, after: <the pushed sha>,
//     stagingRun: RUN, exemptions: [{ spec, title, localRun }] })
// with run ids as GitHub's numbers. A refusal or a dry run logs no
// such line.
//
// THE FAKES
//
// GitHub's answers come from test/fixtures/github/e2e-exempt.json and
// the logs beside it, recorded on 2026-11-18 (its `_source` lists every
// request), and check-runs-green.json (#612's recording). The staging
// runs: 44396830525 on 1471cc85 (9 failures: the 8 overflow walks with
// the challenge message, 1 membership test that was not), 44379156341
// on 7479ca14 (8 failures, mixed, before the message existed). The
// e2e.yml runs: 44260592026 on 9b7353fa, green, which walked
// e2e/overflow.spec.mjs; 44395502115 on 1471cc85, green, which did
// not; 44273965134 on 3982a6c7, failed, whose overflow walks passed.
//
// No real run shows a challenge failure and a local pass on the same
// commit, so two are composed, and said so where used:
//   - `onlyChallenges()` removes the membership test from run
//     44396830525's log (its ✘ line, its report and its closing-list
//     line) and makes "9 failed" "8 failed". Every other line is the
//     recording's.
//   - `atCommit()` sets `head_sha` on an e2e.yml run and its jobs to
//     another commit. Nothing else changes.
// The pull request and its LGTM timeline are hand-shaped as in
// test/promote.test.mjs's world: no real pull request ever held this
// state to record. The rest is recorded.
//
// RECORDED CHECKS (not tests; the coordinator checks them)
//
// Box 8. docs/cloud-lanes.md, "Promoting to staging and e2e", point 7,
// states the exemption: a failed full run is accepted only when every
// failed test is named in e2e/staging-exempt.json, with a reason, a
// date and an approver, an entry James approves in the pull request
// that adds it; failed in that run with Netlify's bot-challenge
// message; and passed in an e2e.yml run on the same commit. It says
// that promote prints each exemption with both runs and logs the
// promotion. `grep -rn 'staging-exempt' --include='*.md' .` (outside
// node_modules) finds point 7 and nothing that restates the three
// conditions elsewhere; a bare link to point 7 is fine.
//
// Box 7 also covers fakes this file does not hold: any GitHub fake
// the implementer adds returns a recording, with its source and date.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as promoteModule from "../bin/promote.mjs";
import { shipLog } from "../bin/ship-log.mjs";
import { flush } from "../netlify/functions/lib/log.mjs";

// Not destructured in the import, so a name not yet exported fails the
// tests that need it, not the whole file.
const { EXEMPTIONS, exemptionProblems, promote } = promoteModule;

const REPO = "north-foster-farm/north-foster-farm";
const RECORD_PATH = "e2e/staging-exempt.json";
const DIR = new URL("fixtures/github/", import.meta.url);
const text = (name) => readFileSync(new URL(name, DIR), "utf8");
const REC = JSON.parse(text("e2e-exempt.json"));
const CHECKS = JSON.parse(text("check-runs-green.json")).response;
const clone = (value) => JSON.parse(JSON.stringify(value));

// The two full staging runs and their commits.
const CHALLENGED = "44396830525";
const MIXED = "44379156341";
const SHA = REC.staging[CHALLENGED].sha;
const MIXED_SHA = REC.staging[MIXED].sha;
const OLD = "b".repeat(40);

// The commits of the recorded e2e.yml runs.
const WALKED = "9b7353fa6d7795d36ce26c3cc1a65150d6829282";
const LOCAL_RUN = 44260592026;
const NOT_WALKED = SHA;
const FAILED_LOCAL = "3982a6c77e9e5acaccbed975d655047c68da4346";

const name = (t) => `${t.spec} › ${t.title}`;
const OVERFLOW = [375, 768, 992, 1440].flatMap((width) => [
  "every page fits", "every page fits before its images load",
].map((walk) => ({
  spec: "e2e/overflow.spec.mjs", title: `at ${width}px (#185) › ${walk}`,
})));
const MEMBERSHIP = {
  spec: "e2e/membership.spec.mjs",
  title: "the rebuilt Membership tab (#602) › shows each round as two lines",
};
// Run 44379156341's closing list, in its order.
const MIXED_FAILED = [
  ["e2e/buttons.spec.mjs",
    "button states › a hovered button lifts; a tabbed one shows its ring"],
  ["e2e/news-hide.spec.mjs",
    "a hidden form leaves no gap, a shown one does not move"],
  ["e2e/order-scheduled.spec.mjs", "a lapsed scheduled pickup › a lapsed "
    + "onfarm way offers \"Choose a pickup day or delivery instead\""],
  ["e2e/overflow.spec.mjs",
    "at 768px (#185) › every page fits before its images load"],
  ["e2e/stock-failure.spec.mjs", "stock that cannot be checked › opens by "
    + "itself when stock answers, with no reload"],
  ["e2e/wallets.spec.mjs", "the wallet buttons render (#457) › Google "
    + "Pay's button shows the form's errors instead of a sheet"],
  ["e2e/wording.spec.mjs",
    "no retired words (#150) › /privacy/ reads without them"],
  ["e2e/account-tabs.spec.mjs", "the account's tab row › the start's "
    + "arrow brings the tab cut off there into view"],
].map(([spec, title]) => ({ spec, title }));

// A complete entry, for these tests only: no real entry is written
// here (James approves those, #654).
const entry = (t) => ({
  ...t, reason: "Netlify's bot challenge answers the walk on staging",
  date: "2026-11-18", approver: "James",
});
const recordOf = (tests) => ({ exemptions: tests.map(entry) });

const stagingLog = (run) => text(Object.values(REC.staging[run].logs)[0]);

// COMPOSED: run 44396830525's log without the one failure that was not
// the challenge, so its failures are the eight walks alone.
const onlyChallenges = (log) => {
  const out = [];
  let inReport = false;

  for (const line of log.split("\n")) {
    const bare = line.replace(/^\S+ /, "");

    if (/^ {2}9\) \[phone\] › e2e\/membership\.spec\.mjs:120:3 /
      .test(bare)) inReport = true;
    if (inReport && /^ {2}9 failed$/.test(bare)) inReport = false;
    if (inReport) continue;
    if (bare.includes("e2e/membership.spec.mjs:120:3")
      && /✘|^ {4}\[phone\]/.test(bare)) continue;
    out.push(/^\S+ {3}9 failed$/.test(line)
      ? line.replace("9 failed", "8 failed") : line);
  }

  return out.join("\n");
};

// COMPOSED: a recorded e2e.yml answer, moved to another commit.
const atCommit = (local, sha) => {
  const moved = clone(local);

  for (const r of moved.runs.workflow_runs) r.head_sha = sha;
  for (const jobs of Object.values(moved.jobs)) {
    for (const j of jobs.jobs) j.head_sha = sha;
  }

  return moved;
};

// Git, GitHub and the audit for one promotion of `sha` to main.
// `staging` picks the recorded staging run, `log` overrides its job's
// log, `local` is the e2e.yml answer (a recorded one, or composed),
// `record` the committed record (undefined: no such file).
const world = ({
  sha = SHA, staging = CHALLENGED, log, local = REC.local[WALKED], record,
} = {}) => {
  const heads = { next: sha, staging: sha, main: OLD };
  const calls = [];
  const lines = [];
  const stagingJobs = REC.staging[staging].jobs;
  const stagingJob = Object.keys(REC.staging[staging].logs)[0];
  const sh = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "rev-parse") return heads[args[1].replace("origin/", "")];

    return "";
  };
  const api = async (path, { fields } = {}) => {
    if (fields) throw new Error(`no recording for a POST to ${path}`);
    if (path.includes("/actions/workflows/e2e-staging.yml/runs")) {
      return clone(REC.staging[staging].runs);
    }
    if (path.includes("/actions/workflows/e2e.yml/runs")) {
      return clone(local.runs);
    }

    const jobsOf = path.match(/\/actions\/runs\/(\d+)\/jobs/);

    if (jobsOf && jobsOf[1] === staging) return clone(stagingJobs);
    if (jobsOf && local.jobs[jobsOf[1]]) return clone(local.jobs[jobsOf[1]]);

    const logOf = path.match(/\/actions\/jobs\/(\d+)\/logs/);

    if (logOf && logOf[1] === stagingJob) return log ?? stagingLog(staging);
    if (logOf && local.logs[logOf[1]]) return text(local.logs[logOf[1]]);
    if (path.includes("/check-runs")) return clone(CHECKS);
    if (path.includes("/activity?")) return clone(REC.activity);
    // Hand-shaped, as in test/promote.test.mjs: see the header.
    if (path.includes("/pulls")) {
      return [{
        number: 7, head: { sha, ref: "staging", repo: { full_name: REPO } },
        labels: [{ name: "LGTM" }],
      }];
    }
    if (path.includes("/timeline")) {
      return [{
        event: "labeled", label: { name: "LGTM" },
        created_at: "2026-11-18T23:00:00Z",
      }];
    }

    throw new Error(`no recording for ${path}`);
  };
  const show = async (at, path, list) => {
    if (list) return ".github/workflows/ci.yml";
    if (path === "security/exceptions.json") return "[]";
    if (path.endsWith("ci.yml")) return "jobs: {}";
    if (path === RECORD_PATH) {
      if (at !== sha || record === undefined) {
        throw new Error(`fatal: path '${path}' does not exist in '${at}'`);
      }

      return typeof record === "string" ? record : JSON.stringify(record);
    }

    return "{}";
  };
  const audit = async () => ({ vulnerabilities: {} });

  return {
    calls, lines, out: (l) => lines.push(l),
    deps: { sh, api, show, audit },
  };
};

const pushes = (calls) => calls.filter((c) => c.startsWith("push"));

// The accepted case of box 2.
const accepted = () => world({
  log: onlyChallenges(stagingLog(CHALLENGED)),
  local: atCommit(REC.local[WALKED], SHA),
  record: recordOf(OVERFLOW),
});

const refuses = async (w, message) => {
  await assert.rejects(promote("main", { out: w.out }, w.deps),
    (error) => {
      assert.equal(error.message, message);

      return true;
    });
  assert.deepEqual(pushes(w.calls), []);
};

const notNamed = (run, tests) => "Refused: no exemption names these failed "
  + `tests of run ${run}: ${tests.map(name).join("; ")}.`;
const notChallenge = (run, tests) => `Refused: these tests of run ${run} `
  + "failed with something other than Netlify's bot challenge: "
  + `${tests.map(name).join("; ")}.`;
const noLocalPass = (sha, tests) => "Refused: these exempt tests have no "
  + `pass in a green e2e.yml run on ${sha}: ${tests.map(name).join("; ")}.`;

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

describe("bin/nff promote main and the staging exemption (#654)", () => {
  it("box 1: refuses a failed full staging run when no record names "
    + "its failed tests", async () => {
    const all = [...OVERFLOW, MEMBERSHIP];

    // No record at that commit, and an empty one.
    await refuses(world(), notNamed(CHALLENGED, all));
    await refuses(world({ record: { exemptions: [] } }),
      notNamed(CHALLENGED, all));
    // A failure the log does not name is one no record names. COMPOSED:
    // the staging job's log is another real run's that names none.
    await refuses(world({
      record: recordOf(all),
      log: text(REC.local[NOT_WALKED].logs[
        Object.keys(REC.local[NOT_WALKED].logs)[0]]),
    }), `Refused: the failed tests of run ${CHALLENGED} cannot be read `
      + "from its log.");
  });

  it("box 2: accepts a failed run when every failed test is named, "
    + "failed with the challenge and passed in e2e.yml on the same "
    + "commit, printing each exemption and both runs", async () => {
    const w = accepted();

    await promote("main", { out: w.out }, w.deps);

    assert.deepEqual(pushes(w.calls), [`push origin ${SHA}:refs/heads/main`]);
    assert.deepEqual(w.lines.filter((l) => l.startsWith("exemption used:")),
      OVERFLOW.map((t) => `exemption used: ${name(t)}: Netlify's bot `
        + `challenge in staging run ${CHALLENGED}, passed in e2e.yml run `
        + `${LOCAL_RUN}`));
    assert.ok(w.lines.includes(`full e2e failed on staging at ${SHA} only `
      + "on exempt tests: https://github.com/north-foster-farm/"
      + `north-foster-farm/actions/runs/${CHALLENGED}`), w.lines.join("\n"));
  });

  it("box 3: refuses when one failed test is not in the record, although "
    + "the others are", async () => {
    await refuses(world({
      local: atCommit(REC.local[WALKED], SHA), record: recordOf(OVERFLOW),
    }), notNamed(CHALLENGED, [MEMBERSHIP]));
  });

  it("box 4: refuses when a named test failed for a reason other than "
    + "the bot challenge", async () => {
    // The membership test failed on an assertion; the walks on the
    // challenge.
    await refuses(world({
      local: atCommit(REC.local[WALKED], SHA),
      record: recordOf([...OVERFLOW, MEMBERSHIP]),
    }), notChallenge(CHALLENGED, [MEMBERSHIP]));
    // Before the message existed: the walk at 768px met the challenge
    // page itself, unnamed, and seven others failed otherwise.
    await refuses(world({
      sha: MIXED_SHA, staging: MIXED,
      local: atCommit(REC.local[WALKED], MIXED_SHA),
      record: recordOf(MIXED_FAILED),
    }), notChallenge(MIXED, MIXED_FAILED));
  });

  it("box 5: refuses when the local-build pass is missing, failed or on "
    + "another commit", async () => {
    const challenged = onlyChallenges(stagingLog(CHALLENGED));
    const record = recordOf(OVERFLOW);
    const refused = noLocalPass(SHA, OVERFLOW);

    // Missing: the one green e2e.yml run on this commit (44395502115)
    // ran other specs. Recorded as is.
    await refuses(world({
      log: challenged, record, local: REC.local[NOT_WALKED],
    }), refused);
    // Failed: run 44273965134 failed, though its walks passed.
    // COMPOSED: moved to this commit.
    await refuses(world({
      log: challenged, record, local: atCommit(REC.local[FAILED_LOCAL], SHA),
    }), refused);
    // Another commit: run 44260592026 passed the walks on 9b7353fa.
    // Recorded as is.
    await refuses(world({
      log: challenged, record, local: REC.local[WALKED],
    }), refused);
  });

  it("box 6: refuses an entry without a reason, a date or an approver, "
    + "in npm test and in the command", async () => {
    assert.equal(EXEMPTIONS, RECORD_PATH);

    const [walk] = OVERFLOW;
    const without = (field, value) => {
      const e = entry(walk);

      if (value === undefined) delete e[field];
      else e[field] = value;

      return { exemptions: [e] };
    };

    assert.deepEqual(exemptionProblems(recordOf(OVERFLOW)), []);
    assert.deepEqual(exemptionProblems({}),
      [`${RECORD_PATH}: no exemptions list`]);
    for (const field of ["reason", "date", "approver"]) {
      for (const value of [undefined, "", "  ", 7]) {
        assert.deepEqual(exemptionProblems(without(field, value)),
          [`${RECORD_PATH} entry 1: no ${field}`], `${field}: ${value}`);
      }
    }
    for (const date of ["18 Nov 2026", "2026-11-31", "2026-13-01"]) {
      assert.deepEqual(exemptionProblems(without("date", date)),
        [`${RECORD_PATH} entry 1: no date`], date);
    }
    assert.deepEqual(exemptionProblems({
      exemptions: [entry(walk), { spec: walk.spec, title: walk.title }],
    }), ["reason", "date", "approver"]
      .map((f) => `${RECORD_PATH} entry 2: no ${f}`));

    // In npm test: the committed record holds no such entry.
    const committed = JSON.parse(readFileSync(
      new URL(`../${RECORD_PATH}`, import.meta.url), "utf8"));

    assert.deepEqual(exemptionProblems(committed), []);

    // The command: the third entry has no reason.
    const record = recordOf(OVERFLOW);

    delete record.exemptions[2].reason;
    await refuses(world({
      log: onlyChallenges(stagingLog(CHALLENGED)),
      local: atCommit(REC.local[WALKED], SHA), record,
    }), `Refused: ${RECORD_PATH} entry 3: no reason.`);
  });

  it("box 7: every GitHub answer comes from a recorded request",
    () => {
      const source = REC._source;

      assert.equal(source.recorded, "2026-11-18");
      for (const [run, s] of Object.entries(REC.staging)) {
        const listed = s.runs.workflow_runs.find((r) => String(r.id) === run);

        assert.equal(listed.head_sha, s.sha);
        assert.ok(source.requests.some((q) => q.includes(
          "workflows/e2e-staging.yml/runs?branch=e2e/staging-full"
          + `&head_sha=${s.sha}`)));
        assert.ok(source.requests.some((q) => q.includes(`runs/${run}/jobs`)));
        for (const [job, file] of Object.entries(s.logs)) {
          assert.ok(s.jobs.jobs.some((j) => String(j.id) === job));
          assert.ok(source.requests
            .some((q) => q.includes(`jobs/${job}/logs`)));
          assert.ok(text(file).length > 0);
        }
      }
      for (const [sha, l] of Object.entries(REC.local)) {
        assert.ok(source.requests.some((q) => q.includes(
          `workflows/e2e.yml/runs?head_sha=${sha}`)));
        for (const r of l.runs.workflow_runs) assert.equal(r.head_sha, sha);
        for (const [job, file] of Object.entries(l.logs)) {
          // The failed run's log is #623's recording of the same job.
          assert.ok(file === "e2e-verdict-escapes.txt"
            || source.requests.some((q) => q.includes(`jobs/${job}/logs`)));
          assert.ok(text(file).length > 0);
        }
      }
      assert.ok(source.requests.some((q) => q.includes(
        "activity?ref=refs/heads/staging")));
      assert.match(JSON.parse(text("check-runs-green.json"))._source,
        /^RECORDED from GitHub on 2026-11-18/);

      // The composed log only drops recorded lines and recounts.
      const recorded = new Set(stagingLog(CHALLENGED).split("\n"));
      const changed = onlyChallenges(stagingLog(CHALLENGED)).split("\n")
        .filter((l) => !recorded.has(l));

      assert.equal(changed.length, 1);
      assert.match(changed[0], /^\S+ {3}8 failed$/);
    });

  it("box 9: a promotion that uses an exemption is logged: who, what, "
    + "the runs", async () => {
    await flush({ env: {} });

    const w = accepted();

    await promote("main", { out: w.out }, w.deps);

    const lines = (await shipped())
      .filter((l) => l.event === "promote.exemptions");

    assert.equal(lines.length, 1);

    const [l] = lines;

    assert.equal(l.by, "cli");
    assert.equal(l.target, "main");
    assert.equal(l.before, OLD);
    assert.equal(l.after, SHA);
    assert.equal(l.stagingRun, Number(CHALLENGED));
    assert.deepEqual(l.exemptions,
      OVERFLOW.map((t) => ({ ...t, localRun: LOCAL_RUN })));

    // A refusal and a dry run log none.
    await flush({ env: {} });
    await assert.rejects(promote("main", { out: () => {} }, world({
      local: atCommit(REC.local[WALKED], SHA), record: recordOf(OVERFLOW),
    }).deps));

    const dry = accepted();

    await promote("main", { dryRun: true, out: dry.out }, dry.deps);
    assert.deepEqual(pushes(dry.calls), []);
    assert.deepEqual((await shipped())
      .filter((x) => x.event === "promote.exemptions"), []);
  });
});
