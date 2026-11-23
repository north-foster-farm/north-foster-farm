// `bin/nff promote staging|main`: move a branch forward to the commit
// the one before it already holds, and nothing else (#267, fast-forward
// only). next goes to staging, staging goes to main. A push of that
// commit is accepted by the branch rules because its required checks
// ran when it landed on next.
//
// It refuses anything that is not a fast-forward, a commit whose
// required checks are not all green, and, for main, any commit that has
// no approval on its staging-to-main pull request. It re-runs the
// dependency audit on that commit's own lockfile first: a check that
// passed earlier cannot see an advisory published since.
//
// The approval is the pull request's evidence: it is open, its head is
// exactly this commit, and the LGTM label was put on after the push
// that brought this commit to staging. Not after the commit was made:
// a commit made before a label but pushed after it was never seen by
// whoever labeled. GitHub holds one account here, which the agents
// share with James, so this shows the evidence is on the PR, not who
// put it there.
//
// When no staging-to-main pull request is open, it opens one and stops
// (#283): release-audit runs only on a pull request into main, and
// James's LGTM goes on it. Run it again once both are in.
//
// For main it also refuses a commit the full e2e suite has not passed
// on against staging (#502, 2026-10-28): the commit itself, or for a
// release branch its staging parent, must be the head of a successful
// E2E staging run on e2e/staging-full whose specs ran. A green run on
// an earlier commit does not count once a later fix lands. Without one,
// a failed run is accepted only through the recorded exemption in
// bin/staging-exempt.mjs (#654), which prints each exemption it used
// and, once main has moved, logs them as `promote.exemptions`.
//
// Retries are on (#693, 2026-11-20). A test that passed on a retry is
// flaky: its run is green and is accepted, and promote prints each
// flaky test by name and, once main has moved, files it in the "Next
// release" milestone (a new issue, or a comment on the open one whose
// title names it), since a flaky test never blocks a release. A
// failed run also ships when James lists every test that failed every
// try in it, with a reason, under "## Failing tests shipped past" on
// the release pull request: the deliberate override, which needs the
// LGTM label and green checks as ever, a label newer than the body's
// last edit, refuses any failure not listed, and once main has moved
// logs `promote.override`.
//
// A release branch (`promote main release/<name>`, James, 2026-10-26)
// takes main one step by a merge commit instead of moving it to a
// staging commit: its first parent is exactly main, its second parent
// is a commit already on staging, and its tree is that commit's tree,
// so the merge adds nothing staging did not already hold. It is still
// a fast-forward of main, and the commit itself, not staging's, must
// carry the green checks and the approval: the pull request is the one
// from the release branch, and the label is dated against the push of
// that branch. A release branch is rebuilt by force-push, which the
// activity records apart from a push, and its first push as a branch
// creation; both count here and only here.

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { collectFindings, npmAudit, summary } from "./audit/check.mjs";
import { evaluate, incompleteExceptions } from "./audit/findings.mjs";
import { printable } from "./e2e/printable.mjs";
import {
  SHIPPED_PAST, flakyInLog, named, retriedInLog, shippedPast,
  shippedPastItem,
} from "./e2e/retries.mjs";
import {
  EXEMPTIONS, exemptionProblems, judgedRun, stagingExemption,
} from "./staging-exempt.mjs";
import { log } from "../netlify/functions/lib/log.mjs";

export { EXEMPTIONS, exemptionProblems };

const run = promisify(execFile);

export const REPO = "north-foster-farm/north-foster-farm";
export const FROM = { staging: "next", main: "staging" };

// The checks a promoted commit must have passed, per branch, as the
// agreed rulesets require them (James, #283, 6332972143), so a refusal
// comes from here rather than from the push. `e2e` joins both when
// James lifts the pause. release-audit runs only on the pull request
// into main, so it is looked for once that pull request is open.
// `audit` is run and reported below but stops nothing (#283).
const BASE_CHECKS = ["lint-and-test", "supply-chain", "codeql", "build"];

