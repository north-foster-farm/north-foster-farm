// The criteria tests for `bin/nff e2e` (#610), one per acceptance
// criterion and named for it, written from the criteria before the
// command existed. The implementer may change how a test runs, never
// what it expects (~/.claude/CLAUDE.md, "Tests and implementation come
// from different agents").
//
// Held out of `npm test` until the command exists: `npm test` runs
// test/**/*.test.mjs and this file is *.criteria.mjs. Run it on
// purpose with
//   node --import ./test/setup.mjs --test test/e2e-dispatch.criteria.mjs
// and turn it on by renaming it to test/e2e-dispatch.test.mjs.
//
// The contract these tests fix, and nothing beyond it:
//
// - The table is e2e/dispatch.json:
//     { "shared": [glob, ...],
//       "entries": [{ "paths": [glob, ...], "specs": [path, ...],
//                     "pages": [path, ...] }, ...] }
//   Globs are repository paths as node:path's matchesGlob reads them.
//   A changed path matching any `shared` glob selects everything; a
//   path matching no glob at all selects everything; otherwise a path
//   selects the specs and pages of every entry it matches. An entry may
//   name no specs: a path that needs no e2e (docs, unit tests). `pages`
//   is optional. "Everything" is every spec the table names, so on a
//   lane branch it is dispatched as named specs.
// - bin/e2e/dispatch.mjs exports
//     choose(paths, table) -> { all, specs, pages, reasons }
//   pure: changed paths and a table in, the choice out, no I/O; and
//     e2eCommand(args, { flags, out }, deps) -> Promise<exit code>
//   `args` are the words after `e2e`: one starting `e2e/` is a spec, one
//   starting `/` is a page. `flags` are bin/nff's (`all`, `dry-run`).
//   `out(line)` prints. It resolves to 0 when the run passed and to
//   another number when it failed.
// - deps, each replaceable here, with real defaults in the module:
//     changed(base)   the paths the branch changed against `base`
//     branch()        the branch to dispatch on
//     api(path, { method = "GET", body })
//                     GitHub's REST API: parsed JSON, or the text of a
//                     log; a dispatch is POST .../actions/workflows/
//                     e2e.yml/dispatches with return_run_details true,
//                     a run is GET .../actions/runs/<id>, its jobs
//                     .../runs/<id>/jobs, a job's log .../jobs/<id>/logs
//     wait(ms)        the pause between two looks at the run
//     table           the table, read from e2e/dispatch.json by default
//
// GitHub's answers are recorded (test/fixtures/github/e2e-dispatch.json
// says where from); the fake below only puts the run's id into them.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

import { choose, e2eCommand } from "../bin/e2e/dispatch.mjs";

const fixture = (name) => new URL(`fixtures/github/${name}`, import.meta.url);
const F = JSON.parse(readFileSync(fixture("e2e-dispatch.json"), "utf8"));
const LOGS = {
  [F.failedJobId]: readFileSync(fixture("e2e-dispatch-failed.txt"), "utf8"),
  [F.gateJobId]: readFileSync(fixture("e2e-dispatch-gate.txt"), "utf8"),
};

const REAL_TABLE = JSON.parse(readFileSync(
  new URL("../e2e/dispatch.json", import.meta.url), "utf8"));

// A small table of the real shape, so a test can say what it expects.
const TABLE = {
  shared: ["layouts/_default/**", "e2e/support/**"],
  entries: [
    {
      paths: ["layouts/account/**", "assets/scripts/account/**"],
      specs: ["e2e/account.spec.mjs", "e2e/membership.spec.mjs"],
      pages: ["/account/"],
    },
    {
      paths: ["content/about/**"],
      specs: ["e2e/about.spec.mjs"],
      pages: ["/about/"],
    },
    { paths: ["docs/**"], specs: [] },
  ],
};
const tableSpecs = (table) => new Set(table.entries.flatMap((e) => e.specs));

const BRANCH = "lane/e2e-dispatch-tests";
const ACCOUNT_CHANGE = "layouts/account/single.html";

