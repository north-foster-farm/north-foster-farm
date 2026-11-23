// The implementer's own tests for the second review of #693's pull
// request (#696): the guards security and qa asked of the promote
// override and of filing flaky tests. Additions only, beside the
// criteria tests in promote-retry.test.mjs.
//
// THE FAKES. Recorded 2026-11-20 with gh, read-only:
// pr-last-edited.json (GraphQL's lastEditedAt of one pull request
// never edited and one edited) and, as the criteria tests use them,
// e2e-retry.json with its logs, e2e-flaky-issues.json,
// e2e-exempt.json and check-runs-green.json.
//
// COMPOSED, and only this, as in promote-retry.test.mjs: the scratch
// runs moved to commit 1471cc85 (atCommit), the flaky test's name
// given an at sign or a backtick, an open issue's title changed, and
// the pull request and its LGTM timeline, hand-shaped.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  fileFlaky, listUnchanged, namesTest, promote,
} from "../bin/promote.mjs";

const REPO = "north-foster-farm/north-foster-farm";
const DIR = new URL("fixtures/github/", import.meta.url);
const text = (name) => readFileSync(new URL(name, DIR), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
const EXEMPT = JSON.parse(text("e2e-exempt.json"));
const CHECKS = JSON.parse(text("check-runs-green.json")).response;
const ISSUES = JSON.parse(text("e2e-flaky-issues.json"));
const STAGING = JSON.parse(text("e2e-retry.json")).staging;
const EDITS = JSON.parse(text("pr-last-edited.json"));

const SHA = "1471cc858676dcc3bb4cad29ccc2c6ffca34f377";
const OLD = "b".repeat(40);
const FAILS = "e2e/zz-retry-fails.spec.mjs › fails on every try";
const LABELED = "2026-11-18T23:00:00Z";
const lgtm = (at = LABELED) => [{
  event: "labeled", label: { name: "LGTM" }, created_at: at,
}];

const atCommit = (run) => {
  const moved = clone(run);

  for (const r of [...moved.runs.workflow_runs, ...moved.jobs.jobs]) {
    r.head_sha = SHA;
    r.head_branch = "e2e/staging-full";
  }

  return moved;
};

// COMPOSED: the failed run's log with its flaky list taken out and its
// count of tests to match, so the exemption (#654) can read it, as a
// run with retries on and nothing flaky would leave it.
const noFlaky = (log) => {
  const lines = log.split("\n");
  const at = lines.findIndex((l) => / {2}2 flaky$/.test(l));

  lines.splice(at, 3);

  return lines.join("\n").replace("Running 4 tests", "Running 2 tests");
};

// Git, GitHub and the audit for one promotion of SHA to main on the
// recorded failed run, its log through `log`; `edits` answers GraphQL.
const world = ({
  body = "", edits = EDITS.unedited, log = (l) => l,
} = {}) => {
  const staging = atCommit(STAGING.failed);
  const [run] = staging.runs.workflow_runs;
  const calls = [];
  const lines = [];
  const sh = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "rev-parse") {
      return args[1] === "origin/main" ? OLD : SHA;
    }

    return "";
  };
  const api = async (path, { fields } = {}) => {
    if (fields) throw new Error(`no recording for a POST to ${path}`);
    if (path === "graphql") return clone(edits);
    if (path.includes("/actions/workflows/e2e-staging.yml/runs")) {
      return clone(staging.runs);
    }
    if (path.includes(`/actions/runs/${run.id}/jobs`)) {
      return clone(staging.jobs);
    }

    const logOf = path.match(/\/actions\/jobs\/(\d+)\/logs/);

    if (logOf && staging.logs[logOf[1]]) {
      return log(text(staging.logs[logOf[1]]));
    }
    if (path.includes("/check-runs")) return clone(CHECKS);
    if (path.includes("/activity?")) return clone(EXEMPT.activity);
    if (path.includes("/pulls")) {
      return [{
        number: 7, body,
        head: { sha: SHA, ref: "staging", repo: { full_name: REPO } },
        labels: [{ name: "LGTM" }],
      }];
    }
    if (path.includes("/timeline")) return lgtm();

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

  return {
    calls, lines, out: (l) => lines.push(String(l)),
    deps: { sh, api, show, audit: async () => ({ vulnerabilities: {} }) },
  };
};

