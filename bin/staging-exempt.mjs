// The recorded staging exemption (#654, James, 2026-11-18): when no
// green full run counts, `bin/nff promote main` may still accept a full
// staging run that failed, but only when every failed test in it is
// exempt. A test is exempt when all three hold:
//
//   - an entry in e2e/staging-exempt.json at the commit under test names
//     it (spec and title), with a reason, a date and an approver;
//   - its failure in that run is Netlify's bot challenge, the message
//     challengeError() in e2e/support/challenge.mjs throws, and nothing
//     else;
//   - it passed, in every project it failed in, in a green e2e.yml run
//     (a local build in Actions) on the same commit.
//
// Everything GitHub, the log or the record holds is untrusted text. It
// is compared as whole strings, never evaluated, never built into a
// regular expression, and reaches the terminal only through
// printable(). Ids go into API paths only when they are integers. Any
// doubt refuses: a log that cannot be read, a test with no report or
// two, an attempt that failed otherwise.

import { printable } from "./e2e/dispatch.mjs";

export const EXEMPTIONS = "e2e/staging-exempt.json";

const FIELDS = ["spec", "title", "reason", "date", "approver"];

// The one line challengeError() throws, as the report prints it.
const CHALLENGE = new RegExp("^Error: .*: \\d{3} from Netlify's bot "
  + "challenge, not the site \\(staging's bot protection; "
  + "e2e/support/challenge\\.mjs\\)$");

const LOCAL_WORKFLOW = "e2e.yml";

const filled = (value) => typeof value === "string" && value.trim() !== "";

// A real calendar date written YYYY-MM-DD.
const calendarDate = (value) => {
  if (typeof value !== "string") return false;

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!m) return false;

  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));

  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

// What is wrong with a record, one string per problem; empty when good.
export const exemptionProblems = (record) => {
  if (!record || typeof record !== "object"
    || !Array.isArray(record.exemptions)) {
    return [`${EXEMPTIONS}: no exemptions list`];
  }

  return record.exemptions.flatMap((entry, i) => {
    const e = entry && typeof entry === "object" ? entry : {};

    return FIELDS.filter((field) => (field === "date"
      ? !calendarDate(e.date) : !filled(e[field])))
      .map((field) => `${EXEMPTIONS} entry ${i + 1}: no ${field}`);
  });
};

// A log line as a person reads it: no timestamp, no escape sequences.
const bare = (line) => printable(String(line)
  .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ""));

// Playwright's `[PROJECT] › SPEC:LINE:COL › TITLE`, with the rule of `─`
// it pads some lines with dropped.
const TEST = /^\[([^\]]+)\] › ([^\s:]+):(\d+):(\d+) › (.+)$/;
const tail = (text) => text.replace(/[─ ]+$/u, "");
const testOf = (text) => {
  const m = TEST.exec(tail(text.trimStart()));

  return m ? { text: m[0], project: m[1], spec: m[2], title: m[5] } : null;
};

const REPORT = /^\d+\) /;

const key = (spec, title) => JSON.stringify([spec, title]);
const named = (t) => `${t.spec} › ${t.title}`;

// A challenge report, line by line (trimmed, blank lines aside), as
// every one in the recorded staging runs of 2026-11-18 reads: the
// message; where challengeError() threw and its code frame; the stack,
// under /__w/ (the runner's checkout); then any screenshots, each a
// header, its path and a rule; then the error context. A state names
// what was read last, and each takes only the lines that may follow it.
// Nothing else is accounted for, so anything else (a second error of
// any name, a timeout, a teardown, an interruption, a retry, output)
// makes the failure not the challenge alone. A positive rule, not a
// list of bad words (#654, security review of #656).
const SHAPES = {
  message: (l) => CHALLENGE.test(l),
  location: (l) => /^at support\/challenge\.mjs:\d+$/.test(l),
  code: (l) => /^(?:> )?\d+ \|(?: .*)?$/.test(l) || /^\| *\^$/.test(l),
  stack: (l) => /^at [\w.$]+ \(\/__w\/[^()\s]+:\d+:\d+\)$/.test(l)
    || /^at \/__w\/[^()\s]+:\d+:\d+$/.test(l),
  attachment: (l) => /^attachment #\d+: screenshot \(image\/png\)[─ ]*$/u
    .test(l),
  path: (l) => /^test-results\/\S+\.png$/.test(l),
  rule: (l) => /^─+$/u.test(l),
  context: (l) => /^Error Context: test-results\/\S+\/error-context\.md$/
    .test(l),
};
const NEXT = {
  start: ["message"],
  message: ["location", "stack"],
  location: ["code", "stack"],
  code: ["code", "stack"],
  stack: ["stack", "attachment", "context"],
  attachment: ["path"],
  path: ["rule"],
  rule: ["attachment", "context"],
  context: [],
};
const ENDS = new Set(["message", "location", "code", "stack", "rule",
  "context"]);