// The GitHub API, answering with the recordings: the dispatch names
// the run, the run is queued at the first look and finished after,
// with the passed or the failed recording.
const world = ({
  outcome = "passed", changed = [ACCOUNT_CHANGE], table = TABLE,
} = {}) => {
  const run = outcome === "passed" ? F.runPassed : F.runFailed;
  const jobs = outcome === "passed" ? F.jobsPassed : F.jobsFailed;
  const named = { id: run.id, url: run.url, html_url: run.html_url };
  const calls = { api: [], changed: [], waits: 0, looks: 0 };
  const lines = [];

  const api = async (path, { method = "GET", body } = {}) => {
    calls.api.push({ path, method, body });

    if (method === "POST"
      && /\/actions\/workflows\/e2e\.yml\/dispatches$/.test(path)) {
      return { ...F.dispatch.response, workflow_run_id: run.id,
        run_url: run.url, html_url: run.html_url };
    }
    if (method !== "GET") throw new Error(`unrecorded ${method} ${path}`);
    if (new RegExp(`/actions/runs/${run.id}(\\?|$)`).test(path)) {
      calls.looks += 1;

      return calls.looks === 1 ? { ...F.runQueued, ...named } : run;
    }
    if (new RegExp(`/actions/runs/${run.id}/jobs(\\?|$)`).test(path)) {
      return jobs;
    }
    const log = path.match(/\/actions\/jobs\/(\d+)\/logs$/);
    if (log && LOGS[log[1]] && outcome === "failed") return LOGS[log[1]];

    throw new Error(`unrecorded GET ${path}`);
  };

  return {
    calls, lines, run,
    io: { flags: {}, out: (line) => lines.push(String(line)) },
    deps: {
      api, table,
      branch: async () => BRANCH,
      changed: async (base) => {
        calls.changed.push(base);

        return changed;
      },
      wait: async () => {
        calls.waits += 1;
      },
    },
    printed: () => lines.join("\n"),
    dispatches: () => calls.api.filter((c) => c.method === "POST"),
  };
};

const withFlags = (w, flags) => ({ ...w.io, flags });
const dispatchedSpecs = (call) => new Set(
  String(call.body.inputs.specs).split(/\s+/).filter(Boolean));

