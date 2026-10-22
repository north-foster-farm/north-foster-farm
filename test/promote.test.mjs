/* eslint-disable camelcase -- GitHub names its fields its way */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REQUIRED_CHECKS, approval, auditCommit, fromStaging, missingChecks,
  promote, pushedAt,
} from "../bin/promote.mjs";

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const MADE = "2026-10-18T10:00:00Z";
// When staging was pushed to SHA, after the commit was made.
const PUSHED = "2026-10-18T10:30:00Z";
const pushOf = (sha, at = PUSHED) => ({
  activity_type: "push", ref: "refs/heads/staging", after: sha,
  timestamp: at,
});

const green = [...new Set(Object.values(REQUIRED_CHECKS).flat())]
  .map((name) => ({ name, status: "completed", conclusion: "success" }));
const without = (...names) => green.filter((r) => !names.includes(r.name));

// A stand-in for git and the GitHub API. `heads` maps a branch to its
// commit; `descends` says whether `to` is behind `from`.
const world = ({
  heads = { next: SHA, staging: OLD, main: OLD },
  descends = true, runs = green, pulls = [], timeline = [],
  activity = [pushOf(SHA)],
} = {}) => {
  const calls = [];
  const sh = async (args) => {
    calls.push(args.join(" "));

    if (args[0] === "rev-parse") return heads[args[1].replace("origin/", "")];
    if (args[0] === "merge-base" && !descends) throw new Error("no");

    return "";
  };
  const posts = [];
  const api = async (path, { fields } = {}) => {
    if (fields) {
      posts.push({ path, fields });

      return { number: 9, html_url: "https://github.com/pr/9" };
    }
    if (path.includes("/check-runs")) return { check_runs: runs };
    if (path.includes("/pulls")) return pulls;
    if (path.includes("/timeline")) return timeline;
    if (path.includes("/activity?")) return activity;

    return { commit: { committer: { date: MADE } } };
  };
  const show = async (sha, path, list) => {
    if (list) return ".github/workflows/ci.yml";
    if (path === "security/exceptions.json") return "[]";
    if (path.endsWith("ci.yml")) return "jobs: {}";

    return "{}";
  };
  const audit = async () => ({ vulnerabilities: {} });
  const lines = [];

  return {
    calls, lines, posts, deps: { sh, api, show, audit },
    out: (line) => lines.push(line),
  };
};

const pushes = (calls) => calls.filter((c) => c.startsWith("push"));

describe("bin/nff promote", () => {
  it("fast-forwards staging to next's commit and pushes nothing else",
    async () => {
      const w = world();

      await promote("staging", { out: w.out }, w.deps);

      assert.deepEqual(pushes(w.calls),
        [`push origin ${SHA}:refs/heads/staging`]);
      assert.match(w.lines.at(-1), /staging is now at a{40}/);
      assert.ok(!w.calls.some((c) => /--force|-f\b/.test(c)));
    });

  it("does nothing when the branches already match", async () => {
    const w = world({ heads: { next: SHA, staging: SHA } });

    await promote("staging", { out: w.out }, w.deps);

    assert.deepEqual(pushes(w.calls), []);
    assert.match(w.lines[0], /already at next/);
  });

  it("refuses anything that is not a fast-forward", async () => {
    const w = world({ descends: false });

    await assert.rejects(promote("staging", { out: w.out }, w.deps),
      /not a fast-forward of staging/);
    assert.deepEqual(pushes(w.calls), []);
  });

  it("refuses a commit missing a required check, naming it", async () => {
    const w = world({ runs: without("codeql") });

    await assert.rejects(promote("staging", { out: w.out }, w.deps),
      /no green codeql/);
    assert.deepEqual(pushes(w.calls), []);
  });

  it("holds each branch to its own ruleset's checks", () => {
    assert.deepEqual(REQUIRED_CHECKS, {
      staging: [
        "lint-and-test", "supply-chain", "codeql", "build", "record-shape",
      ],
      main: [
        "lint-and-test", "supply-chain", "codeql", "build", "release-audit",
      ],
    });
  });

  it("refuses staging without build or record-shape", async () => {
    const w = world({ runs: without("build", "record-shape") });

    await assert.rejects(promote("staging", { out: w.out }, w.deps),
      /no green build, record-shape/);
    assert.deepEqual(pushes(w.calls), []);
  });

  it("does not ask staging for release-audit", async () => {
    const w = world({ runs: without("release-audit") });

    await promote("staging", { out: w.out }, w.deps);

    assert.equal(pushes(w.calls).length, 1);
  });

  it("does not count a check that failed or is still running", () => {
    assert.deepEqual(missingChecks([
      { name: "lint-and-test", status: "completed", conclusion: "failure" },
      { name: "supply-chain", status: "in_progress", conclusion: null },
      { name: "codeql", status: "completed", conclusion: "success" },
      { name: "build", status: "completed", conclusion: "success" },
      { name: "record-shape", status: "completed", conclusion: "success" },
    ], "staging"), ["lint-and-test", "supply-chain"]);
  });

  it("changes nothing on a dry run", async () => {
    const w = world();

    await promote("staging", { out: w.out, dryRun: true }, w.deps);

    assert.deepEqual(pushes(w.calls), []);
    assert.match(w.lines.at(-1), /Would fast-forward staging/);
  });

  it("knows only staging and main", async () => {
    const w = world();

    await assert.rejects(promote("next", { out: w.out }, w.deps),
      /staging or main/);
  });
});