export const PR_CHECKS = ["release-audit"];
export const REQUIRED_CHECKS = {
  staging: [...BASE_CHECKS, "record-shape"],
  main: [...BASE_CHECKS, ...PR_CHECKS],
};
export const AUDIT_BLOCKS = false;
export const APPROVAL_LABEL = "LGTM";

// The only branch names a release may come from, so the name that goes
// into API paths and refs is one this code chose the shape of.
export const RELEASE_BRANCH = /^release\/[a-z0-9][a-z0-9-]*$/;

// The activity types that mean "this branch was pushed to this commit".
// Staging is only ever fast-forwarded. A release branch is created,
// then rebuilt by force-push.
export const PUSH_TYPES = ["push"];
export const RELEASE_PUSH_TYPES = ["push", "force_push", "branch_creation"];

// The full e2e suite against staging, as .github/workflows/
// e2e-staging.yml runs it: a push to `branch` runs every spec in the
// `step` of its one `job`.
export const STAGING_E2E = {
  workflow: "e2e-staging.yml", branch: "e2e/staging-full",
  job: "e2e-staging", step: "Run",
};

/**
 * @public bin/nff imports it; Knip reads no file without an extension.
 */
export const USAGE = `
  bin/nff promote staging|main [release/<name>] [--dry-run]
                                      fast-forward staging to next, or
                                      main to staging, and nothing else.
                                      Refuses a non-fast-forward, a
                                      commit whose checks are not all
                                      green and, for main, a commit with
                                      no approval on its pull request.
                                      For main, opens that pull request
                                      when none is open, and stops.
                                      Reports the dependency audit
                                      without blocking on it. With a
                                      release branch, main takes its
                                      merge commit: first parent main,
                                      second parent on staging, staging's
                                      tree. Main also needs a passed full
                                      e2e run against staging on that
                                      staging commit (e2e/staging-full),
                                      or a failed one whose failures are
                                      all exempt (e2e/staging-exempt.json)
                                      or all listed with a reason under
                                      "## Failing tests shipped past" on
                                      the release pull request. Names
                                      each flaky test and files it in
                                      the "Next release" milestone`
  .slice(1);

const git = async (args) => (await run("git", args)).stdout.trim();

// A GET, or with `fields` a POST of those string fields. With `all`, a
// GET of a list follows every page and returns one array. With `text`,
// a GET of a job's log as text, never parsed: gh refuses a Playwright
// log's escape sequences unless told to pass them (#623), and what it
// passes is read only through printable(). With `query`, a read through
// GitHub's GraphQL (`path` is "graphql"), its variables in `vars`.
const ghApi = async (path, {
  fields, all = false, text = false, query, vars = {},
} = {}) => {
  if (text) {
    return (await run("gh", ["api", "--allow-escape-sequences", path],
      { maxBuffer: 64 * 1024 * 1024 })).stdout;
  }

  // A number goes as a typed field (-F), so GitHub gets an integer (a
  // milestone); text always as a raw string (-f), never read for @file.
  const typed = (values) => Object.entries(values)
    .flatMap(([key, value]) => [typeof value === "number" ? "-F" : "-f",
      `${key}=${value}`]);

  if (query !== undefined) {
    const { stdout } = await run("gh", ["api", path,
      ...typed({ query, ...vars })]);

    return JSON.parse(stdout);
  }

  const post = fields ? ["-X", "POST", ...typed(fields)] : [];
  const pages = all ? ["--paginate", "--slurp"] : [];
  const { stdout } = await run("gh", ["api", ...pages, ...post, path],
    { maxBuffer: 64 * 1024 * 1024 });
  const data = JSON.parse(stdout);

  return all ? data.flat() : data;
};

