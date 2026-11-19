/* eslint-disable camelcase -- GitHub names its fields its way */
// The criteria tests for `bin/nff e2e --help` (#630), one per box of
// the issue's "Done when" and named for it, written from the criteria
// before the fix. The implementer may change how a test runs, never
// what it expects (~/.claude/CLAUDE.md, "Tests and implementation come
// from different agents").
//
// Held out of `npm test` until the fix lands: `npm test` runs
// test/**/*.test.mjs and this file is *.criteria.mjs. Run it on
// purpose with
//   node --import ./test/setup.mjs --test test/e2e-help.criteria.mjs
// and turn it on by renaming it:
//   git mv test/e2e-help.criteria.mjs test/e2e-help.test.mjs
//
// The seam is the one test/e2e-dispatch.test.mjs uses:
//   e2eCommand(args, { flags, out }, deps) -> Promise<exit code>
// with `args` and `flags` as bin/nff's parser hands them over. It
// reads `--name` and `--name=value` into `flags` and leaves every
// other word in `args`, so `--help` arrives as `flags.help === true`
// and `-h` as the word "-h". "Dispatches nothing" is an assertion on
// `deps.api`: no POST reaches GitHub. GitHub's answers are the
// recordings in test/fixtures/github/e2e-dispatch.json, so a command
// that does dispatch runs to its end here and fails the assertion
// rather than throwing.
//
// The usage must name the command's own flags, read from
// bin/e2e/dispatch.mjs (e2eCommand reads `all`, `dry-run` and `base`):
// --all, --dry-run and --base. Its wording, layout and the rest of
// what it says are the implementer's.
//
// The issue's third box, "A test for each", is this file: test 1
// covers the first box and test 2 the second.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { e2eCommand } from "../bin/e2e/dispatch.mjs";

const fixture = (name) => new URL(`fixtures/github/${name}`, import.meta.url);
const F = JSON.parse(readFileSync(fixture("e2e-dispatch.json"), "utf8"));

// A table of the real shape, and a branch whose change it maps, so a
// command that took no arguments would have a spec to dispatch.
const TABLE = {
  shared: ["layouts/_default/**", "e2e/support/**"],
  entries: [{
    paths: ["layouts/account/**"],
    specs: ["e2e/account.spec.mjs"],
    pages: ["/account/"],
  }],
};
const BRANCH = "lane/e2e-help-tests";

// The flags the usage must name.
const FLAGS = ["--all", "--dry-run", "--base"];

// GitHub answering with the recordings: the dispatch names the run,
// the run has passed at the first look.
const world = () => {
  const run = F.runPassed;
  const calls = { api: [], changed: 0, branch: 0 };
  const lines = [];

  const api = async (path, { method = "GET", body } = {}) => {
    calls.api.push({ path, method, body });

    if (method === "POST"
      && /\/actions\/workflows\/e2e\.yml\/dispatches$/.test(path)) {
      return { ...F.dispatch.response, workflow_run_id: run.id,
        run_url: run.url, html_url: run.html_url };
    }
    if (method === "GET"
      && new RegExp(`/actions/runs/${run.id}(\\?|$)`).test(path)) {
      return run;
    }
    if (method === "GET"
      && new RegExp(`/actions/runs/${run.id}/jobs(\\?|$)`).test(path)) {
      return F.jobsPassed;
    }

    throw new Error(`unrecorded ${method} ${path}`);
  };

  return {
    calls,
    out: (line) => lines.push(String(line)),
    deps: {
      api, table: TABLE,
      branch: async () => {
        calls.branch += 1;

        return BRANCH;
      },
      changed: async () => {
        calls.changed += 1;

        return ["layouts/account/single.html"];
      },
      wait: async () => {},
    },
    printed: () => lines.join("\n"),
    dispatches: () => calls.api.filter((c) => c.method === "POST"),
  };
};

const run = async (args, flags) => {
  const w = world();
  const code = await e2eCommand(args, { flags, out: w.out }, w.deps);

  return { w, code };
};

const assertUsage = (printed, what) => {
  for (const flag of FLAGS) {
    assert.ok(printed.includes(flag), `${what} prints the usage: ${flag}`);
  }
};

describe("bin/nff e2e --help (#630 acceptance criteria)", () => {
  it("1. bin/nff e2e --help (and -h) prints the usage and dispatches "
    + "nothing", async () => {
    for (const [what, args, flags] of [
      ["--help", [], { help: true }],
      ["-h", ["-h"], {}],
    ]) {
      const { w } = await run(args, flags);

      assertUsage(w.printed(), what);
      assert.equal(w.dispatches().length, 0, `${what} dispatches nothing`);
    }
  });

  it("2. an unknown flag is refused with the usage, never treated as "
    + "\"no arguments\"", async () => {
    for (const [what, args, flags] of [
      ["--bogus", [], { bogus: true }],
      // A typo of a real flag is the likely case.
      ["--dryrun", [], { dryrun: true }],
      ["--bogus=1", [], { bogus: "1" }],
      ["--bogus beside a named spec", ["e2e/account.spec.mjs"],
        { bogus: true }],
    ]) {
      const { w, code } = await run(args, flags);

      assert.notEqual(code, 0, `${what} is refused`);
      assertUsage(w.printed(), what);
      assert.equal(w.dispatches().length, 0, `${what} dispatches nothing`);
      assert.equal(w.calls.changed, 0,
        `${what} is not read as no arguments: no branch comparison`);
    }
  });
});