// The test a numbered report header names (`K) [PROJECT] › …`), as its
// closing-list line reads, or null for any other line.
const headerOf = (line) => {
  const trimmed = line.trimStart();

  return REPORT.test(trimmed) ? tail(trimmed.replace(REPORT, "")) : null;
};

// Whether one failure is the challenge and only that: its report is
// found exactly once, before the closing list, and reads as SHAPES
// allows from its first line to its last. A report ends only at the
// header of a test in the closing list (`listed`, their texts): a line
// shaped like a header that names no listed test is one more line of
// the report, and so refuses it (#656 review, round 2).
const onlyChallenge = (lines, closing, failure, listed) => {
  const headers = [];

  for (let i = 0; i < closing; i += 1) {
    if (headerOf(lines[i]) === failure.text) headers.push(i);
  }
  if (headers.length !== 1) return false;

  let state = "start";

  for (let i = headers[0] + 1; i < closing; i += 1) {
    const line = lines[i].trim();

    if (listed.has(headerOf(line))) break;
    if (line !== "") {
      const next = NEXT[state].find((shape) => SHAPES[shape](line));

      if (!next) return false;
      state = next;
    }
  }

  return ENDS.has(state);
};

// Playwright's summary, as the recorded staging runs print it: the
// closing list, then perhaps `N skipped`, then perhaps `N passed (D)`,
// then the Run step's end. Any other line there (interrupted, flaky,
// did not run, errors outside a test) cannot be read as exempt.
const CLOSING = /^ {2}(\d+) failed$/;
const SKIPPED = /^ {2}(\d+) skipped$/;
const PASSED = /^ {2}(\d+) passed \(\d+(?:\.\d+)?(?:ms|s|m|h|d)\)$/;
const EXITED = /^##\[error\]Process completed with exit code [1-9]\d*\.$/;
const RUNNING = new RegExp("^Running (\\d+) tests? using \\d+ workers?"
  + "(?:, shard \\d+ of \\d+)?$");

const counted = (pattern, line) => {
  const m = pattern.exec(line ?? "");

  return m ? Number(m[1]) : null;
};

// The failed tests of a staging job's log, from Playwright's closing
// list, each with whether its failure was the challenge alone. -> an
// array of { project, spec, title, challenge }, or null when the list
// cannot be read: none, two, a count of nothing, a count that is not
// the number of tests under it, a summary line other than skipped and
// passed, or failed, skipped and passed that do not add up to the one
// `Running N tests` line.
export const failedInLog = (log) => {
  if (typeof log !== "string") return null;

  const lines = log.split("\n").map(bare);
  const closings = lines.flatMap((l, i) => (CLOSING.test(l) ? [i] : []));
  const running = lines.filter((l) => RUNNING.test(l));

  if (closings.length !== 1 || running.length !== 1) return null;

  const [closing] = closings;
  const count = counted(CLOSING, lines[closing]);

  if (!Number.isSafeInteger(count) || count < 1) return null;

  const listed = lines.slice(closing + 1, closing + 1 + count).map(testOf);

  if (listed.length !== count || listed.some((t) => !t)) return null;

  let at = closing + 1 + count;
  const skipped = counted(SKIPPED, lines[at]);

  if (skipped !== null) at += 1;

  const passed = counted(PASSED, lines[at]);

  if (passed !== null) at += 1;
  if (!EXITED.test(lines[at] ?? "")) return null;
  if (counted(RUNNING, running[0])
    !== count + (skipped ?? 0) + (passed ?? 0)) return null;

  const texts = new Set(listed.map((t) => t.text));

  return listed.map((t) => ({
    project: t.project, spec: t.spec, title: t.title,
    challenge: onlyChallenge(lines, closing, t, texts),
  }));
};