// The pull request from staging into main, when none is open: the one
// release-audit runs on and James approves. It follows staging, so the
// body names no commit.
export const pullRequest = (branch = FROM.main) => {
  const staging = branch === FROM.main;
  const lead = staging
    ? "Fast-forwards main to the head of staging."
    : `Moves main to the merge commit at the head of ${branch}.`;

  return {
    title: staging ? "Promote staging to main" : `Promote ${branch} to main`,
    head: branch,
    base: "main",
    body: `${lead} Opened by \`bin/nff promote main\` so release-audit `
      + "runs on it. Label it LGTM to approve, then run `bin/nff promote "
      + "main` again. It is never merged here: main moves only by "
      + "fast-forward.\n\n"
      + "Release checklist:\n\n"
      + "- [ ] Dates confirmed on every changed post and policy page",
  };
};

// The open pull requests into main from one of this repository's own
// branches, staging unless told otherwise. One from a fork's branch of
// the same name never counts.
export const fromBranch = (pulls, branch = FROM.main) => pulls.filter((p) =>
  p.head?.repo?.full_name === REPO && p.head?.ref === branch);

export const fromStaging = (pulls) => fromBranch(pulls, FROM.main);

// When the latest push that left a branch at `sha` happened, from the
// repository's activity (newest first), or undefined.
export const pushedAt = (activity, sha, types = PUSH_TYPES) => activity
  .filter((a) => types.includes(a.activity_type) && a.after === sha)
  .map((a) => a.timestamp).sort().at(-1);

// Whether `sha` is a release merge: two parents, the first exactly main,
// the second a commit staging holds, and no tree of its own. `facts`
// come from git: `parents` (the commit's, in order), `main`, `tree`
// (the commit's), `secondTree` and `onStaging` (the second parent is
// an ancestor of staging, or staging itself). -> { ok, reason }.
export const releaseShape = ({
  parents, main, tree, secondTree, onStaging,
}) => {
  if (parents.length !== 2) {
    return { ok: false, reason: "a release must be a merge commit with "
      + `two parents, and this one has ${parents.length}` };
  }
  if (parents[0] !== main) {
    return { ok: false, reason: "the first parent of a release must be "
      + `main (${main}), and it is ${parents[0]}` };
  }
  if (!onStaging) {
    return { ok: false, reason: `the second parent (${parents[1]}) is not `
      + "on staging" };
  }
  if (tree !== secondTree) {
    return { ok: false, reason: "the merge changes the tree of its "
      + "second parent, so it holds something staging does not" };
  }

  return { ok: true, reason: `release merge of ${parents[1]}` };
};

// The names of the checks that finished green on a commit.
export const passedChecks = (runs) => new Set(runs
  .filter((r) => r.status === "completed" && r.conclusion === "success")
  .map((r) => r.name));

export const missingChecks = (runs, target) => {
  const passed = passedChecks(runs);

  return REQUIRED_CHECKS[target].filter((name) => !passed.has(name));
};

// The finished green runs of the full staging suite whose head is
// exactly `sha`, newest first. `runs` are the workflow's runs.
export const fullRuns = (runs, sha) => runs
  .filter((r) => r.head_sha === sha && r.head_branch === STAGING_E2E.branch
    && r.event === "push" && r.status === "completed"
    && r.conclusion === "success")
  .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

// Whether a green run's specs ran and passed. A run that stood down
// because staging had moved on also ends green, with its specs skipped.
// `jobs` are the run's.
export const specsRan = (jobs) => jobs.some((j) => j.name === STAGING_E2E.job
  && j.conclusion === "success" && j.steps?.some((s) => s.name
    === STAGING_E2E.step && s.conclusion === "success"));

