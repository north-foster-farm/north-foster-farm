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
                                      tree`
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

  if (release) {
    const shape = releaseShape(await releaseFacts(sh, sha, there));

    if (!shape.ok) throw new Error(`Refused: ${shape.reason}. Nothing is `
      + "pushed.");
    out(shape.reason);
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
  }

  if (dryRun) return out(`Would fast-forward ${target} to ${sha}.`);

  await sh(["push", "origin", `${sha}:refs/heads/${target}`]);

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
