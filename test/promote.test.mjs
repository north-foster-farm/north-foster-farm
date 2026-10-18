/* eslint-disable camelcase -- GitHub names its fields its way */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REQUIRED_CHECKS, approval, auditCommit, missingChecks, promote,
} from "../bin/promote.mjs";

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const MADE = "2026-10-18T10:00:00Z";

const green = REQUIRED_CHECKS.map((name) => ({
  name, status: "completed", conclusion: "success",
}));

// A stand-in for git and the GitHub API. `heads` maps a branch to its
// commit; `descends` says whether `to` is behind `from`.
const world = ({
  heads = { next: SHA, staging: OLD, main: OLD },
  descends = true, runs = green, pulls = [], timeline = [],
} = {}) => {
  const calls = [];
  const sh = async (args) => {
    calls.push(args.join(" "));

    if (args[0] === "rev-parse") return heads[args[1].replace("origin/", "")];
    if (args[0] === "merge-base" && !descends) throw new Error("no");

    return "";
  };
  const api = async (path) => {
    if (path.includes("/check-runs")) return { check_runs: runs };
    if (path.includes("/pulls")) return pulls;
    if (path.includes("/timeline")) return timeline;

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
    calls, lines, deps: { sh, api, show, audit },
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
    const w = world({ runs: green.filter((r) => r.name !== "codeql") });

    await assert.rejects(promote("staging", { out: w.out }, w.deps),
      /no green codeql/);
    assert.deepEqual(pushes(w.calls), []);
  });

  it("does not count a check that failed or is still running", () => {
    assert.deepEqual(missingChecks([
      { name: "lint-and-test", status: "completed", conclusion: "failure" },
      { name: "supply-chain", status: "in_progress", conclusion: null },
      { name: "codeql", status: "completed", conclusion: "success" },
    ]), ["lint-and-test", "supply-chain"]);
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
  const pr = (head = SHA) => [{ number: 7, head: { sha: head } }];
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
  });

  it("refuses with no LGTM label, or one older than the commit",
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
        /older than this commit/);
      assert.deepEqual([...pushes(none.calls), ...pushes(stale.calls)], []);
    });

  it("approval() uses the latest label", () => {
    const timeline = [
      ...label("2026-10-18T09:00:00Z"), ...label("2026-10-18T12:00:00Z"),
    ];

    assert.equal(approval({
      pulls: pr(), sha: SHA, madeAt: MADE, timeline,
    }).ok, true);
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