// The pull request that proposes this commit for main, when one does and
// its approval stands: open, head exactly `sha`, the label put on after
// the push that brought `sha` to staging (`pushedAt`). `pulls` are the
// ones fromStaging() keeps. -> { ok, reason }.
export const approval = ({
  pulls, sha, pushedAt: pushed, timeline, branch = FROM.main,
}) => {
  const pr = pulls.find((p) => p.head?.sha === sha);

  if (!pr) {
    const which = branch === FROM.main
      ? "staging-to-main pull request"
      : `pull request from ${branch} into main`;

    return { ok: false, reason: `no open ${which} has this commit as `
      + "its head" };
  }
  // The label must still be on: one taken off withdraws the approval.
  if (!pr.labels?.some((l) => l.name === APPROVAL_LABEL)) {
    return { ok: false, reason: `PR #${pr.number} has no `
      + `${APPROVAL_LABEL} label` };
  }

  const labeled = timeline.filter((e) => e.event === "labeled"
    && e.label?.name === APPROVAL_LABEL).map((e) => e.created_at).sort();
  const at = labeled.at(-1);

  if (!at) return { ok: false, reason: `PR #${pr.number} has no `
    + `${APPROVAL_LABEL} label` };
  if (!pushed) {
    return { ok: false, reason: "no push that brought this commit to "
      + `${branch} was found, so the label cannot be dated against it` };
  }
  if (!(Date.parse(at) > Date.parse(pushed))) {
    return { ok: false, reason: `the ${APPROVAL_LABEL} label on PR `
      + `#${pr.number} is older than the push that brought this commit `
      + `to ${branch}` };
  }

  return { ok: true, reason: `PR #${pr.number} approved` };
};

// The audit of one commit's own lockfile and workflows, against that
// commit's exceptions file. -> { failed, counts }. The commit's .nvmrc
// goes beside them so npm runs on the Node it pins: outside the repo
// mise would pick the global Node, and npm refuses package.json's
// devEngines on any other with EBADDEVENGINES (#504).
export const auditCommit = async (sha, { show, audit = npmAudit }) => {
  const dir = mkdtempSync(join(tmpdir(), "promote-audit-"));

  for (const file of [".nvmrc", "package.json", "package-lock.json"]) {
    writeFileSync(join(dir, file), await show(sha, file));
  }

  const names = (await show(sha, ".github/workflows", true)).split("\n")
    .filter((n) => /\.ya?ml$/.test(n));
  const workflows = await Promise.all(names.map((n) => show(sha, n)));
  const exceptions = JSON.parse(await show(sha, "security/exceptions.json"));
  const findings = await collectFindings({
    lockfiles: [join(dir, "package-lock.json")], workflows, audit,
    exceptions,
  });
  const result = evaluate(findings, exceptions);
  const bad = incompleteExceptions(exceptions);

  return {
    failed: Boolean(result.unresolved.length || result.reraised.length
      || bad.length),
    counts: summary(result, bad),
    result,
  };
};

// A file at a commit, or with `list` the names in a directory of it.
const defaultShow = async (sha, path, list = false) => (list
  ? git(["ls-tree", "--name-only", sha, `${path}/`])
  : (await run("git", ["show", `${sha}:${path}`],
    { maxBuffer: 64 * 1024 * 1024 })).stdout);

const isAncestor = async (sh, ancestor, descendant) => {
  try {
    await sh(["merge-base", "--is-ancestor", ancestor, descendant]);

    return true;
  } catch {
    return false;
  }
};

// What git says about a release merge, for releaseShape().
const releaseFacts = async (sh, sha, main) => {
  const parents = (await sh(["rev-list", "--parents", "-n", "1", sha]))
    .split(" ").slice(1);
  const second = parents[1];

  return {
    parents, main,
    tree: await sh(["rev-parse", `${sha}^{tree}`]),
    secondTree: second ? await sh(["rev-parse", `${second}^{tree}`]) : "",
    onStaging: second
      ? await isAncestor(sh, second, `origin/${FROM.main}`) : false,
  };
};