describe("promoting main", () => {
  const heads = { next: SHA, staging: SHA, main: OLD };
  const pr = (head = SHA, ref = "staging",
    repo = "north-foster-farm/north-foster-farm", labels = ["LGTM"]) => [{
    number: 7, head: { sha: head, ref, repo: { full_name: repo } },
    labels: labels.map((name) => ({ name })),
  }];
  const label = (at, name = "LGTM") => [{
    event: "labeled", label: { name }, created_at: at,
  }];

  it("pushes only the commit of an approved pull request", async () => {
    const w = world({
      heads, pulls: pr(), timeline: label("2026-10-18T11:00:00Z"),
    });

    await promote("main", { out: w.out }, w.deps);

    assert.deepEqual(pushes(w.calls), [`push origin ${SHA}:refs/heads/main`]);
    assert.ok(w.lines.includes("PR #7 approved"));
  });

  it("refuses with no pull request for that commit", async () => {
    const w = world({ heads, pulls: pr("c".repeat(40)) });

    await assert.rejects(promote("main", { out: w.out }, w.deps),
      /no open staging-to-main pull request/);
    assert.deepEqual(pushes(w.calls), []);
    assert.deepEqual(w.posts, []);
  });

  it("opens the staging-to-main pull request when none is open, and stops",
    async () => {
      const w = world({ heads, pulls: pr(SHA, "hotfix") });

      await assert.rejects(promote("main", { out: w.out }, w.deps),
        /PR #9 is new.*release-audit.*LGTM/);
      assert.equal(w.posts.length, 1);
      assert.equal(w.posts[0].path,
        "repos/north-foster-farm/north-foster-farm/pulls");
      assert.deepEqual(
        [w.posts[0].fields.head, w.posts[0].fields.base], ["staging", "main"]);
      assert.match(w.posts[0].fields.body, /the head of staging/);
      assert.doesNotMatch(w.posts[0].fields.body, /a{40}/);
      assert.match(w.lines.at(-1), /Opened PR #9: https:/);
      assert.deepEqual(pushes(w.calls), []);
    });

  it("opens the pull request before release-audit has run on it",
    async () => {
      const w = world({ heads, runs: without("release-audit") });

      await assert.rejects(promote("main", { out: w.out }, w.deps),
        /PR #9 is new/);
      assert.equal(w.posts.length, 1);
    });

  it("refuses an approved commit with no green release-audit",
    async () => {
      const w = world({
        heads, pulls: pr(), timeline: label("2026-10-18T11:00:00Z"),
        runs: without("release-audit"),
      });

      await assert.rejects(promote("main", { out: w.out }, w.deps),
        /no green release-audit/);
      assert.deepEqual(pushes(w.calls), []);
    });

  it("does not ask main for record-shape", async () => {
    const w = world({
      heads, pulls: pr(), timeline: label("2026-10-18T11:00:00Z"),
      runs: without("record-shape"),
    });

    await promote("main", { out: w.out }, w.deps);

    assert.equal(pushes(w.calls).length, 1);
  });

  it("opens no pull request on a dry run", async () => {
    const w = world({ heads });

    await assert.rejects(
      promote("main", { out: w.out, dryRun: true }, w.deps),
      /no staging-to-main pull request is open/);
    assert.deepEqual(w.posts, []);
    assert.deepEqual(pushes(w.calls), []);
  });

  it("opens nothing for staging", async () => {
    const w = world();

    await promote("staging", { out: w.out }, w.deps);

    assert.deepEqual(w.posts, []);
  });

  it("refuses with no LGTM label, or one older than the push",
    async () => {
      const none = world({
        heads, pulls: pr(), timeline: label(MADE, "other"),
      });
      const stale = world({
        heads, pulls: pr(), timeline: label("2026-10-18T09:00:00Z"),
      });

      await assert.rejects(promote("main", { out: none.out }, none.deps),
        /no LGTM label/);
      await assert.rejects(promote("main", { out: stale.out }, stale.deps),
        /older than the push that brought this commit/);
      assert.deepEqual([...pushes(none.calls), ...pushes(stale.calls)], []);
    });

  it("approval() uses the latest label", () => {
    const timeline = [
      ...label("2026-10-18T09:00:00Z"), ...label("2026-10-18T12:00:00Z"),
    ];

    assert.equal(approval({
      pulls: pr(), sha: SHA, pushedAt: PUSHED, timeline,
    }).ok, true);
  });

  it("refuses a label put on after the commit was made but before "
    + "staging reached it", async () => {
    const w = world({
      heads, pulls: pr(), timeline: label("2026-10-18T10:15:00Z"),
      activity: [pushOf(SHA, "2026-10-18T10:20:00Z"), pushOf(OLD,
        "2026-10-18T10:05:00Z")],
    });

    await assert.rejects(promote("main", { out: w.out }, w.deps),
      /older than the push/);
    assert.deepEqual(pushes(w.calls), []);
  });

  it("refuses when no push to staging left it at the commit", async () => {
    const w = world({
      heads, pulls: pr(), timeline: label("2026-10-18T11:00:00Z"),
      activity: [pushOf(OLD)],
    });

    await assert.rejects(promote("main", { out: w.out }, w.deps),
      /no push that brought this commit to staging/);
    assert.deepEqual(pushes(w.calls), []);
  });

  it("refuses an LGTM that was taken off after it was put on",
    async () => {
      const w = world({
        heads,
        pulls: pr(SHA, "staging", "north-foster-farm/north-foster-farm", []),
        timeline: [...label("2026-10-18T11:00:00Z"), {
          event: "unlabeled", label: { name: "LGTM" },
          created_at: "2026-10-18T11:05:00Z",
        }],
      });

      await assert.rejects(promote("main", { out: w.out }, w.deps),
        /PR #7 has no LGTM label/);
      assert.deepEqual(pushes(w.calls), []);
    });

  it("dates the label against the latest push of the commit", () => {
    assert.equal(pushedAt([
      pushOf(SHA, "2026-10-18T10:00:00Z"), pushOf(OLD, "2026-10-18T10:10:00Z"),
      pushOf(SHA, "2026-10-18T10:20:00Z"),
      { ...pushOf(SHA, "2026-10-18T10:40:00Z"), activity_type: "force_push" },
    ], SHA), "2026-10-18T10:20:00Z");
  });

  it("ignores a pull request from a fork's staging branch", async () => {
    const fork = world({
      heads, pulls: pr(SHA, "staging", "someone/north-foster-farm"),
      timeline: label("2026-10-18T11:00:00Z"),
    });

    await assert.rejects(promote("main", { out: fork.out }, fork.deps),
      /PR #9 is new/);
    assert.equal(fork.posts.length, 1);
    assert.deepEqual(pushes(fork.calls), []);
    assert.deepEqual(fromStaging(pr(SHA, "staging", "someone/x")), []);
  });
});

describe("the audit at promotion", () => {
  it("fails on a finding the commit's own exceptions do not cover",
    async () => {
      const show = async (sha, path, list) => {
        if (list) return "";
        if (path === "security/exceptions.json") return "[]";

        return "{}";
      };
      const audit = async () => ({
        vulnerabilities: {
          pkg: {
            fixAvailable: true,
            via: [{
              source: 1, severity: "high",
              url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
            }],
          },
        },
      });
      const result = await auditCommit(SHA, { show, audit });

      assert.equal(result.failed, true);
      assert.match(result.counts[0], /unresolved: 1/);
    });
});
