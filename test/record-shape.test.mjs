import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkRange, modeFor, resolveBase, SHAPE_PATHS, touchesShape,
} from "../bin/check-record-shape.mjs";

const commit = (files, message = "Change something\n\nBody.\n") =>
  ({ sha: "a".repeat(40), message, files });

describe("record shape: which files count", () => {
  it("matches a listed file and anything under a listed directory", () => {
    assert.deepEqual(touchesShape([
      "netlify/functions/lib/store.mjs",
      "netlify/migrations/2026-10-add-field.mjs",
      "netlify/functions/lib/mail.mjs",
      "layouts/index.html",
    ]), [
      "netlify/functions/lib/store.mjs",
      "netlify/migrations/2026-10-add-field.mjs",
    ]);
  });

  it("does not match a file that only shares a prefix", () => {
    assert.deepEqual(touchesShape(["netlify/functions/lib/store.mjs.bak",
      "netlify/migrationsX/a.mjs"]), []);
  });

  it("lists paths that exist", async () => {
    const { existsSync } = await import("node:fs");
    for (const path of SHAPE_PATHS.filter((p) => !p.endsWith("/"))) {
      assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), path);
    }
  });
});

describe("record shape: the range check", () => {
  it("passes a range that touches nothing", () => {
    const result = checkRange([commit(["layouts/index.html"])]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.touched, []);
  });

  it("passes an empty range", () => {
    assert.equal(checkRange([]).ok, true);
  });

  it("fails a touch with no trailer, and names the commit", () => {
    const result = checkRange([commit(["netlify/functions/lib/records.mjs"])]);
    assert.equal(result.ok, false);
    assert.equal(result.touched.length, 1);
    assert.deepEqual(result.touched[0].files,
      ["netlify/functions/lib/records.mjs"]);
  });

  it("passes when any commit in the range carries the trailer", () => {
    const result = checkRange([
      commit(["netlify/functions/lib/records.mjs"]),
      commit(["docs/x.md"],
        "Note the change\n\nRecord-shape: order gains a note field\n"),
    ]);
    assert.equal(result.ok, true);
  });

  it("accepts Record-shape: none", () => {
    const result = checkRange([commit(["netlify/functions/lib/store.mjs"],
      "Tidy store\n\nRecord-shape: none\n")]);
    assert.equal(result.ok, true);
  });

  it("rejects an empty trailer and a mention in prose", () => {
    for (const message of [
      "Fix\n\nRecord-shape:\n",
      "Fix\n\nRecord-shape:   \n",
      "Fix\n\nWe did not add a Record-shape: trailer here.\n",
    ]) {
      const result = checkRange([commit(["netlify/functions/lib/store.mjs"],
        message)]);
      assert.equal(result.ok, false, message);
    }
  });

  it("passes a trailer on a range that touches nothing", () => {
    const result = checkRange([commit(["docs/x.md"],
      "Doc\n\nRecord-shape: none\n")]);
    assert.equal(result.ok, true);
  });
});

describe("record shape: fail or warn", () => {
  it("fails a pull request, whatever its branch is called", () => {
    assert.equal(modeFor({ event: "pull_request", ref: "refs/pull/9/merge" }),
      "strict");
    assert.equal(modeFor({ event: "pull_request", ref: "refs/heads/next" }),
      "strict");
  });

  it("fails a push to main", () => {
    assert.equal(modeFor({ event: "push", ref: "refs/heads/main" }), "strict");
  });

  it("only warns on a push to next or staging", () => {
    for (const ref of ["refs/heads/next", "refs/heads/staging", "next"]) {
      assert.equal(modeFor({ event: "push", ref }), "warn", ref);
    }
  });

  it("warns on a dispatched run of next, fails one of main", () => {
    const event = "workflow_dispatch";

    assert.equal(modeFor({ event, ref: "refs/heads/next" }), "warn");
    assert.equal(modeFor({ event, ref: "refs/heads/main" }), "strict");
  });

  it("is strict for a run with no event or ref, or another branch", () => {
    assert.equal(modeFor(), "strict");
    assert.equal(modeFor({ event: "push", ref: "refs/heads/lane/x" }),
      "strict");
  });
});

describe("record shape: the command", () => {
  const script = fileURLToPath(
    new URL("../bin/check-record-shape.mjs", import.meta.url));

  // A scratch repository: a base commit, then one that touches the store.
  const repo = () => {
    const cwd = mkdtempSync(join(tmpdir(), "shape-"));
    const git = (...args) => execFileSync("git",
      ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args],
      { cwd, encoding: "utf8" }).trim();

    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "Base");
    const base = git("rev-parse", "HEAD");

    mkdirSync(join(cwd, "netlify/functions/lib"), { recursive: true });
    writeFileSync(join(cwd, "netlify/functions/lib/store.mjs"), "x\n");
    git("add", ".");
    git("commit", "-q", "-m", "Change the store");

    return { cwd, base, git };
  };
  const run = (cwd, ...args) => spawnSync(process.execPath,
    [script, ...args], { cwd, encoding: "utf8" });

  it("exits 1 for a strict run and 0 with a warning otherwise", () => {
    const { cwd, base } = repo();
    const strict = run(cwd, base, "--event", "push", "--ref",
      "refs/heads/main");
    const warn = run(cwd, base, "--event", "push", "--ref",
      "refs/heads/next");

    assert.equal(strict.status, 1);
    assert.match(strict.stderr, /no commit carries/);
    assert.equal(warn.status, 0);
    assert.match(warn.stdout, /::warning title=Record-shape::/);
    assert.match(warn.stdout, /warning only on this branch/);
  });

  it("passes a strict run once a commit carries the trailer", () => {
    const { cwd, base, git } = repo();

    git("commit", "-q", "--allow-empty", "-m",
      "Note it\n\nRecord-shape: none");

    const r = run(cwd, base, "--event", "pull_request", "--ref",
      "refs/pull/1/merge");

    assert.equal(r.status, 0);
    assert.match(r.stdout, /1 trailer/);
  });
});

describe("record shape: choosing the base", () => {
  const has = () => true;
  const lacks = () => false;

  it("uses the base it is given when git has it", () => {
    assert.equal(resolveBase("abc123", has), "abc123");
  });

  it("falls back to main for none, all zeros or an unknown commit", () => {
    assert.equal(resolveBase("", has), "origin/main");
    assert.equal(resolveBase(undefined, has), "origin/main");
    assert.equal(resolveBase("0".repeat(40), has), "origin/main");
    assert.equal(resolveBase("abc123", lacks), "origin/main");
  });
});