// Whether the full suite passed against staging on `sha`, from the
// workflow's runs on e2e/staging-full and, for each green one, its
// jobs. A reply without them counts as no run, so it refuses; a failed
// call throws. -> { ok, reason }.
export const stagingSuite = async (api, sha) => {
  const { workflow_runs: runs } = await api(`repos/${REPO}/actions/`
    + `workflows/${STAGING_E2E.workflow}/runs?branch=${STAGING_E2E.branch}`
    + `&head_sha=${sha}&status=success&per_page=100`);

  for (const r of fullRuns(runs ?? [], sha)) {
    const { jobs } = await api(`repos/${REPO}/actions/runs/${r.id}/jobs`
      + "?per_page=100");

    if (specsRan(jobs ?? [])) {
      return {
        ok: true, reason: `full e2e passed on staging at ${sha}: ${r.html_url}`,
        run: r, job: jobs.find((j) => j.name === STAGING_E2E.job),
      };
    }
  }

  return { ok: false, reason: "the full e2e suite has not passed against "
    + `staging on ${sha}. Push it to ${STAGING_E2E.branch} and promote `
    + "once that run is green" };
};

// The milestone a flaky test is filed in, to be fixed right after the
// release it did not block (James, 2026-11-20, #693).
export const FLAKY_MILESTONE = "Next release";

const jobLog = (api, job) => api(`repos/${REPO}/actions/jobs/${job}/logs`,
  { text: true });

const flakyLine = (t) => `flaky, passed on a retry: ${named(t)} (${
  t.projects.join(", ")})`;

// The flaky tests of a green full run, from its e2e-staging job's log.
// A log that cannot be read never refuses a green run, but says so.
const flakyOfGreen = async (api, job, out) => {
  let flaky = null;

  try {
    if (Number.isSafeInteger(job?.id)) flaky = flakyInLog(await jobLog(api,
      job.id));
  } catch {
    flaky = null;
  }
  if (!flaky) {
    out("Could not read the flaky tests from the run's log: look at its "
      + "closing lists before filing any by hand.");

    return [];
  }

  return flaky;
};

// The deliberate override (#693): a failed full run ships when every
// test that failed every try in it is listed, with a reason, under
// SHIPPED_PAST in the release pull request's body. `refusal` is the
// error the recorded exemption threw, thrown again when the run or its
// log cannot be judged. -> { run, failures, flaky } or throws.
// The judged staging run and what its log says of retried tests, or
// null when either cannot be had.
const retriedRun = async (api, sha) => {
  const judged = await judgedRun(api, {
    repo: REPO, staging: STAGING_E2E, sha,
  });

  if (!judged) return null;

  const read = await jobLog(api, judged.job.id).then(retriedInLog,
    () => null);

  return read ? { run: judged.run, ...read } : null;
};

// How to list `tests` on the pull request, ready to paste (#696, qa 1).
const pasteHint = (pr, tests) => [
  `To ship past ${tests.length === 1 ? "it" : "them"}, put this heading `
    + `and one line per test in PR #${pr.number}'s body, REASON saying `
    + `why, then label it ${APPROVAL_LABEL} again:`,
  "", SHIPPED_PAST, "", ...tests.map((t) => shippedPastItem(named(t))),
].join("\n");

// The list binds to James's approval only if the body holding it is
// as he saw it when he labeled: refused when GitHub says it was edited
// at or after the newest LGTM label, or cannot say (#696, security 3).
// REST's updated_at moves on labels and comments too, so GraphQL's
// lastEditedAt it is; null means never edited since it was opened.
const EDITED = "query($owner:String!,$name:String!,$number:Int!)"
  + "{repository(owner:$owner,name:$name){pullRequest(number:$number)"
  + "{number lastEditedAt}}}";