describe("bin/nff e2e (#610 acceptance criteria)", () => {
  it("1. with no arguments it compares the branch with next and prints "
    + "the specs and pages it chose and why", async () => {
    const w = world();

    await e2eCommand([], w.io, w.deps);

    assert.equal(w.calls.changed.length, 1);
    assert.match(String(w.calls.changed[0]), /^(origin\/)?next$/);
    const printed = w.printed();
    for (const chosen of
      ["e2e/account.spec.mjs", "e2e/membership.spec.mjs", "/account/"]) {
      assert.ok(printed.includes(chosen), `prints ${chosen}`);
    }
    assert.ok(printed.includes(ACCOUNT_CHANGE),
      "names the changed path that chose them");
    assert.ok(!printed.includes("e2e/about.spec.mjs"),
      "prints no spec it did not choose");
  });

  it("2. the choice comes from the table in the repository", async () => {
    const paths = [ACCOUNT_CHANGE];
    const other = {
      shared: TABLE.shared,
      entries: [
        { paths: ["layouts/account/**"], specs: ["e2e/about.spec.mjs"],
          pages: ["/about/"] },
        ...TABLE.entries.slice(1),
      ],
    };

    const first = choose(paths, TABLE);
    const second = choose(paths, other);

    assert.equal(first.all, false);
    assert.deepEqual(new Set(first.specs),
      new Set(["e2e/account.spec.mjs", "e2e/membership.spec.mjs"]));
    assert.deepEqual(new Set(first.pages), new Set(["/account/"]));
    assert.equal(second.all, false);
    assert.deepEqual(new Set(second.specs), new Set(["e2e/about.spec.mjs"]));
    assert.deepEqual(new Set(second.pages), new Set(["/about/"]));
    assert.deepEqual(choose(paths, TABLE), first, "the same in, the same out");

    // The command chooses from the table it is given, not its own.
    const w = world({ table: other });
    await e2eCommand([], withFlags(w, { "dry-run": true }), w.deps);
    assert.ok(w.printed().includes("e2e/about.spec.mjs"));
    assert.ok(!w.printed().includes("e2e/account.spec.mjs"));
  });

  it("3. an unknown path selects everything, and so does a shared "
    + "template, style, script, e2e helper or workflow file", () => {
    const every = tableSpecs(TABLE);
    for (const paths of [["brand/new-file.txt"],
      ["docs/notes.md", "brand/new-file.txt"],
      ["layouts/_default/baseof.html"], ["e2e/support/order.mjs"]]) {
      const choice = choose(paths, TABLE);
      assert.equal(choice.all, true, `${paths} selects everything`);
      assert.deepEqual(new Set(choice.specs), every);
    }
    assert.equal(choose(["docs/notes.md"], TABLE).all, false,
      "a known path does not");

    // The repository's own table knows what is shared.
    const realEvery = tableSpecs(REAL_TABLE);
    for (const path of [
      "brand/new-file.txt",
      "layouts/_default/baseof.html",
      "layouts/partials/head.html",
      "layouts/partials/header.html",
      "assets/styles/main.scss",
      "assets/scripts/main.js",
      "e2e/support/order.mjs",
      ".github/workflows/e2e.yml",
      ".github/workflows/e2e-run.yml",
    ]) {
      const choice = choose([path], REAL_TABLE);
      assert.equal(choice.all, true, `${path} selects everything`);
      assert.deepEqual(new Set(choice.specs), realEvery);
    }
  });

  it("4. it dispatches the E2E workflow with that choice, waits for the "
    + "run to finish, and exits 0 on success and non-zero on failure",
  async () => {
    const passed = world({ outcome: "passed" });
    const ok = await e2eCommand([], passed.io, passed.deps);

    const [dispatch, ...more] = passed.dispatches();
    assert.equal(more.length, 0, "one dispatch");
    assert.match(dispatch.path, /\/actions\/workflows\/e2e\.yml\/dispatches$/);
    assert.equal(dispatch.body.ref, BRANCH);
    assert.deepEqual(dispatchedSpecs(dispatch),
      new Set(["e2e/account.spec.mjs", "e2e/membership.spec.mjs"]));
    assert.ok(passed.calls.looks >= 2, "looked again after queued");
    assert.ok(passed.calls.waits >= 1, "waited between looks");
    assert.equal(ok, 0);

    const failed = world({ outcome: "failed" });
    const code = await e2eCommand([], failed.io, failed.deps);

    assert.equal(failed.dispatches().length, 1);
    assert.ok(failed.calls.looks >= 2, "looked again after queued");
    assert.equal(typeof code, "number");
    assert.notEqual(code, 0);
  });

  it("5. on failure it prints each failing test's file, name and page "
    + "and the run's URL, not the passing tests or the whole log",
  async () => {
    // The choice is about.spec.mjs, so the failing file can only come
    // from the run's report.
    const w = world({ outcome: "failed", changed: ["content/about/x.md"] });

    await e2eCommand([], w.io, w.deps);

    const printed = w.printed();
    assert.ok(printed.includes("e2e/membership.spec.mjs"), "the file");
    assert.ok(printed.includes(
      "sees the Membership QR code as coming soon"), "the test's name");
    assert.ok(printed.includes(F.runFailed.html_url), "the run's URL");
    for (const passing of [
      "the Membership tab's joined words keep their space",
      "a link by email signs in, once",
      "sees no Pickups for a group with no rounds",
      "every page fits before its images load",
    ]) {
      assert.ok(!printed.includes(passing), `not the passing "${passing}"`);
    }
    assert.ok(w.lines.length <= 40,
      `short: ${w.lines.length} lines, the log has `
      + `${LOGS[F.failedJobId].split("\n").length}`);
  });

  it("6. --all runs everything, and specs or pages named by hand are "
    + "used as given", async () => {
    const all = world({ changed: ["docs/notes.md"] });
    await e2eCommand([], withFlags(all, { all: true }), all.deps);
    assert.equal(all.dispatches().length, 1);
    assert.deepEqual(dispatchedSpecs(all.dispatches()[0]), tableSpecs(TABLE));

    const named = world();
    await e2eCommand(["e2e/about.spec.mjs"], named.io, named.deps);
    assert.equal(named.dispatches().length, 1);
    assert.deepEqual(dispatchedSpecs(named.dispatches()[0]),
      new Set(["e2e/about.spec.mjs"]), "only the spec named");

    const pages = world();
    await e2eCommand(["e2e/keyboard.spec.mjs", "/about/"],
      withFlags(pages, { "dry-run": true }), pages.deps);
    const printed = pages.printed();
    assert.ok(printed.includes("e2e/keyboard.spec.mjs"));
    assert.ok(printed.includes("/about/"));
    assert.ok(!printed.includes("e2e/account.spec.mjs"),
      "the table adds nothing to what was named");
    assert.ok(!printed.includes("/account/"));
  });

  it("7. --dry-run prints the choice and dispatches nothing", async () => {
    const w = world();

    await e2eCommand([], withFlags(w, { "dry-run": true }), w.deps);

    assert.equal(w.dispatches().length, 0);
    const printed = w.printed();
    assert.ok(printed.includes("e2e/account.spec.mjs"));
    assert.ok(printed.includes("e2e/membership.spec.mjs"));
  });

  it("8. every spec file in e2e/ appears in the table", () => {
    const files = readdirSync(new URL("../e2e/", import.meta.url),
      { recursive: true })
      .filter((f) => f.endsWith(".spec.mjs"))
      .map((f) => `e2e/${f}`);
    const named = tableSpecs(REAL_TABLE);
    const missing = files.filter((f) => !named.has(f));

    assert.ok(files.length > 0);
    assert.deepEqual(missing, [], `not in e2e/dispatch.json: ${missing}`);
  });
});
