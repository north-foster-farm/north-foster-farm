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

describe("record shape: a malformed trailer", () => {
  const store = ["netlify/functions/lib/store.mjs"];

  it("fails the range, even one that touches nothing", () => {
    for (const message of [
      "Fix\n\nRecord shape: none\n",
      "Fix\n\nRecordShape: none\n",
      "Fix\n\nRecord_shape: order gains a note\n",
      "Fix\n\nRecord-shape:\n",
    ]) {
      const result = checkRange([commit(["docs/x.md"], message)]);

      assert.equal(result.ok, false, message);
      assert.equal(result.malformed.length, 1, message);
    }
  });

  it("fails even beside a well-formed trailer elsewhere", () => {
    const result = checkRange([
      commit(store, "Change\n\nRecord-shape: none\n"),
      commit(["docs/x.md"], "Doc\n\nRecord shape: none\n"),
    ]);

    assert.equal(result.ok, false);
  });

  it("accepts the key in any case, and prose that names it", () => {
    for (const message of [
      "Fix\n\nrecord-shape: none\n",
      "Fix\n\nWe add a Record-shape: line when the shape moves.\n",
    ]) {
      const result = checkRange([commit(store, message)]);

      assert.deepEqual(result.malformed, [], message);
    }
  });
});

describe("record shape: strict everywhere", () => {
  it("is strict unless asked only to warn", () => {
    assert.equal(modeFor(), "strict");
    assert.equal(modeFor({ warn: false }), "strict");
    assert.equal(modeFor({ warn: true }), "warn");
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

  it("exits 1 on every branch, and 0 only when told to warn", () => {
    const { cwd, base } = repo();
    const warn = run(cwd, base, "--warn");

    for (const ref of ["refs/heads/next", "refs/heads/staging",
      "refs/heads/main"]) {
      const strict = run(cwd, base, "--event", "push", "--ref", ref);

      assert.equal(strict.status, 1, ref);
      assert.match(strict.stderr, /no commit carries/, ref);
    }
    assert.equal(warn.status, 0);
    assert.match(warn.stdout, /::warning title=Record-shape::/);
    assert.match(warn.stdout, /warning only; passing/);
  });

  it("names a malformed trailer and exits 1", () => {
    const { cwd, base, git } = repo();

    git("commit", "-q", "--allow-empty", "-m", "Note\n\nRecord shape: none");
    const result = run(cwd, base);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /malformed trailer: "Record shape: none"/);
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

// The pre-push hook, run as git runs it: refs on stdin, one line each.
describe("record shape: the pre-push hook", () => {
  const hook = fileURLToPath(new URL("../.githooks/pre-push", import.meta.url));
  const zero = "0".repeat(40);

  // A clone whose origin/next is one commit, then a lane commit on top.
  const lane = (message) => {
    const cwd = mkdtempSync(join(tmpdir(), "prepush-"));
    const git = (...args) => execFileSync("git",
      ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args],
      { cwd, encoding: "utf8" }).trim();

    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "Base");
    git("update-ref", "refs/remotes/origin/next", "HEAD");
    const next = git("rev-parse", "HEAD");

    mkdirSync(join(cwd, "netlify/functions/lib"), { recursive: true });
    writeFileSync(join(cwd, "netlify/functions/lib/store.mjs"), "x\n");
    git("add", ".");
    git("commit", "-q", "-m", message);

    return { cwd, next, head: git("rev-parse", "HEAD") };
  };
  const push = (cwd, line) => spawnSync("sh", [hook, "origin", "url"],
    { cwd, input: `${line}\n`, encoding: "utf8" });

  it("refuses a new branch whose commit has no trailer", () => {
    const { cwd, head } = lane("Change the store");
    const result = push(cwd,
      `refs/heads/lane/x ${head} refs/heads/lane/x ${zero}`);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /no commit carries/);
    assert.match(result.stdout, /pre-push: refused/);
  });

  it("refuses a malformed trailer pushed onto next", () => {
    const { cwd, next, head } = lane("Change the store\n\nRecord shape: none");
    const result = push(cwd, `refs/heads/next ${head} refs/heads/next ${next}`);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /malformed trailer/);
  });

  it("lets a commit with its trailer through, and ignores a deletion", () => {
    const { cwd, head } = lane("Change the store\n\nRecord-shape: none");

    assert.equal(push(cwd,
      `refs/heads/lane/x ${head} refs/heads/lane/x ${zero}`).status, 0);
    assert.equal(push(cwd,
      `(delete) ${zero} refs/heads/lane/y ${head}`).status, 0);
  });
});
