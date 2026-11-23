// The implementer's own tests for bin/e2e/dispatch.mjs (#610): the
// parts the criteria tests (e2e-dispatch.test.mjs) do not reach.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  changedArgs, checkSpecs, dispatchInputs, e2eCommand, failureLine,
  failuresInLog, pageOf, printable,
} from "../bin/e2e/dispatch.mjs";

const fixture = (name) => readFileSync(
  new URL(`fixtures/github/${name}`, import.meta.url), "utf8");

const TABLE = {
  shared: ["layouts/_default/**"],
  entries: [
    { paths: ["layouts/account/**"], specs: ["e2e/account.spec.mjs"],
      pages: ["/account/"] },
    { paths: ["docs/**"], specs: [] },
  ],
};

// Only what a test needs; api refuses every call it is not meant to make.
const harness = ({
  changed = [], branch = "lane/x", table = TABLE,
} = {}) => {
  const lines = [];
  const calls = [];
  const diffs = [];

  return {
    lines,
    calls,
    diffs,
    io: { flags: {}, out: (l) => lines.push(String(l)) },
    deps: {
      table,
      changed: async () => {
        diffs.push(1);

        return changed;
      },
      branch: async () => branch,
      wait: async () => {},
      api: async (path, opts = {}) => {
        calls.push({ path, ...opts });
        throw new Error(`no call expected: ${path}`);
      },
    },
  };
};

describe("bin/e2e/dispatch.mjs helpers", () => {
  it("reads each failing test once from a recorded log, with every "
    + "project it failed on", () => {
    const found = failuresInLog(fixture("e2e-dispatch-failed.txt"));

    assert.deepEqual(found, [{
      file: "e2e/membership.spec.mjs",
      line: 365,
      title: "a member of one group who hosts another › sees the "
        + "Membership QR code as coming soon",
      projects: ["desktop", "phone"],
    }]);
    assert.deepEqual(failuresInLog(fixture("e2e-dispatch-gate.txt")), []);
  });

  it("names the site page a test's title carries", () => {
    assert.equal(pageOf("the keyboard walk (#591) › /order/ tabs cleanly"),
      "/order/");
    assert.equal(pageOf("at 375px (#185) › every page fits"), null);
    assert.match(failureLine({
      file: "e2e/keyboard.spec.mjs", line: 500, projects: ["iphone"],
      title: "the keyboard walk (#591) › /order/ tabs cleanly",
    }), /page \/order\/; iphone\)$/);
  });

  it("puts the specs into the dispatch's specs input", () => {
    const result = dispatchInputs({ specs: ["e2e/a.spec.mjs",
      "e2e/b.spec.mjs"], pages: ["/x/"] });

    assert.equal(result.specs, "e2e/a.spec.mjs e2e/b.spec.mjs");
  });

  it("never dispatches an empty specs input, which runs the full "
    + "suite", async () => {
    const h = harness({ changed: ["docs/notes.md"] });

    assert.equal(await e2eCommand([], h.io, h.deps), 0);
    assert.equal(h.calls.length, 0);

    const pages = harness();
    assert.notEqual(await e2eCommand(["/about/"], pages.io, pages.deps), 0);
    assert.equal(pages.calls.length, 0);
  });

  it("refuses next, staging and main, where e2e.yml refuses named "
    + "specs", async () => {
    for (const branch of ["next", "staging", "main"]) {
      const h = harness({ changed: ["layouts/account/x.html"], branch });

      assert.notEqual(await e2eCommand([], h.io, h.deps), 0);
      assert.equal(h.calls.length, 0);
    }
  });

  it("refuses a word that is neither a spec nor a page", async () => {
    const h = harness();

    assert.equal(await e2eCommand(["keyboard"], h.io, h.deps), 2);
    assert.equal(h.calls.length, 0);
  });

  it("says when nothing changed and dispatches nothing", async () => {
    const h = harness();

    assert.equal(await e2eCommand([], h.io, h.deps), 0);
    assert.match(h.lines.join("\n"), /Nothing changed/);
  });

  it("lists a moved file's old path as well as its new one", () => {
    const repo = mkdtempSync(join(tmpdir(), "e2e-dispatch-"));
    const git = (...args) => execFileSync("git", ["-C", repo, ...args],
      { encoding: "utf8" });

    try {
      git("init", "-q", "-b", "next");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      writeFileSync(join(repo, "money.html"), "a shared partial\n");
      git("add", ".");
      git("commit", "-qm", "base");
      git("switch", "-qc", "lane");
      git("mv", "money.html", "moved.html");
      git("commit", "-qm", "move");

      assert.deepEqual(git(...changedArgs("next")).trim().split("\n")
        .sort(), ["money.html", "moved.html"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a --base git could read as an option", async () => {
    for (const base of ["--output=/tmp/x", "-p"]) {
      const h = harness({ changed: ["layouts/account/x.html"] });

      h.io.flags.base = base;
      assert.equal(await e2eCommand([], h.io, h.deps), 2);
      assert.equal(h.diffs.length, 0, "git diff never runs");
      assert.equal(h.calls.length, 0);
    }
    assert.ok(changedArgs("x").includes("--end-of-options"));
  });

  it("drops blank specs and refuses one e2e.yml would refuse", async () => {
    assert.deepEqual(checkSpecs(["", "  ", "e2e/a.spec.mjs"]),
      { specs: ["e2e/a.spec.mjs"], bad: [] });
    assert.deepEqual(checkSpecs(["e2e/../a.spec.mjs", "e2e//a.spec.mjs",
      "e2e/a.spec.js", "e2e/a b.spec.mjs", "e2e/a.spec.mjs"]).bad,
    ["e2e/../a.spec.mjs", "e2e//a.spec.mjs", "e2e/a.spec.js",
      "e2e/a b.spec.mjs"]);

    const named = harness();

    assert.equal(await e2eCommand(["e2e/../x.spec.mjs"], named.io,
      named.deps), 2);
    assert.equal(named.calls.length, 0);

    // A table whose specs are all blank never sends an empty input.
    const blank = harness({
      changed: ["layouts/x/a.html"],
      table: { shared: [], entries: [{ paths: ["layouts/x/**"],
        specs: ["", " "] }] },
    });

    assert.equal(await e2eCommand([], blank.io, blank.deps), 0);
    assert.equal(blank.calls.length, 0);
    assert.match(blank.lines.join("\n"), /No spec to run/);
  });

  it("prints no control character from a log", () => {
    const esc = "\x1b";
    const log = [
      "2026-11-18T01:00:00.0000000Z   1 failed",
      `2026-11-18T01:00:00.0000000Z     [desk${esc}]0;title\x07top] › `
        + `e2e/a.spec.mjs:3:1 › ${esc}[31mbad\x07 \x9bname\x00\r`,
    ].join("\n");
    const [found] = failuresInLog(log);

    assert.deepEqual(found, { file: "e2e/a.spec.mjs", line: 3,
      title: "bad name", projects: ["desktop"] });
    // What must not print.
    // eslint-disable-next-line no-control-regex -- #791 c7105461370
    assert.doesNotMatch(failureLine(found), /[\x00-\x1f\x7f-\x9f]/);
    assert.equal(printable(`job\x1b[2J\x1b[H \x85x\ty`), "job x y");
  });
});