export const listUnchanged = async (api, { pr, timeline }) => {
  const [owner, name] = REPO.split("/");
  const labeled = timeline.filter((e) => e.event === "labeled"
    && e.label?.name === APPROVAL_LABEL).map((e) => e.created_at).sort()
    .at(-1);
  let edited;

  try {
    const got = (await api("graphql", { query: EDITED,
      vars: { owner, name, number: pr.number } }))?.data?.repository
      ?.pullRequest;

    if (typeof got !== "object" || got === null
      || !("lastEditedAt" in got)) {
      throw new Error("no answer");
    }
    edited = got.lastEditedAt;
  } catch {
    throw new Error(`Refused: GitHub did not say when PR #${pr.number}'s `
      + `body was last edited, so its "${SHIPPED_PAST}" list cannot be `
      + `dated against the ${APPROVAL_LABEL} label.`);
  }
  if (edited === null) return;
  if (typeof edited !== "string" || !labeled
    || !(Date.parse(labeled) > Date.parse(edited))) {
    throw new Error(`Refused: the list changed after ${APPROVAL_LABEL}; `
      + `label it again. PR #${pr.number}'s body was edited at ${
        printable(String(edited))}, and the newest ${APPROVAL_LABEL} label `
      + `is from ${printable(String(labeled))}.`);
  }
};

const shipPast = async (api, { pr, sha, listed, refusal }) => {
  const read = await retriedRun(api, sha);

  if (!read) throw refusal;

  const { run } = read;
  const unlisted = read.failed.filter((t) => !listed.has(named(t)));

  if (unlisted.length) {
    throw new Error(`Refused: these tests failed every try in staging run `
      + `${run.id} and are not listed with a reason under "${SHIPPED_PAST}" `
      + `on PR #${pr.number}: ${unlisted.map(named).join("; ")}.\n${
        pasteHint(pr, unlisted)}`);
  }

  return {
    run, flaky: read.flaky,
    failures: read.failed.map((t) => ({
      spec: t.spec, title: t.title, reason: listed.get(named(t)),
    })),
  };
};

const UNSAFE = /[@`]/;

// Whether an issue's title names the test `name` whole: at its end or
// in backticks, after its start, a space or a backtick, so one test's
// name is never taken for a longer one it begins (#696, qa).
export const namesTest = (title, name) => {
  const at = (from) => title.indexOf(name, from);

  for (let i = at(0); i !== -1; i = at(i + 1)) {
    const before = i === 0 ? " " : title[i - 1];
    const after = title[i + name.length] ?? "";

    if ((before === " " || before === "`")
      && (after === "" || after === "`")) return true;
  }

  return false;
};

// Each flaky test of an accepted run, filed in FLAKY_MILESTONE: a
// comment on the open issue there whose title names it, or a new issue.
// Main has moved by now, so a failure here is said, not thrown.
export const fileFlaky = async (api, { flaky, run, sha, out }) => {
  if (!flaky.length) return;

  const url = printable(run.html_url);

  try {
    const milestone = (await api(`repos/${REPO}/milestones?state=open`
      + "&per_page=100")).find((m) => m.title === FLAKY_MILESTONE
      && m.state === "open" && Number.isSafeInteger(m.number));

    if (!milestone) {
      out(`No open "${FLAKY_MILESTONE}" milestone, so the flaky tests above `
        + "are not filed: file each by hand.");

      return;
    }

    const open = (await api(`repos/${REPO}/issues?milestone=`
      + `${milestone.number}&state=open&per_page=100`, { all: true }))
      .filter((i) => !i.pull_request && typeof i.title === "string");

    for (const [i, t] of flaky.entries()) {
      const which = `flaky test ${i + 1} of ${flaky.length}`;

      // A test's name is log text, and this posts as the CLI's account:
      // an at sign could ping a login or start a Claude run, a backtick
      // breaks the code span (#696, security 1).
      if (UNSAFE.test(named(t))) {
        out(`Not filing ${which}, ${named(t)}: its name holds an at sign `
          + "or a backtick, so file this one by hand.");
        continue;
      }

      const known = open.find((issue) => namesTest(issue.title, named(t)));

      if (known) {
        const body = `Flaky again in the full staging run ${url} at ${sha}, `
          + "which `bin/nff promote main` shipped.";
        const comment = await api(`repos/${REPO}/issues/${known.number}`
          + "/comments", { fields: { body } });

        out(`Added the run to issue #${known.number} (${which}): ${
          printable(comment.html_url)}`);
      } else {
        const issue = await api(`repos/${REPO}/issues`, { fields: {
          title: `Flaky e2e test: ${named(t)}`,
          milestone: milestone.number,
          body: `\`${named(t)}\` failed and then passed on a retry `
            + `(${t.projects.join(", ")}) in the full staging run ${url} at `
            + `${sha}, which \`bin/nff promote main\` shipped. A flaky `
            + "test never blocks a release (#693): fix it right after this "
            + "one.",
        } });

        out(`Filed issue #${issue.number} (${which}): ${
          printable(issue.html_url)}`);
      }
    }
  } catch (error) {
    out(`Could not file the flaky tests on GitHub (${printable(
      String(error?.message).split("\n")[0])}): file each by hand.`);
  }
};