const refusal = async (w) => {
  let message;

  await assert.rejects(promote("main", { out: w.out }, w.deps), (error) => {
    ({ message } = error);

    return /^Refused/.test(message);
  });
  assert.deepEqual(w.calls.filter((c) => c.startsWith("push")), [],
    "nothing is pushed");

  return message;
};

const listing = (items) => ["## Failing tests shipped past", "", ...items]
  .join("\n");

// A fake GitHub for fileFlaky alone: the recorded milestone and open
// issues, every POST kept.
const filing = (issues = ISSUES.issues) => {
  const posts = [];
  const lines = [];
  const api = async (path, { fields } = {}) => {
    if (fields) {
      posts.push({ path, fields });

      return /\/comments$/.test(path) ? clone(ISSUES.comment)
        : clone(ISSUES.issue);
    }
    if (path.includes("/milestones")) return clone(ISSUES.milestones);

    return clone(issues);
  };

  return { api, posts, lines, out: (l) => lines.push(String(l)) };
};
const flakyTest = (title) => ({
  spec: "e2e/zz-retry-flaky.spec.mjs", line: 3, title,
  projects: ["desktop"],
});
const RUN = STAGING.flaky.runs.workflow_runs[0];

describe("the promote override's guards (#696)", () => {
  it("files no flaky test whose name holds an at sign or a backtick",
    async () => {
      for (const title of ["pings @someone", "breaks `the span"]) {
        const f = filing();

        await fileFlaky(f.api, { flaky: [flakyTest(title)], run: RUN,
          sha: SHA, out: f.out });
        assert.deepEqual(f.posts, [], `nothing filed for ${title}`);
        assert.ok(f.lines.some((l) => l.includes(title)
          && l.includes("file this one by hand")), f.lines.join("\n"));
      }
    });

  it("adds a run only to the issue that names the whole test", async () => {
    const name = "e2e/zz-retry-flaky.spec.mjs › opens";
    const issues = clone(ISSUES.issues);

    issues[0].title = `Flaky e2e test: ${name} and closes`;

    const f = filing(issues);

    await fileFlaky(f.api, { flaky: [flakyTest("opens")], run: RUN,
      sha: SHA, out: f.out });
    assert.deepEqual(f.posts.map((p) => p.path), [`repos/${REPO}/issues`],
      "a new issue, not a comment on the longer name's");
    assert.ok(namesTest(`Flaky e2e test: ${name}`, name));
    assert.ok(namesTest(`Flaky: \`${name}\` again`, name));
    assert.ok(!namesTest(`Flaky e2e test: x${name}`, name));
  });

  it("dates the list against the newest LGTM label", async () => {
    const pr = { number: 7 };
    const answering = (answer) => async () => clone(answer);

    await listUnchanged(answering(EDITS.unedited), { pr,
      timeline: lgtm() });
    await listUnchanged(answering(EDITS.edited), { pr,
      timeline: lgtm("2026-11-19T18:30:00Z") });
    await assert.rejects(listUnchanged(answering(EDITS.edited), { pr,
      timeline: lgtm() }),
    /^Error: Refused: the list changed after LGTM; label it again\./);
    await assert.rejects(listUnchanged(answering({ data: null }), { pr,
      timeline: lgtm() }), /^Error: Refused: GitHub did not say/);
  });

  it("refuses an override listed in a body edited after LGTM", async () => {
    const w = world({ body: listing([`- \`${FAILS}\`: known`]),
      edits: EDITS.edited });

    assert.match(await refusal(w), /label it again/);
  });

  it("says how to list a failure when nothing is listed", async () => {
    // The exemption reads the log and refuses: its words stand, and
    // the lines to paste are printed beside them.
    const read = world({ log: noFlaky });
    const message = await refusal(read);
    const printed = read.lines.join("\n");

    assert.match(message, /^Refused: no exemption names/);
    assert.ok(message.includes(FAILS), message);
    assert.ok(printed.includes("## Failing tests shipped past"), printed);
    assert.ok(printed.includes(`- \`${FAILS}\`: REASON`), printed);

    // It cannot read a log with a flaky list: the refusal says it.
    const unread = await refusal(world());

    assert.ok(unread.includes("## Failing tests shipped past"), unread);
    assert.ok(unread.includes(`- \`${FAILS}\`: REASON`), unread);
  });

  it("gives the item format when a failure is not listed", async () => {
    const w = world({ body: listing(["- `e2e/other.spec.mjs › x`: no"]) });
    const message = await refusal(w);

    assert.ok(message.includes(`- \`${FAILS}\`: REASON`), message);
  });
});