// Whether a local log shows `test` passed in `project`:
// `✓ N [PROJECT] › SPEC:LINE:COL › TITLE`, then perhaps ` (DURATION)`.
const PASS = /^✓ +\d+ \[([^\]]+)\] › ([^\s:]+):\d+:\d+ › /;
const DURATION = /^ \(\d+(?:\.\d+)?(?:ms|s|m|h)\)$/;

export const passesInLog = (log) => {
  const passes = [];

  if (typeof log !== "string") return passes;
  for (const raw of log.split("\n")) {
    const line = bare(raw).trim();
    const m = PASS.exec(line);

    if (m) {
      passes.push({
        project: m[1], spec: m[2], rest: line.slice(m[0].length),
      });
    }
  }

  return passes;
};

export const passedIn = (passes, project, { spec, title }) => passes
  .some((p) => p.project === project && p.spec === spec
    && (p.rest === title || (p.rest.startsWith(title)
      && DURATION.test(p.rest.slice(title.length)))));

const id = (value) => (Number.isSafeInteger(value) && value > 0
  ? value : null);
const newest = (a, b) => (Date.parse(b.created_at) - Date.parse(a.created_at))
  || (b.id - a.id);

// The record at the commit under test. A commit without the file has no
// exemptions; any other failure to read it refuses.
const readRecord = async (show, sha) => {
  let raw;

  try {
    raw = await show(sha, EXEMPTIONS);
  } catch (error) {
    if (/does not exist in|exists on disk, but not in/
      .test(String(error?.message))) return { exemptions: [] };
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { invalid: true };
  }
};

// Whether a staging job failed in its Run step and nowhere else. In the
// recorded failed runs (44396830525 and 44379156341, and #502's
// 40608586178) every step before Run is `success`: each one Run depends
// on is skipped only when Run is too (a superseded or sweep-only run),
// so a skip there is refused. Run is the one `failure`. After it, the
// failure-only screenshots, the always-run Summary and Alert and the
// post steps are `success`, or `skipped` (setup-node's post step is, in
// all three). Every step must be completed.
export const failedOnlyInRun = (steps, run) => {
  if (!Array.isArray(steps)) return false;

  const at = steps.findIndex((s) => s?.name === run);

  if (at === -1 || steps.filter((s) => s?.name === run).length !== 1) {
    return false;
  }

  return steps.every((s, i) => s?.status === "completed" && (i === at
    ? s.conclusion === "failure"
    : s.conclusion === "success"
      || (i > at && s.conclusion === "skipped")));
};

// The job a run is judged by: exactly one job of the staging job's
// name, failed in its Run step alone, and every other job of the run
// completed with `success` or `skipped` (#656 review, round 2; each
// recorded run has the one job). -> the job, or null.
export const judgedJob = (jobs, { job, step }) => {
  if (!Array.isArray(jobs)) return null;

  const named = jobs.filter((j) => j?.name === job);

  if (named.length !== 1) return null;

  const [found] = named;

  if (!id(found.id) || !failedOnlyInRun(found.steps, step)) return null;

  return jobs.every((j) => j === found || (j?.status === "completed"
    && (j.conclusion === "success" || j.conclusion === "skipped")))
    ? found : null;
};

// The judged run: the newest failed push run of the staging suite on
// `sha` that judgedJob() can judge. -> { run, job } or null.
const judgedRun = async (api, { repo, staging, sha }) => {
  const { workflow_runs: runs } = await api(`repos/${repo}/actions/`
    + `workflows/${staging.workflow}/runs?branch=${staging.branch}`
    + `&head_sha=${sha}&per_page=100`);
  const failed = (runs ?? []).filter((r) => id(r.id) && r.head_sha === sha
    && r.head_branch === staging.branch && r.event === "push"
    && r.status === "completed" && r.conclusion === "failure")
    .sort(newest);

  for (const run of failed) {
    const answer = await api(`repos/${repo}/actions/runs/${run.id}/jobs`
      + "?per_page=100");
    // One page is read: a run with more jobs than it holds, or an answer
    // that does not say how many it has, is not judged.
    const job = Array.isArray(answer?.jobs)
      && answer.total_count === answer.jobs.length
      ? judgedJob(answer.jobs, staging) : null;

    if (job) return { run, job };
  }

  return null;
};

