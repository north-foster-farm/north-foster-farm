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

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { collectFindings, npmAudit, summary } from "./audit/check.mjs";
import { evaluate, incompleteExceptions } from "./audit/findings.mjs";

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

export const USAGE = `
  bin/nff promote staging|main [--dry-run]
                                      fast-forward staging to next, or
                                      main to staging, and nothing else.
                                      Refuses a non-fast-forward, a
                                      commit whose checks are not all
                                      green and, for main, a commit with
                                      no approval on its pull request.
                                      For main, opens that pull request
                                      when none is open, and stops.
                                      Reports the dependency audit
                                      without blocking on it`
  .slice(1);

const git = async (args) => (await run("git", args)).stdout.trim();

// A GET, or with `fields` a POST of those string fields. With `all`, a
// GET of a list follows every page and returns one array.
const ghApi = async (path, { fields, all = false } = {}) => {
  const post = fields
    ? ["-X", "POST", ...Object.entries(fields)
      .flatMap(([key, value]) => ["-f", `${key}=${value}`])]
    : [];
  const pages = all ? ["--paginate", "--slurp"] : [];
  const { stdout } = await run("gh", ["api", ...pages, ...post, path],
    { maxBuffer: 64 * 1024 * 1024 });
  const data = JSON.parse(stdout);

  return all ? data.flat() : data;
};

// The pull request from staging into main, when none is open: the one
// release-audit runs on and James approves. It follows staging, so the
// body names no commit.
export const pullRequest = () => ({
  title: "Promote staging to main",
  head: FROM.main,
  base: "main",
  body: "Fast-forwards main to the head of staging. Opened by "
    + "`bin/nff promote main` so release-audit runs on it. Label it LGTM "
    + "to approve, then run `bin/nff promote main` again. It is never "
    + "merged here: main moves only by fast-forward.\n\n"
    + "Release checklist:\n\n"
    + "- [ ] Dates confirmed on every changed post and policy page",
});

// The open pull requests into main from this repository's own staging
// branch. One from a fork's branch of the same name never counts.
export const fromStaging = (pulls) => pulls.filter((p) =>
  p.head?.repo?.full_name === REPO && p.head?.ref === FROM.main);

// When the latest push that left staging at `sha` happened, from the
// repository's activity (newest first), or undefined.
export const pushedAt = (activity, sha) => activity
  .filter((a) => a.activity_type === "push" && a.after === sha)
  .map((a) => a.timestamp).sort().at(-1);

// The names of the checks that finished green on a commit.
export const passedChecks = (runs) => new Set(runs
  .filter((r) => r.status === "completed" && r.conclusion === "success")
  .map((r) => r.name));

export const missingChecks = (runs, target) => {
  const passed = passedChecks(runs);

  return REQUIRED_CHECKS[target].filter((name) => !passed.has(name));
};

// The pull request that proposes this commit for main, when one does and
// its approval stands: open, head exactly `sha`, the label put on after
// the push that brought `sha` to staging (`pushedAt`). `pulls` are the
// ones fromStaging() keeps. -> { ok, reason }.
export const approval = ({ pulls, sha, pushedAt: pushed, timeline }) => {
  const pr = pulls.find((p) => p.head?.sha === sha);

  if (!pr) return { ok: false, reason: "no open staging-to-main pull "
    + "request has this commit as its head" };
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
      + "staging was found, so the label cannot be dated against it" };
  }
  if (!(Date.parse(at) > Date.parse(pushed))) {
    return { ok: false, reason: `the ${APPROVAL_LABEL} label on PR `
      + `#${pr.number} is older than the push that brought this commit `
      + "to staging" };
  }

  return { ok: true, reason: `PR #${pr.number} approved` };
};

// The audit of one commit's own lockfile and workflows, against that
// commit's exceptions file. -> { failed, counts }.
export const auditCommit = async (sha, { show, audit = npmAudit }) => {
  const dir = mkdtempSync(join(tmpdir(), "promote-audit-"));

  for (const file of ["package.json", "package-lock.json"]) {
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

export const promote = async (target, { dryRun = false, out }, deps = {}) => {
  const {
    sh = git, api = ghApi, show = defaultShow, audit = npmAudit,
  } = deps;
  const from = FROM[target];

  if (!from) throw new Error("Promote staging or main.");

  await sh(["fetch", "origin"]);

  const sha = await sh(["rev-parse", `origin/${from}`]);
  const there = await sh(["rev-parse", `origin/${target}`]);

  if (sha === there) return out(`${target} is already at ${from} (${sha}).`);

  try {
    await sh(["merge-base", "--is-ancestor", `origin/${target}`,
      `origin/${from}`]);
  } catch {
    throw new Error(`Refused: ${from} is not a fast-forward of ${target}. `
      + "Nothing is pushed.");
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
    const pulls = fromStaging(await api(
      `repos/${REPO}/pulls?state=open&base=main&per_page=100`));

    if (!pulls.length) {
      if (dryRun) {
        throw new Error("Refused: no staging-to-main pull request is "
          + "open. Without --dry-run, this opens one and stops.");
      }

      const opened = await api(`repos/${REPO}/pulls`,
        { fields: pullRequest() });

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
      + `${FROM.main}&activity_type=push&per_page=100`);
    const verdict = approval({
      pulls, sha, pushedAt: pushedAt(activity, sha), timeline,
    });

    if (!verdict.ok) throw new Error(`Refused: ${verdict.reason}.`);
    refuseMissing(missing.filter((name) => PR_CHECKS.includes(name)));
    out(verdict.reason);
  }

  if (dryRun) return out(`Would fast-forward ${target} to ${sha}.`);

  await sh(["push", "origin", `${sha}:refs/heads/${target}`]);

  return out(`${target} is now at ${sha}.`);
};

export const promoteCommand = (action, rest, { flags, out }, deps) =>
  promote(action, { dryRun: Boolean(flags["dry-run"]), out }, deps);
