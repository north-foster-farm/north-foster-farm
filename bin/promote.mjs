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
// exactly this commit, and the LGTM label was put on after that commit
// was made. GitHub holds one account here, which the agents share with
// James, so this shows the evidence is on the PR, not who put it there.

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

// The checks every promoted commit must have passed, as the branch
// rules require them. `audit` is run and reported below but does not
// stop a promotion; whether it should is James's call (#283).
export const REQUIRED_CHECKS = ["lint-and-test", "supply-chain", "codeql"];
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
                                      Reports the dependency audit
                                      without blocking on it`
  .slice(1);

const git = async (args) => (await run("git", args)).stdout.trim();

const ghApi = async (path) => JSON.parse(
  (await run("gh", ["api", path], { maxBuffer: 16 * 1024 * 1024 })).stdout,
);

// The names of the checks that finished green on a commit.
export const passedChecks = (runs) => new Set(runs
  .filter((r) => r.status === "completed" && r.conclusion === "success")
  .map((r) => r.name));

export const missingChecks = (runs) => {
  const passed = passedChecks(runs);

  return REQUIRED_CHECKS.filter((name) => !passed.has(name));
};

// The pull request that proposes this commit for main, when one does and
// its approval stands: open, head exactly `sha`, the label put on after
// the commit was made. -> { ok, reason }.
export const approval = ({ pulls, sha, madeAt, timeline }) => {
  const pr = pulls.find((p) => p.head?.sha === sha);

  if (!pr) return { ok: false, reason: "no open staging-to-main pull "
    + "request has this commit as its head" };

  const labeled = timeline.filter((e) => e.event === "labeled"
    && e.label?.name === APPROVAL_LABEL).map((e) => e.created_at).sort();
  const at = labeled[labeled.length - 1];

  if (!at) return { ok: false, reason: `PR #${pr.number} has no `
    + `${APPROVAL_LABEL} label` };
  if (Date.parse(at) < Date.parse(madeAt)) {
    return { ok: false, reason: `the ${APPROVAL_LABEL} label on PR `
      + `#${pr.number} is older than this commit` };
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
  const missing = missingChecks(runs);

  if (missing.length) {
    throw new Error(`Refused: ${sha} has no green ${missing.join(", ")}.`);
  }

  const audited = await auditCommit(sha, { show, audit });

  for (const line of audited.counts) out(`audit ${line}`);
  if (audited.failed && AUDIT_BLOCKS) {
    throw new Error("Refused: the dependency audit has unresolved "
      + "findings on this commit.");
  }

  if (target === "main") {
    const pulls = await api(
      `repos/${REPO}/pulls?state=open&base=main&per_page=100`);
    const commit = await api(`repos/${REPO}/commits/${sha}`);
    const pr = pulls.find((p) => p.head?.sha === sha);
    const timeline = pr
      ? await api(`repos/${REPO}/issues/${pr.number}/timeline?per_page=100`)
      : [];
    const verdict = approval({
      pulls, sha, madeAt: commit.commit.committer.date, timeline,
    });

    if (!verdict.ok) throw new Error(`Refused: ${verdict.reason}.`);
    out(verdict.reason);
  }

  if (dryRun) return out(`Would fast-forward ${target} to ${sha}.`);

  await sh(["push", "origin", `${sha}:refs/heads/${target}`]);

  return out(`${target} is now at ${sha}.`);
};

export const promoteCommand = (action, rest, { flags, out }, deps) =>
  promote(action, { dryRun: Boolean(flags["dry-run"]), out }, deps);