// For each test, the newest green e2e.yml run on `sha` whose green
// shards passed it in every project in `projects`. -> Map key -> run id.
const localPasses = async (api, { repo, sha }, tests) => {
  const { workflow_runs: runs } = await api(`repos/${repo}/actions/`
    + `workflows/${LOCAL_WORKFLOW}/runs?head_sha=${sha}&per_page=100`);
  const green = (runs ?? []).filter((r) => id(r.id) && r.head_sha === sha
    && r.status === "completed" && r.conclusion === "success").sort(newest);
  const found = new Map();

  for (const run of green) {
    if (found.size === tests.length) break;

    const { jobs } = await api(`repos/${repo}/actions/runs/${run.id}/jobs`
      + "?per_page=100");
    const shards = (jobs ?? []).filter((j) => id(j.id)
      && typeof j.name === "string" && /shard \d+$/.test(j.name)
      && j.conclusion === "success" && j.head_sha === sha);
    const passes = [];

    for (const job of shards) {
      passes.push(...passesInLog(await api(`repos/${repo}/actions/jobs/`
        + `${job.id}/logs`, { text: true })));
    }
    for (const t of tests) {
      if (!found.has(t.key)
        && [...t.projects].every((p) => passedIn(passes, p, t))) {
        found.set(t.key, run.id);
      }
    }
  }

  return found;
};

// The verdict on a commit with no green full run. `refusal` is the
// reason stagingSuite() gave, used when no failed run can be judged.
// Throws the first refusal; accepted, -> { lines, stagingRun,
// exemptions: [{ spec, title, localRun }] }.
export const stagingExemption = async ({
  api, show, repo, staging, sha, refusal,
}) => {
  const judged = await judgedRun(api, { repo, staging, sha });

  if (!judged) throw new Error(`Refused: ${refusal}.`);

  const { run, job } = judged;
  let log;

  try {
    log = await api(`repos/${repo}/actions/jobs/${job.id}/logs`,
      { text: true });
  } catch {
    log = null;
  }

  const failures = failedInLog(log);

  if (!failures) {
    throw new Error(`Refused: the failed tests of run ${run.id} cannot be `
      + "read from its log.");
  }

  const record = await readRecord(show, sha);

  if (record.invalid) {
    throw new Error(`Refused: ${EXEMPTIONS}: not valid JSON.`);
  }

  const [problem] = exemptionProblems(record);

  if (problem) throw new Error(`Refused: ${problem}.`);

  // Each failed test once, in closing-list order, with every project it
  // failed in and whether each failure was the challenge alone.
  const tests = [];
  const byKey = new Map();

  for (const f of failures) {
    const k = key(f.spec, f.title);
    let t = byKey.get(k);

    if (!t) {
      t = { key: k, spec: f.spec, title: f.title, projects: new Set(),
        challenge: true };
      byKey.set(k, t);
      tests.push(t);
    }
    t.projects.add(f.project);
    t.challenge &&= f.challenge;
  }

  const entries = new Set(record.exemptions.map((e) => key(e.spec, e.title)));
  const list = (ts) => ts.map(named).join("; ");
  const unnamed = tests.filter((t) => !entries.has(t.key));

  if (unnamed.length) {
    throw new Error("Refused: no exemption names these failed tests of run "
      + `${run.id}: ${list(unnamed)}.`);
  }

  const otherwise = tests.filter((t) => !t.challenge);

  if (otherwise.length) {
    throw new Error(`Refused: these tests of run ${run.id} failed with `
      + `something other than Netlify's bot challenge: ${list(otherwise)}.`);
  }

  const local = await localPasses(api, { repo, sha }, tests);
  const missing = tests.filter((t) => !local.has(t.key));

  if (missing.length) {
    throw new Error("Refused: these exempt tests have no pass in a green "
      + `e2e.yml run on ${sha}: ${list(missing)}.`);
  }

  return {
    lines: [
      ...tests.map((t) => `exemption used: ${named(t)}: Netlify's bot `
        + `challenge in staging run ${run.id}, passed in e2e.yml run `
        + `${local.get(t.key)}`),
      `full e2e failed on staging at ${sha} only on exempt tests: ${
        printable(run.html_url)}`,
    ],
    stagingRun: run.id,
    exemptions: tests.map((t) => ({
      spec: t.spec, title: t.title, localRun: local.get(t.key),
    })),
  };
};