export const promote = async (
  target, { dryRun = false, out, release }, deps = {},
) => {
  const {
    sh = git, api = ghApi, show = defaultShow, audit = npmAudit,
  } = deps;

  if (!FROM[target]) throw new Error("Promote staging or main.");
  if (release !== undefined) {
    if (target !== "main") {
      throw new Error("Refused: only main takes a release branch.");
    }
    if (!RELEASE_BRANCH.test(release)) {
      throw new Error(`Refused: ${release} is not a release/<name> branch.`);
    }
  }

  const from = release ?? FROM[target];

  await sh(["fetch", "origin"]);

  const sha = await sh(["rev-parse", `origin/${from}`]);
  const there = await sh(["rev-parse", `origin/${target}`]);

  if (sha === there) return out(`${target} is already at ${from} (${sha}).`);

  // The staging commit the full suite must have passed on, and the
  // exemptions that stood in for a green run on it, when any did.
  let tested = sha;
  let exempted;
  // The run that was accepted and its flaky tests (#693), and the
  // override that accepted a failed one, when it did.
  let accepted;
  let overridden;

  if (release) {
    const facts = await releaseFacts(sh, sha, there);
    const shape = releaseShape(facts);

    if (!shape.ok) throw new Error(`Refused: ${shape.reason}. Nothing is `
      + "pushed.");
    out(shape.reason);
    [, tested] = facts.parents;
  } else if (!await isAncestor(sh, `origin/${target}`, `origin/${from}`)) {
    // A release merge puts a commit on main that staging never held, so
    // from then on staging is no fast-forward of main.
    const hint = target === "main" ? " If main holds a release merge, "
      + "release from a branch: `promote main release/<name>`." : "";

    throw new Error(`Refused: ${from} is not a fast-forward of ${target}.`
      + `${hint} Nothing is pushed.`);
  }

  const { check_runs: runs } = await api(
    `repos/${REPO}/commits/${sha}/check-runs?per_page=100`);
  const missing = missingChecks(runs, target);
  const refuseMissing = (names) => {
    if (names.length) {
      throw new Error(`Refused: ${sha} has no green ${names.join(", ")}.`);
    }
  };

  refuseMissing(missing.filter((name) => !PR_CHECKS.includes(name)));

  const audited = await auditCommit(sha, { show, audit });

  for (const line of audited.counts) out(`audit ${line}`);
  if (audited.failed && AUDIT_BLOCKS) {
    throw new Error("Refused: the dependency audit has unresolved "
      + "findings on this commit.");
  }

  if (target === "main") {
    const branch = release ?? FROM.main;
    const pulls = fromBranch(await api(
      `repos/${REPO}/pulls?state=open&base=main&per_page=100`), branch);

    if (!pulls.length) {
      if (dryRun) {
        throw new Error(`Refused: no ${release
          ? `pull request from ${release} into main`
          : "staging-to-main pull request"} is open. Without --dry-run, `
          + "this opens one and stops.");
      }

      const opened = await api(`repos/${REPO}/pulls`,
        { fields: pullRequest(branch) });

      out(`Opened PR #${opened.number}: ${opened.html_url}`);
      throw new Error(`Refused for now: PR #${opened.number} is new. `
        + "Promote again once release-audit is green on it and it has "
        + `the ${APPROVAL_LABEL} label.`);
    }

    const pr = pulls.find((p) => p.head?.sha === sha);
    const timeline = pr
      ? await api(`repos/${REPO}/issues/${pr.number}/timeline?per_page=100`,
        { all: true })
      : [];
    const activity = await api(`repos/${REPO}/activity?ref=refs/heads/`
      + `${branch}${release ? "" : "&activity_type=push"}&per_page=100`);
    const verdict = approval({
      pulls, sha, branch, timeline,
      pushedAt: pushedAt(activity, sha,
        release ? RELEASE_PUSH_TYPES : PUSH_TYPES),
    });

    if (!verdict.ok) throw new Error(`Refused: ${verdict.reason}.`);
    refuseMissing(missing.filter((name) => PR_CHECKS.includes(name)));
    out(verdict.reason);

    const suite = await stagingSuite(api, tested);

    if (suite.ok) {
      out(suite.reason);
      accepted = { run: suite.run,
        flaky: await flakyOfGreen(api, suite.job, out) };
    } else {
      // No green full run counts: the recorded exemption (#654) may
      // still accept a failed one, or the override listed on the
      // release pull request (#693). Each throws every refusal. The
      // exemption's own refusal stands unless the pull request lists
      // tests, or the exemption could not read a log with retries in it.
      try {
        exempted = await stagingExemption({
          api, show, repo: REPO, staging: STAGING_E2E, sha: tested,
          refusal: suite.reason,
        });
        for (const line of exempted.lines) out(line);
      } catch (error) {
        const listed = shippedPast(pr.body);

        if (!listed.size && !error.unread) {
          // With retries on, the exemption cannot accept a retried
          // failure, so say how the override would (#696, qa 1). The
          // refusal itself stays the exemption's, word for word.
          const read = await retriedRun(api, tested).catch(() => null);

          if (read?.failed.length) out(pasteHint(pr, read.failed));
          throw error;
        }
        if (listed.size) await listUnchanged(api, { pr, timeline });
        overridden = await shipPast(api, {
          pr, sha: tested, listed, refusal: error,
        });
        for (const f of overridden.failures) {
          out(`shipped past, as PR #${pr.number} lists it: ${named(f)}: ${
            printable(f.reason)}`);
        }
        out(`full e2e failed on staging at ${tested} only on tests PR `
          + `#${pr.number} lists: ${printable(overridden.run.html_url)}`);
        accepted = overridden;
      }
    }
    for (const t of accepted?.flaky ?? []) out(flakyLine(t));
  }

  if (dryRun) {
    if (accepted?.flaky.length) {
      out(`Would file ${accepted.flaky.length} flaky test(s) in `
        + `"${FLAKY_MILESTONE}".`);
    }

    return out(`Would fast-forward ${target} to ${sha}.`);
  }

  await sh(["push", "origin", `${sha}:refs/heads/${target}`]);

  // On record once main has moved, never for a refusal or a dry run.
  if (exempted) {
    log.info({
      event: "promote.exemptions", by: "cli", target, before: there,
      after: sha, stagingRun: exempted.stagingRun,
      exemptions: exempted.exemptions,
    });
  }
  if (overridden) {
    log.info({
      event: "promote.override", by: "cli", target, before: there,
      after: sha, stagingRun: overridden.run.id,
      failures: overridden.failures,
    });
  }
  if (accepted) {
    await fileFlaky(api, { flaky: accepted.flaky, run: accepted.run,
      sha: tested, out });
  }

  return out(`${target} is now at ${sha}.`);
};

// `promote main release/<name>`: the one word after the branch names
// the release branch. Anything more is refused, not ignored.
export const promoteCommand = (action, rest, { flags, out }, deps) => {
  if (rest.length > 1) {
    throw new Error("Refused: promote takes at most one release branch.");
  }

  return promote(action, {
    dryRun: Boolean(flags["dry-run"]), out, release: rest[0],
  }, deps);
};
